import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type {
  Comment,
  Factory,
  InboxItem,
  Run,
  Task,
  TaskBrief,
  TaskGates,
  ThreadEvent,
} from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import {
  api,
  assistantTexts,
  commitToOrigin,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  tokenFor,
  waitUntil,
} from './helpers.ts'

let home: string
let cleanup: () => Promise<void>
let scratch: string
let origin: string
let daemon: RunningDaemon | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-gates-'))
  origin = await makeOriginRepo(scratch)
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

const brief = `## Goal

Let notes be edited offline.

## Decisions so far

- Keep both edits on a clash.

## Current state

Branch has the approach written up.

## Open questions

None.

## Next step

Build it.
`

async function start(
  workflow: string | null = 'version: 1\norder: [intake, design, work, merge]\n',
  stageFiles: Record<string, string> = {},
) {
  if (workflow !== null) {
    await commitToOrigin(scratch, { '.ted/workflow.yaml': workflow, ...stageFiles })
  }
  daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
  const client = api(daemon.port, { appKey: daemon.appToken })
  const fileToken = api(daemon.port, await tokenFor(home))
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  await ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const briefFile = path.join(scratch, 'brief.md')
  await writeFile(briefFile, brief)
  const findingsFile = path.join(scratch, 'findings.md')
  await writeFile(findingsFile, '- The sync test fails on a clash.\n')
  return { ...client, ok, fileToken, briefFile, findingsFile }
}

type Client = Awaited<ReturnType<typeof start>>

const steps = (...list: unknown[]) => JSON.stringify({ steps: list })

async function startTask(client: Client, ...list: unknown[]): Promise<Task> {
  const task = await client.ok<Task>('POST', '/tasks', { title: steps(...list), factory: 'NB' })
  await client.ok('POST', `/tasks/${task.id}/start`)
  return task
}

const getTask = async (client: Client, id: string) => {
  const task = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === id)
  if (!task) throw new Error(`no Task ${id}`)
  return task
}

const leadRun = async (client: Client, task: Task): Promise<Run> => {
  const { leadRunId } = await getTask(client, task.id)
  if (!leadRunId) throw new Error(`no Task Lead Run for ${task.displayId}`)
  return (await client.getRun(leadRunId)).run
}

const waitForIdle = async (client: Client, task: Task) => {
  const run = await leadRun(client, task)
  await waitUntil(async () => (await client.getRun(run.id)).run.state === 'idle', 'idle')
  return run
}

const commandResults = async (client: Client, task: Task) =>
  assistantTexts((await client.getRun((await leadRun(client, task)).id)).conversation).map(
    (text) => JSON.parse(text) as { code: number; stdout: string; stderr: string },
  )

const userMessages = async (client: Client, task: Task) =>
  (await client.getRun((await leadRun(client, task)).id)).conversation.flatMap((e) => {
    const line = JSON.parse(e.line) as { type: string; message?: { content?: unknown } }
    return line.type === 'user' && typeof line.message?.content === 'string'
      ? [line.message.content]
      : []
  })

const inbox = (client: Client) => client.ok<InboxItem[]>('GET', '/inbox')

const comments = (client: Client, task: Task) =>
  client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)

const waitForStage = (client: Client, task: Task, stage: string) =>
  waitUntil(async () => {
    const t = await getTask(client, task.id)
    return t.stage === stage ? t : undefined
  }, `${task.displayId} to reach ${stage}`)

const waitForRequest = (client: Client) =>
  waitUntil(async () => (await inbox(client)).at(0), 'a request in the Inbox')

