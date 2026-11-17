import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Comment, Factory, InboxItem, Run, Task, TaskGates, ThreadEvent } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { holdAtMostMs } from '../src/tasks/held-requests.ts'
import {
  api,
  assistantTexts,
  commitToOrigin,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  waitUntil,
} from './helpers.ts'

let home: string
let cleanup: () => Promise<void>
let scratch: string
let origin: string
let daemon: RunningDaemon | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-clarify-'))
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

- Conflicts keep both copies and open a merge view.
- Warn after 30 days offline.

## Current state

Nothing built yet.

## Open questions

None.

## Next step

Design the merge view.
`

const storageRound = {
  title: 'Storage · 2 questions',
  summary: 'Each question has my recommended answer filled in. Change any you disagree with.',
  questions: [
    {
      question: 'When the same note is edited on two devices, what happens on reconnect?',
      choices: ['Keep both and let me merge', 'Keep the latest edit'],
      recommended: 'Keep both and let me merge',
    },
    {
      question: 'If a note is deleted on one device and edited on the other, which wins?',
      recommended: 'The edit wins.',
    },
  ],
}

const syncRound = {
  title: 'Sync · 1 question',
  questions: [
    {
      question: 'How long can a device stay offline before Notebook warns?',
      choices: ['7 days', '30 days', 'Never warn'],
      recommended: '7 days',
    },
  ],
}

async function start(clarifyGate = false, holdRequests = false) {
  await commitToOrigin(scratch, {
    '.ted/workflow.yaml': `version: 1\norder: [intake, clarify, work]\nstages:\n  clarify: { gate: ${clarifyGate} }\n`,
  })
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    ...(holdRequests && { heldRequests: { maxMs: holdAtMostMs } }),
  })
  const client = api(daemon.port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  await ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const file = async (name: string, content: string) => {
    const at = path.join(scratch, name)
    await writeFile(at, content)
    return at
  }
  return {
    ...client,
    ok,
    briefFile: await file('brief.md', brief),
    storageFile: await file('storage.json', JSON.stringify(storageRound)),
    syncFile: await file('sync.json', JSON.stringify(syncRound)),
    go: (name: string) => writeFile(path.join(scratch, name), ''),
    waitFile: (name: string) => path.join(scratch, name),
  }
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

// What Ted wrote to the Task Lead’s input. The stub shows a message it gets in the middle of a
// turn only while a tool hook runs, so whether it appears in the Conversation depends on timing.
const sentToLead = async (client: Client, task: Task) =>
  (await readFile(path.join(home, 'runs', (await leadRun(client, task)).id, 'input.jsonl'), 'utf8'))
    .split('\n')
    .flatMap((text) => {
      if (text === '') return []
      const line = JSON.parse(text) as { type?: string; message?: { content?: unknown } }
      return line.type === 'user' && typeof line.message?.content === 'string'
        ? [line.message.content]
        : []
    })

const comments = (client: Client, task: Task) =>
  client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)

const threadLines = async (client: Client, task: Task) =>
  (await client.ok<ThreadEvent[]>('GET', `/tasks/${task.id}/events`)).map((e) => e.text)

const waitForStage = (client: Client, task: Task, stage: string) =>
  waitUntil(async () => {
    const t = await getTask(client, task.id)
    return t.stage === stage ? t : undefined
  }, `${task.displayId} to reach ${stage}`)

const openRequest = (client: Client, kind: string, number = 0) =>
  waitUntil(async () => {
    const items = await client.ok<InboxItem[]>('GET', '/inbox')
    return items.find(
      (i) => i.request.kind === kind && (number === 0 || i.request.round?.number === number),
    )
  }, `a ${kind} in the Inbox`)

const ask = (file: string) => ({ run: ['ted', 'ask', '--round', file] })
const advance = { run: ['ted', 'outcome', 'advance'] }
const depth = (value: string, why: string) => ({ run: ['ted', 'clarify', 'depth', value, why] })

describe('Clarify rounds', () => {
  test('at Few, a round is one request with recommended answers; Submit answers sends them, and one round is all', async () => {
    const client = await start()
    const task = await startTask(
      client,
      advance,
      ask(client.storageFile),
      depth('few', 'two small questions settle it'),
      ask(client.storageFile),
      advance,
      { waitFor: client.waitFile('answered') },
      ask(client.syncFile),
      advance,
      { endTurn: true },
    )

    const item = await openRequest(client, 'round')
    expect(item.request).toMatchObject({
      kind: 'round',
      stage: 'clarify',
      title: 'Storage · 2 questions',
      body: storageRound.summary,
      author: { kind: 'run' },
      round: { number: 1, questions: storageRound.questions },
    })
    expect(await getTask(client, task.id)).toMatchObject({
      clarifyDepth: 'few',
      clarifyDepthBy: 'task-lead',
      status: { kind: 'waiting-on-you' },
    })
    expect(await threadLines(client, task)).toContain(
      'Task Lead picked Clarify depth: Few · two small questions settle it',
    )

    await waitUntil(
      async () => (await commandResults(client, task)).length >= 5,
      'the Task Lead to try to move on',
    )
    await client.ok('POST', `/comments/${item.request.id}/answer`, {
      action: 'answer-round',
      answers: [
        { answer: 'Ask me to resolve each conflict.', note: 'Clashes are rare for us.' },
        { answer: 'The edit wins.' },
      ],
    })
    const [answered] = (await comments(client, task)).filter((c) => c.kind === 'round')
    expect(answered?.answer).toMatchObject({
      kind: 'answered',
      answers: [
        {
          answer: 'Ask me to resolve each conflict.',
          note: 'Clashes are rare for us.',
          changed: true,
        },
        { answer: 'The edit wins.', changed: false },
      ],
    })
    await client.go('answered')
    await waitForStage(client, task, 'work')

    const results = await waitUntil(async () => {
      const found = await commandResults(client, task)
      return found.length >= 7 ? found : undefined
    }, 'every command to finish')
    expect(results[1]).toMatchObject({
      code: 1,
      stderr: expect.stringContaining('pick a Clarify depth first'),
    })
    expect(results[2]).toMatchObject({ code: 0 })
    expect(results[3]?.stdout).toMatch(/^Posted Round 1 \(request [0-9a-f-]+\)/)
    expect(results[4]).toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Round 1 is still waiting on the human'),
    })
    expect(results[5]).toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Clarify depth is Few, which asks one round'),
    })
    expect(results[6]).toMatchObject({ code: 0, stdout: 'NB-1 moved to Work\n' })

    const answer = await waitUntil(
      async () => (await userMessages(client, task)).find((m) => m.includes('answered Round 1')),
      'the answers to reach the Task Lead',
    )
    expect(answer).toContain(
      '1. When the same note is edited on two devices, what happens on reconnect?\n   Ask me to resolve each conflict. (changed from your recommendation “Keep both and let me merge”)\n   Note: Clashes are rare for us.',
    )
    expect(answer).toContain(
      '2. If a note is deleted on one device and edited on the other, which wins?\n   The edit wins. (recommended)',
    )
    expect(answer).toContain('run `ted outcome advance`')
  })

  test('Grilling sign-off stays pending after the Workflow turns it off; changes and approval still work', async () => {
    const client = await start(true)
    const task = await startTask(
      client,
      advance,
      depth('grilling', 'sync conflicts touch both repos'),
      ask(client.storageFile),
      { waitFor: client.waitFile('round1') },
      { run: ['ted', 'brief', 'write', '--file', client.briefFile] },
      advance,
      { waitFor: client.waitFile('setting-off') },
      advance,
      { waitFor: client.waitFile('changes') },
      ask(client.syncFile),
      { waitFor: client.waitFile('round2') },
      { run: ['ted', 'brief', 'write', '--file', client.briefFile] },
      advance,
      { endTurn: true },
    )

    const first = await openRequest(client, 'round', 1)
    await client.ok('POST', `/comments/${first.request.id}/answer`, {
      action: 'accept-recommended',
    })
    expect(
      (await comments(client, task)).find((c) => c.id === first.request.id)?.answer,
    ).toMatchObject({
      kind: 'answered',
      answers: [
        { answer: 'Keep both and let me merge', changed: false },
        { answer: 'The edit wins.', changed: false },
      ],
    })
    await client.go('round1')

    const signoff = await openRequest(client, 'signoff')
    expect(signoff.request).toMatchObject({
      stage: 'clarify',
      title: 'Let notes be edited offline.',
      gate: {
        approveLabel: 'Approve',
        caption: 'Approve moves the Task on. Request changes starts another round.',
      },
    })
    expect((await getTask(client, task.id)).stage).toBe('clarify')
    await commitToOrigin(scratch, {
      '.ted/workflow.yaml':
        'version: 1\norder: [intake, clarify, work]\nstages:\n  clarify: { gate: false }\n',
    })
    await client.go('setting-off')
    await waitUntil(async () => {
      const results = await commandResults(client, task)
      return results.some((r) => r.stderr.includes('already waiting at the Clarify sign-off'))
    }, 'the pending sign-off to block advancement with the Workflow setting off')
    const gates = await client.ok<TaskGates>('GET', `/tasks/${task.id}/gates`)
    expect(gates.rows.find((r) => r.stage === 'clarify')).toMatchObject({
      inherited: false,
      locked: 'Sign-off has been requested; answer it in the thread',
    })
    expect((await getTask(client, task.id)).stage).toBe('clarify')
    expect(
      (await comments(client, task)).find((c) => c.id === signoff.request.id)?.answer,
    ).toBeUndefined()
    await commitToOrigin(scratch, {
      '.ted/workflow.yaml':
        'version: 1\norder: [intake, clarify, work]\nstages:\n  clarify: { gate: true }\n',
    })
    await client.ok('POST', `/comments/${signoff.request.id}/answer`, {
      action: 'request-changes',
      text: 'Ask about how long devices stay offline.',
    })
    await client.go('changes')

    const second = await openRequest(client, 'round', 2)
    await client.ok('POST', `/comments/${second.request.id}/answer`, {
      action: 'answer-round',
      answers: [{ answer: '30 days' }],
    })
    await client.go('round2')
    const again = await waitUntil(async () => {
      const found = await openRequest(client, 'signoff')
      return found.request.id === signoff.request.id ? undefined : found
    }, 'the second sign-off')
    await client.ok('POST', `/comments/${again.request.id}/answer`, { action: 'approve' })
    await waitForStage(client, task, 'work')

    expect(await threadLines(client, task)).toContain(
      'Task Lead picked Clarify depth: Grill · sync conflicts touch both repos',
    )
    const changes = await waitUntil(
      async () =>
        (await userMessages(client, task)).find((m) =>
          m.includes('asked for changes at the Clarify sign-off'),
        ),
      'the changes to reach the Task Lead',
    )
    expect(changes).toContain('ted ask --round')
  })

  test('Grilling with sign-off off still waits for round answers, then advances without sign-off', async () => {
    const client = await start()
    const task = await startTask(
      client,
      advance,
      depth('grilling', 'conflict choices need discussion'),
      ask(client.storageFile),
      advance,
      { waitFor: client.waitFile('answered') },
      { tool: 'Read' },
      { run: ['ted', 'brief', 'write', '--file', client.briefFile] },
      { waitFor: client.waitFile('guidance-received') },
      advance,
      { endTurn: true },
    )
    const round = await openRequest(client, 'round')
    await waitUntil(async () => {
      const results = await commandResults(client, task)
      return results.some((r) => r.stderr.includes('still waiting on the human'))
    }, 'advancement to be refused while the round is open')
    expect((await getTask(client, task.id)).stage).toBe('clarify')
    await client.ok('POST', `/comments/${round.request.id}/answer`, {
      action: 'accept-recommended',
    })
    await client.go('answered')
    const answer = await waitUntil(
      async () =>
        (await sentToLead(client, task)).find((m) => m.includes('The human answered Round')),
      'the round-answer guidance to reach the Task Lead before leaving Clarify',
    )
    expect(answer).toContain(
      'Ted requests sign-off if the effective Clarify sign-off setting is on',
    )
    expect((await getTask(client, task.id)).stage).toBe('clarify')
    await client.go('guidance-received')
    await waitForStage(client, task, 'work')
    expect((await comments(client, task)).some((c) => c.kind === 'signoff')).toBe(false)
  })

  test('Autopilot suppresses the configured Grilling sign-off', async () => {
    const client = await start(true)
    const task = await startTask(
      client,
      { waitFor: client.waitFile('overnight') },
      advance,
      depth('grilling', 'sync conflicts touch both repos'),
      { run: ['ted', 'brief', 'write', '--file', client.briefFile] },
      advance,
      { endTurn: true },
    )
    await client.ok('PATCH', '/settings', { overnightMode: true })
    await client.go('overnight')

    await waitForStage(client, task, 'work')
    expect((await comments(client, task)).some((c) => c.kind === 'signoff')).toBe(false)
    expect(await threadLines(client, task)).toContain(
      'Autopilot is on, so Ted skipped the Clarify sign-off',
    )
  })

  test('the Task Lead can switch from Few to grilling, and says why', async () => {
    const client = await start()
    const task = await startTask(
      client,
      advance,
      depth('few', 'looks small'),
      depth('grilling', 'the answers touch the server too'),
      { endTurn: true },
    )
    await waitUntil(
      async () => (await getTask(client, task.id)).clarifyDepth === 'grilling',
      'grilling',
    )
    expect(await threadLines(client, task)).toEqual(
      expect.arrayContaining([
        'Task Lead picked Clarify depth: Few · looks small',
        'Task Lead switched Clarify depth to Grill · the answers touch the server too',
      ]),
    )
  })

  test('the human sets the depth; the field says so and the live Task Lead is told', async () => {
    const client = await start()
    const task = await startTask(client, advance, { endTurn: true })
    await waitForStage(client, task, 'clarify')

    const set = await client.ok<Task>('PUT', `/tasks/${task.id}/clarify-depth`, { depth: 'few' })
    expect(set).toMatchObject({ clarifyDepth: 'few', clarifyDepthBy: 'human' })
    expect(await threadLines(client, task)).toContain('You set Clarify depth to Few')
    await waitUntil(
      async () =>
        (await userMessages(client, task)).find((m) =>
          m.includes('The human set Clarify depth to Few'),
        ),
      'the depth to reach the Task Lead',
    )

    const bad = await client.call('PUT', `/tasks/${task.id}/clarify-depth`, { depth: 'deep' })
    expect(bad.status).toBe(400)
  })

  test('after the human sets the depth, the Task Lead can raise it but not go below it', async () => {
    const client = await start()
    const task = await startTask(
      client,
      advance,
      { waitFor: client.waitFile('human-set') },
      depth('none', 'nothing to ask'),
      depth('few', 'one round will do'),
      depth('grilling', 'it touches the server'),
      depth('few', 'back to one round'),
      depth('none', 'nothing left to ask'),
      { endTurn: true },
    )
    await waitForStage(client, task, 'clarify')
    await client.ok('PUT', `/tasks/${task.id}/clarify-depth`, { depth: 'few' })
    await client.go('human-set')
    await waitUntil(
      async () => (await commandResults(client, task)).length >= 6,
      'five depth picks',
    )
    const picks = (await commandResults(client, task)).slice(-5)
    expect(picks.map((r) => r.code === 0)).toEqual([false, true, true, true, false])
    expect(picks[0]?.stderr).toMatch(/the human set the Clarify depth/)
    expect(picks[4]?.stderr).toMatch(/the human set the Clarify depth/)
    expect(await getTask(client, task.id)).toMatchObject({ clarifyDepth: 'few' })
  })

  test('a depth the human picks when creating the Task is a floor too', async () => {
    const client = await start()
    const task = await client.ok<Task>('POST', '/tasks', {
      title: steps(advance, depth('few', 'looks small'), { endTurn: true }),
      factory: 'NB',
      clarifyDepth: 'grilling',
    })
    await client.ok('POST', `/tasks/${task.id}/start`)
    await waitUntil(async () => (await commandResults(client, task)).length >= 2, 'the depth pick')
    const [, pick] = await commandResults(client, task)
    expect(pick?.code).not.toBe(0)
    expect(pick?.stderr).toMatch(/the human set the Clarify depth to Grill/)
  })

  test('an open round is withdrawn when the Task goes back to Intake', async () => {
    const client = await start()
    const findings = path.join(scratch, 'findings.md')
    await writeFile(findings, '- The request names two different apps.\n')
    const task = await startTask(
      client,
      advance,
      depth('few', 'one question'),
      ask(client.storageFile),
      { run: ['ted', 'outcome', 'back', '--to', 'intake', '--findings', findings] },
      { endTurn: true },
    )
    const round = await waitUntil(
      async () => (await comments(client, task)).find((c) => c.kind === 'round' && c.answer),
      'the round to be withdrawn',
    )
    expect((await getTask(client, task.id)).stage).toBe('intake')
    expect(round.answer).toMatchObject({ kind: 'withdrawn', movedTo: 'intake' })
  })

  test('round answers given while no Run works reach the next Task Lead Run', async () => {
    const client = await start()
    const task = await startTask(
      client,
      advance,
      depth('few', 'two questions'),
      ask(client.storageFile),
      { endTurn: true },
    )
    const item = await openRequest(client, 'round')
    const first = (await getTask(client, task.id)).leadRunId
    await client.ok('POST', `/tasks/${task.id}/stop`)
    await client.ok('POST', `/comments/${item.request.id}/answer`, {
      action: 'answer-round',
      answers: [{ answer: 'Keep the latest edit', note: 'Rare.' }, { answer: 'The edit wins.' }],
    })
    await client.ok('POST', `/tasks/${task.id}/resume`, {})
    await waitUntil(async () => {
      const t = await getTask(client, task.id)
      return t.leadRunId !== undefined && t.leadRunId !== first
    }, 'a fresh Run')
    const prompt = await waitUntil(
      async () => (await userMessages(client, task))[0],
      'the fresh Run’s prompt',
    )
    expect(prompt).toContain(
      '1. When the same note is edited on two devices, what happens on reconnect? → Keep the latest edit (changed from your recommendation “Keep both and let me merge”; note: Rare.) 2. If a note is deleted on one device and edited on the other, which wins? → The edit wins. (recommended)',
    )
  })

  test('rounds and round answers are checked', async () => {
    const client = await start(false, true)
    const bad = path.join(scratch, 'bad.json')
    await writeFile(
      bad,
      JSON.stringify({
        title: 'Bad',
        questions: [{ question: 'Which?', choices: ['A', 'B'], recommended: 'C' }],
      }),
    )
    const task = await startTask(
      client,
      advance,
      depth('few', 'one question'),
      ask(bad),
      ask(client.storageFile),
      { endTurn: true },
    )
    const item = await openRequest(client, 'round')
    const results = await waitUntil(async () => {
      const found = await commandResults(client, task)
      return found.length >= 4 ? found : undefined
    }, 'every command to finish')
    expect(results[2]).toMatchObject({
      code: 2,
      stderr: expect.stringContaining('question 1’s recommended answer must be one of its choices'),
    })

    const answer = (body: unknown) =>
      client.call('POST', `/comments/${item.request.id}/answer`, body)
    expect((await answer({ action: 'answer-round', answers: [{ answer: 'x' }] })).body).toEqual({
      error: 'answer all 2 questions',
    })
    expect(
      (await answer({ action: 'answer-round', answers: [{ answer: ' ' }, { answer: 'x' }] })).body,
    ).toEqual({ error: 'question 1 needs an answer' })
    expect(
      (
        await answer({
          action: 'answer-round',
          answers: [{ answer: 'Keep the latest edit' }, { answer: ' ' }],
        })
      ).body,
    ).toEqual({ error: 'question 2 needs an answer' })
    expect((await answer({ action: 'answer', text: 'hi' })).status).toBe(400)
    expect((await answer({ action: 'accept-recommended' })).status).toBe(200)
  })
})