describe('Sign-offs', () => {
  test('a Task with default settings stops at the end of Design with a design review in the Inbox; the token in daemon.json can’t answer it; Approve with the app’s token moves the Task on and tells the Task Lead', async () => {
    const client = await start()
    const advance = ['ted', 'outcome', 'advance']
    const task = await startTask(
      client,
      {
        everyMessage: [
          { run: ['ted', 'brief', 'write', '--file', client.briefFile] },
          { run: advance },
          { endTurn: true },
        ],
      },
      { run: advance },
      { endTurn: true },
    )

    const item = await waitForRequest(client)
    const { request } = item
    expect(item.task).toMatchObject({ id: task.id, stage: 'design' })
    expect(item.request).toMatchObject({
      kind: 'review',
      stage: 'design',
      title: 'Let notes be edited offline.',
      author: { kind: 'run' },
      gate: { approveLabel: 'Approve' },
    })
    expect(item.request.body).toContain('## Next step')
    expect((await getTask(client, task.id)).status).toEqual({ kind: 'waiting-on-you' })
    await waitForIdle(client, task)
    expect((await commandResults(client, task)).at(-1)).toMatchObject({
      code: 0,
      stdout: 'Waiting for the human at the Design sign-off. TED sends you their answer.\n',
    })
    expect((await getTask(client, task.id)).stage).toBe('design')

    for (const action of [{ action: 'approve' }, { action: 'request-changes', text: 'No.' }]) {
      const res = await client.fileToken.call('POST', `/comments/${request.id}/answer`, action)
      expect(res).toEqual({ status: 403, body: { error: 'only the TED app can do this' } })
    }
    expect((await inbox(client)).map((i) => i.request.id)).toEqual([request.id])

    const answered = await client.ok<Comment>('POST', `/comments/${request.id}/answer`, {
      action: 'approve',
      text: 'Use the existing sync queue.',
    })

    expect(answered.answer).toMatchObject({ kind: 'approved' })
    await waitForStage(client, task, 'work')
    expect(await inbox(client)).toEqual([])
    const work = await waitUntil(
      async () =>
        (await userMessages(client, task)).find((m) => m.startsWith('The human approved')),
      'the Work instructions to reach the Task Lead',
    )
    expect(work).toMatch(
      /^The human approved the Design sign-off and added:\n\nUse the existing sync queue\.\n\nTED moved this Task to Work\./,
    )
    expect(work).toContain('# Work')
  })

  test('with no .ted/, the Task stops at the Design sign-off and again at the Review sign-off', async () => {
    const client = await start(null)
    const task = await startTask(
      client,
      {
        everyMessage: [
          { run: ['ted', 'brief', 'write', '--file', client.briefFile] },
          { run: ['ted', 'outcome', 'advance'] },
          { endTurn: true },
        ],
      },
      { run: ['ted', 'outcome', 'advance'] },
      { endTurn: true },
    )

    const design = await waitForRequest(client)
    expect(design.task.stage).toBe('design')
    await client.ok('POST', `/comments/${design.request.id}/answer`, { action: 'approve' })
    const review = await waitUntil(async () => {
      const [item] = await inbox(client)
      return item?.task.stage === 'review' ? item : undefined
    }, 'the Review sign-off')
    expect(review.request).toMatchObject({
      kind: 'signoff',
      stage: 'review',
      gate: { approveLabel: 'Approve and merge' },
    })
    expect((await getTask(client, task.id)).stage).toBe('review')
  })

  test('--skip passes a sign-off only at Clarify or Design, before any Sign-off request, and says so in the thread', async () => {
    const client = await start(
      'version: 1\norder: [intake, design, work, review, merge]\nstages:\n  review: { gate: false }\n',
    )
    const skip = ['ted', 'outcome', 'advance', '--skip']
    const task = await startTask(
      client,
      { everyMessage: [{ endTurn: true }] },
      { run: skip },
      { run: ['ted', 'outcome', 'advance'] },
      { run: skip },
      { run: skip },
      { endTurn: true },
    )
    await waitUntil(async () => (await commandResults(client, task)).length === 4, 'four commands')

    expect(await commandResults(client, task)).toEqual([
      {
        code: 1,
        stdout: '',
        stderr: 'ted: only Clarify and Design can skip themselves; Intake can’t\n',
      },
      { code: 0, stdout: 'NB-1 moved to Design\n', stderr: '' },
      { code: 0, stdout: 'NB-1 moved to Work\n', stderr: '' },
      {
        code: 1,
        stdout: '',
        stderr: 'ted: only Clarify and Design can skip themselves; Work can’t\n',
      },
    ])
    expect(await inbox(client)).toEqual([])
    expect(await comments(client, task)).toMatchObject([
      {
        kind: 'note',
        author: { kind: 'ted' },
        stage: 'design',
        body: 'The Task Lead skipped Design: it had nothing to do. Its sign-off was skipped too.',
      },
    ])
  })

  test('at Design the Task Lead can’t pass the sign-off without writing the Task brief in that Stage, can’t go back without a Findings file or to a Stage that isn’t earlier, and can’t skip once the sign-off request is posted', async () => {
    const client = await start()
    const go = path.join(scratch, 'go')
    const back = ['ted', 'outcome', 'back', '--to']
    const task = await startTask(
      client,
      { everyMessage: [{ endTurn: true }] },
      { run: ['ted', 'brief', 'write', '--file', client.briefFile] },
      { run: ['ted', 'outcome', 'advance'] },
      { run: ['ted', 'outcome', 'advance'] },
      { waitFor: go },
      { run: [...back, 'intake'] },
      { run: [...back, 'work', '--findings', client.findingsFile] },
      { run: [...back, 'design', '--findings', client.findingsFile] },
      { run: ['ted', 'brief', 'write', '--file', client.briefFile] },
      { run: ['ted', 'outcome', 'advance'] },
      { run: ['ted', 'outcome', 'advance', '--skip'] },
      { endTurn: true },
    )

    await waitForStage(client, task, 'design')
    await waitUntil(async () => (await commandResults(client, task)).length === 3, 'three commands')
    expect((await commandResults(client, task)).at(-1)).toEqual({
      code: 1,
      stdout: '',
      stderr:
        'ted: write the Task brief with `ted brief write` before passing the Design sign-off\n',
    })
    expect(await inbox(client)).toEqual([])
    expect((await getTask(client, task.id)).stage).toBe('design')
    const res = await client.call('POST', `/tasks/${task.id}/outcome`, {
      outcome: 'back',
      to: 'intake',
      findings: ' ',
    })
    expect(res.status).toBe(400)

    await writeFile(go, '')
    await waitUntil(async () => (await commandResults(client, task)).length === 9, 'nine commands')

    const results = await commandResults(client, task)
    expect(results.slice(3, 6)).toEqual([
      { code: 2, stdout: '', stderr: 'ted: give the Findings file with --findings <file>\n' },
      {
        code: 1,
        stdout: '',
        stderr: 'ted: `back` goes only to an earlier Stage; Work isn’t before Design\n',
      },
      {
        code: 1,
        stdout: '',
        stderr: 'ted: `back` goes only to an earlier Stage; Design isn’t before Design\n',
      },
    ])
    expect(results.at(-1)).toEqual({
      code: 1,
      stdout: '',
      stderr: 'ted: Design has already posted its sign-off request, so it can’t skip itself\n',
    })
    expect((await getTask(client, task.id)).stage).toBe('design')
    expect(await inbox(client)).toHaveLength(1)
  })

  test('an approval while the Task Lead is paused reaches the resumed Run', async () => {
    const client = await start()
    const go = path.join(scratch, 'go')
    const task = await startTask(
      client,
      { run: ['ted', 'outcome', 'advance'] },
      { run: ['ted', 'brief', 'write', '--file', client.briefFile] },
      { run: ['ted', 'outcome', 'advance'] },
      { waitFor: go },
      { authError: true },
      { exit: 1 },
    )
    const { request } = await waitForRequest(client)
    const first = await leadRun(client, task)
    await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ signedIn: false }))
    await writeFile(go, '')
    await waitUntil(
      async () => (await getTask(client, task.id)).statuses.includes('paused'),
      'the Task Lead to be held',
    )

    await client.ok('POST', `/comments/${request.id}/answer`, { action: 'approve' })
    await waitForStage(client, task, 'work')
    await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ signedIn: true }))
    await client.ok('POST', '/agents/health/check')

    const resumed = await waitUntil(async () => {
      const run = await leadRun(client, task)
      return run.id !== first.id ? run : undefined
    }, 'the resumed Run')
    const prompt = (resumed as Run & { prompt?: string }).prompt ?? ''
    expect(prompt).toContain('the human answered')
    expect(prompt).toContain('approved')
    expect(prompt).toContain('TED moved this Task to Work.')
    expect(prompt).toContain('# Work')
    const answered = (await comments(client, task)).find((c) => c.id === request.id)
    expect(answered?.answer?.kind).toBe('approved')
  })

  test('a Task Lead that exits on a sign-in error after the human signs in again is held, not failed', async () => {
    const client = await start()
    const go = path.join(scratch, 'go')
    const exit = path.join(scratch, 'exit')
    const task = await startTask(
      client,
      { run: ['ted', 'outcome', 'advance'] },
      { run: ['ted', 'brief', 'write', '--file', client.briefFile] },
      { run: ['ted', 'outcome', 'advance'] },
      { waitFor: go },
      { authError: true },
      { waitFor: exit },
      { exit: 1 },
    )
    const { request } = await waitForRequest(client)
    const first = await leadRun(client, task)
    await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ signedIn: false }))
    await writeFile(go, '')
    await waitUntil(
      async () => (await getTask(client, task.id)).statuses.includes('paused'),
      'the Task Lead to be paused',
    )

    await client.ok('POST', `/comments/${request.id}/answer`, { action: 'approve' })
    await waitForStage(client, task, 'work')
    await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ signedIn: true }))
    await client.ok('POST', '/agents/health/check')
    await writeFile(exit, '')

    const resumed = await waitUntil(async () => {
      const run = await leadRun(client, task)
      return run.id !== first.id ? run : undefined
    }, 'the resumed Run')
    const prompt = (resumed as Run & { prompt?: string }).prompt ?? ''
    expect(prompt).toContain('the human answered')
    expect(prompt).toContain('TED moved this Task to Work.')
    expect(prompt).toContain('# Work')
    expect((await getTask(client, task.id)).statuses).not.toContain('failed')
  })

  test('Request changes sends the text into the live Task Lead Run and keeps the Stage', async () => {
    const client = await start()
    const task = await startTask(
      client,
      {
        everyMessage: [
          { run: ['ted', 'brief', 'write', '--file', client.briefFile] },
          { run: ['ted', 'outcome', 'advance'] },
          { endTurn: true },
        ],
      },
      { run: ['ted', 'outcome', 'advance'] },
      { endTurn: true },
    )
    const { request } = await waitForRequest(client)
    await waitForIdle(client, task)

    const answered = await client.ok<Comment>('POST', `/comments/${request.id}/answer`, {
      action: 'request-changes',
      text: `Split the sync step in two.\n${steps({ run: ['ted', 'outcome', 'advance'] }, { endTurn: true })}`,
    })

    expect(answered.answer).toMatchObject({ kind: 'changes-requested' })
    const message = await waitUntil(
      async () => (await userMessages(client, task)).find((m) => m.includes('Split the sync')),
      'the human’s text to reach the Task Lead',
    )
    expect(message).toMatch(
      /^The human asked for changes at the Design sign-off:\n\nSplit the sync/,
    )
    await waitUntil(async () => (await commandResults(client, task)).length === 4, 'four commands')
    expect((await commandResults(client, task)).at(-1)?.stderr).toBe(
      'ted: write the Task brief with `ted brief write` before passing the Design sign-off\n',
    )
    expect((await getTask(client, task.id)).stage).toBe('design')
    expect(await inbox(client)).toEqual([])
    const res = await client.call('POST', `/comments/${request.id}/answer`, { action: 'approve' })
    expect(res).toEqual({ status: 409, body: { error: 'this request has already been answered' } })
  })

  test('a sign-off request is withdrawn when the Task leaves the Stage before the human answers', async () => {
    const client = await start()
    const task = await startTask(
      client,
      {
        everyMessage: [
          { run: ['ted', 'brief', 'write', '--file', client.briefFile] },
          { run: ['ted', 'outcome', 'advance'] },
          {
            run: [
              'sh',
              '-c',
              `[ -e once ] || { touch once; ted outcome back --to intake --findings ${client.findingsFile}; }`,
            ],
          },
          { endTurn: true },
        ],
      },
      { run: ['ted', 'outcome', 'advance'] },
      { endTurn: true },
    )

    const withdrawn = await waitUntil(async () => {
      const found = (await comments(client, task)).find((c) => c.answer?.kind === 'withdrawn')
      return found
    }, 'the first request to be withdrawn')
    expect(withdrawn).toMatchObject({
      kind: 'review',
      answer: { kind: 'withdrawn', movedTo: 'intake' },
    })
    const open = await waitForRequest(client)
    expect(open.request.id).not.toBe(withdrawn.id)
    expect((await getTask(client, task.id)).stage).toBe('design')
  })
})

describe('outcomes', () => {
  test('the Task Lead’s send-backs over max_back turn into a question; answering resets the count', async () => {
    const client = await start(
      'version: 1\norder: [intake, design, work, merge]\nstages:\n  work: { max_back: 1 }\n  design: { gate: false }\n',
    )
    const back = ['ted', 'outcome', 'back', '--to', 'design', '--findings', client.findingsFile]
    const alternate = [
      'n=$(cat n 2>/dev/null || echo 0); n=$((n+1)); echo $n > n;',
      `if [ $((n % 2)) -eq 0 ]; then ${back.join(' ')}; else ted outcome advance; fi`,
    ].join(' ')
    const task = await startTask(
      client,
      { everyMessage: [{ run: ['sh', '-c', alternate] }, { endTurn: true }] },
      { run: ['ted', 'outcome', 'advance'] },
      { endTurn: true },
    )

    const { request } = await waitForRequest(client)
    expect(request).toMatchObject({
      kind: 'question',
      author: { kind: 'ted' },
      stage: 'work',
      title: 'Work wants to send this Task back to Design again',
      choices: ['Send it back to Design', 'Keep it in Work'],
    })
    expect(request.body).not.toContain('The sync test fails on a clash.')
    expect(request.body).toContain('history')
    const history = await client.ok<ThreadEvent[]>('GET', `/tasks/${task.id}/events`)
    expect(
      history.find((e) => e.text === 'Work wants to send this Task back to Design')?.findings,
    ).toContain('The sync test fails on a clash.')
    expect((await getTask(client, task.id)).stage).toBe('work')
    const backMessage = (await userMessages(client, task)).find((m) =>
      m.startsWith('TED moved this Task back to Design.'),
    )
    expect(backMessage).toContain('The sync test fails on a clash.')
    await waitForIdle(client, task)
    expect((await commandResults(client, task)).at(-1)?.stdout).toBe(
      'Work has sent this Task back 1 time, its limit, so TED asked the human instead. TED sends you their answer.\n',
    )

    await client.ok('POST', `/comments/${request.id}/answer`, {
      action: 'answer',
      choice: 'Send it back to Design',
      text: steps({ run: back }, { endTurn: true }),
    })

    const answer = await waitUntil(
      async () =>
        (await userMessages(client, task)).find((m) => m.startsWith('The user replied to')),
      'the answer to reach the Task Lead',
    )
    expect(answer).toContain('Send it back to Design')
    await waitUntil(
      async () => (await comments(client, task)).filter((c) => c.kind === 'question').length === 2,
      'a second question once the count runs out again',
    )
    const moved = (await commandResults(client, task)).filter((r) =>
      r.stdout.startsWith('NB-1 moved back to Design'),
    )
    expect(moved).toHaveLength(2)
  })
})

describe('the Task brief', () => {
  test('ted brief write stores a new version each time and needs the fixed headings; a Run reads only its own Task’s brief; a note has nothing to answer', async () => {
    const client = await start()
    const go = path.join(scratch, 'go')
    const task = await startTask(
      client,
      { run: ['ted', 'brief', 'write', '--file', client.briefFile] },
      { run: ['ted', 'brief', 'show'] },
      { waitFor: go },
      { run: ['ted', 'brief', 'write', '--file', client.briefFile] },
      { run: ['ted', 'brief', 'write', '--file', client.findingsFile] },
      { run: ['ted', 'comment', 'Just a note'] },
      { endTurn: true },
    )
    await waitUntil(async () => (await commandResults(client, task)).length === 2, 'two commands')
    expect((await commandResults(client, task)).at(-1)).toEqual({
      code: 0,
      stdout: brief,
      stderr: '',
    })
    const cwd = await mkdtemp(path.join(scratch, 'dev-run-'))

    const other = await client.startRun(
      [{ run: ['ted', 'brief', 'show', '--task', task.displayId] }, { endTurn: true }],
      cwd,
    )

    await waitUntil(async () => (await client.getRun(other.id)).run.state === 'idle', 'idle')
    const [result] = assistantTexts((await client.getRun(other.id)).conversation).map(
      (text) => JSON.parse(text) as { code: number; stderr: string },
    )
    expect(result).toMatchObject({
      code: 1,
      stderr: `ted: this Run doesn’t belong to ${task.displayId}\n`,
    })
    expect((await client.ok<TaskBrief>('GET', `/tasks/${task.id}/brief`)).version).toBe(1)

    await writeFile(go, '')
    await waitForIdle(client, task)

    const results = await commandResults(client, task)
    expect([results[0], results[2], results[3]].map((r) => r?.code)).toEqual([0, 0, 1])
    expect(results[2]?.stdout).toBe('Wrote version 2 of the Task brief\n')
    expect(results[3]?.stderr).toBe(
      'ted: the Task brief needs these headings, in order: Goal, Decisions so far, Current state, Open questions, Next step\n',
    )
    expect(await client.ok<TaskBrief>('GET', `/tasks/${task.id}/brief`)).toMatchObject({
      version: 2,
      stage: 'intake',
      text: brief,
    })

    const [note] = await comments(client, task)
    if (!note) throw new Error('no note')
    expect(note).toMatchObject({ kind: 'note', author: { kind: 'run' }, stage: 'intake' })

    const res = await client.call('POST', `/comments/${note.id}/answer`, { action: 'approve' })
    expect(res).toEqual({ status: 400, body: { error: 'a note has nothing to answer' } })
  })
})

test('Task Sign-off overrides keep Stage work, enforce new Sign-offs and cannot bypass posted requests', async () => {
  const client = await start()
  const go = path.join(scratch, 'start-with-gates')
  const task = await client.ok<Task>('POST', '/tasks', {
    factory: 'NB',
    title: steps(
      { everyMessage: [{ endTurn: true }] },
      { waitFor: go },
      {
        run: [
          'node',
          '-e',
          `fetch('http://127.0.0.1:${daemon?.port}/tasks/own-task/gates', {method:'PUT', headers:{authorization:'Bearer '+(process.env.TED_RUN_CAPABILITY || process.env.TED_RUN_TOKEN),'content-type':'application/json'},body:'{}'}).then(r=>console.log(r.status))`,
        ],
      },
      { run: ['ted', 'outcome', 'advance'] },
      { run: ['ted', 'brief', 'write', '--file', client.briefFile] },
      { run: ['ted', 'outcome', 'advance'] },
      { run: ['ted', 'brief', 'write', '--file', client.briefFile] },
      { run: ['ted', 'outcome', 'advance'] },
      { endTurn: true },
    ),
  })
  const route = `/tasks/${task.id}/gates`
  const initial = await client.ok<TaskGates>('GET', route)
  await client.ok('PUT', route, {
    overrides: { design: false, work: true },
    revision: initial.revision,
  })
  await client.ok('POST', `/tasks/${task.id}/start`)
  await writeFile(go, '')
  const item = await waitForRequest(client)
  expect(item.task.stage).toBe('work')
  expect(item.request.stage).toBe('work')
  const posted = await comments(client, task)
  expect(posted.some((comment) => comment.gate && comment.stage === 'design')).toBe(false)
  expect(posted.filter((comment) => comment.gate && comment.stage === 'work')).toHaveLength(1)
  const gates = await client.ok<TaskGates>('GET', route)
  expect(gates.rows.find((row) => row.stage === 'design')?.locked).toBe('Stage already passed')
  expect(gates.rows.find((row) => row.stage === 'work')?.locked).toContain(
    'Sign-off has been requested',
  )
  expect(
    (
      await client.call('PUT', route, {
        overrides: { design: false, work: false },
        revision: gates.revision,
      })
    ).status,
  ).toBe(409)
  expect(
    (await client.call('PUT', route, { overrides: { work: true }, revision: gates.revision }))
      .status,
  ).toBe(409)
  expect((await inbox(client)).some((entry) => entry.request.id === item.request.id)).toBe(true)
  await waitUntil(
    async () => (await commandResults(client, task)).length === 6,
    'Sign-off commands',
  )
  expect((await commandResults(client, task))[0]?.stdout.trim()).toBe('403')
})

describe('custom Stages', () => {
  const passStage = (briefFile: string) => ({
    run: [
      'sh',
      '-c',
      `ted outcome advance --skip 2>/dev/null || { ted brief write --file '${briefFile}' && ted outcome advance; }`,
    ],
  })

  test('a custom Stage’s file reaches the Task Lead; it sends back within its limit, holds at its Sign-off and walks to Done', async () => {
    const findings = path.join(scratch, 'findings.md')
    const client = await start(
      [
        'version: 1',
        'order: [intake, security, work, validate, release-notes, merge]',
        'stages:',
        '  release-notes: { name: Release notes, gate: true, max_back: 1 }',
        '',
      ].join('\n'),
      {
        '.ted/stages/security.md': '# Security\n\nLook for secrets in the change.\n',
        '.ted/stages/release-notes.md': `# Release notes\n\n${steps(
          { run: ['ted', 'outcome', 'back', '--to', 'work', '--findings', findings] },
          { endTurn: true },
        )}\n`,
      },
    )
    const pass = passStage(client.briefFile)
    const task = await startTask(client, { everyMessage: [pass, { endTurn: true }] }, pass, {
      endTurn: true,
    })

    const { request } = await waitForRequest(client)
    expect(request).toMatchObject({
      kind: 'question',
      stage: 'release-notes',
      title: 'Release notes wants to send this Task back to Work again',
      choices: ['Send it back to Work', 'Keep it in Release notes'],
    })
    await client.ok('POST', `/comments/${request.id}/answer`, {
      action: 'answer',
      choice: 'Keep it in Release notes',
      text: steps(pass, { endTurn: true }),
    })
    const signoff = await waitUntil(
      async () => (await comments(client, task)).find((c) => c.gate && !c.answer),
      'the Release notes Sign-off',
    )
    expect(signoff.stage).toBe('release-notes')
    expect((await getTask(client, task.id)).stage).toBe('release-notes')
    await client.ok('POST', `/comments/${signoff.id}/answer`, { action: 'approve' })
    await waitForStage(client, task, 'done')

    const entries = await client.ok<{ stage: string; stageFile?: unknown }[]>(
      'GET',
      `/tasks/${task.id}/stage-entries`,
    )
    expect(entries.map((e) => e.stage)).toEqual([
      'intake',
      'security',
      'work',
      'validate',
      'release-notes',
      'work',
      'validate',
      'release-notes',
      'merge',
      'done',
    ])
    expect(entries[1]?.stageFile).toEqual({ layer: 'factory', path: '.ted/stages/security.md' })
    const messages = await userMessages(client, task)
    expect(messages.find((m) => m.startsWith('TED moved this Task to Security.'))).toContain(
      'Look for secrets in the change.',
    )
    expect(messages.some((m) => m.startsWith('TED moved this Task to Release notes.'))).toBe(true)
    const history = await client.ok<ThreadEvent[]>('GET', `/tasks/${task.id}/events`)
    expect(history.some((e) => e.text.startsWith('Release notes sent this back to Work'))).toBe(
      true,
    )
  }, 120_000)

  test('a Task whose custom Stage leaves order finishes it and goes on to the next Stage that still exists; Autopilot skips a custom Sign-off', async () => {
    const go = path.join(scratch, 'go')
    const files = {
      '.ted/stages/security.md': `# Security\n\n${steps(
        { waitFor: go },
        { run: ['ted', 'outcome', 'advance'] },
        { endTurn: true },
      )}\n`,
      '.ted/stages/checklist.md': '# Checklist\n\nTick the boxes.\n',
    }
    const client = await start(
      [
        'version: 1',
        'order: [intake, security, work, checklist, merge]',
        'stages:',
        '  checklist: { name: Release checklist, gate: true }',
        '',
      ].join('\n'),
      files,
    )
    const pass = passStage(client.briefFile)
    const task = await client.ok<Task>('POST', '/tasks', {
      title: steps({ everyMessage: [pass, { endTurn: true }] }, pass, { endTurn: true }),
      factory: 'NB',
    })
    await client.ok('PUT', `/tasks/${task.id}/autopilot`, { choice: 'on' })
    await client.ok('POST', `/tasks/${task.id}/start`)
    await waitForStage(client, task, 'security')

    await commitToOrigin(scratch, {
      '.ted/workflow.yaml': [
        'version: 1',
        'order: [intake, work, checklist, merge]',
        'stages:',
        '  checklist: { name: Release checklist, gate: true }',
        '',
      ].join('\n'),
    })
    await writeFile(go, '')
    await waitForStage(client, task, 'merge')

    const entries = await client.ok<{ stage: string }[]>('GET', `/tasks/${task.id}/stage-entries`)
    expect(entries.map((e) => e.stage)).toEqual([
      'intake',
      'security',
      'work',
      'checklist',
      'merge',
    ])
    expect((await comments(client, task)).filter((c) => c.gate)).toEqual([])
    const history = await client.ok<ThreadEvent[]>('GET', `/tasks/${task.id}/events`)
    expect(history.map((e) => e.text)).toContain(
      'Autopilot is on, so TED skipped the Release checklist Sign-Off',
    )
  }, 120_000)
})
