import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Comment, Factory, InboxItem, Run, Task, ThreadEvent } from '@ted/protocol'
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
  waitUntil,
} from './helpers.ts'

let home: string
let cleanup: () => Promise<void>
let scratch: string
let origin: string
let daemon: RunningDaemon | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-split-'))
  origin = await makeOriginRepo(scratch)
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

const proposal = {
  title: 'Offline editing for notes, in five Tasks',
  tasks: [
    {
      title: 'Local note cache',
      scope: 'Notes save to a local cache first and sync from a queue.',
      description: 'Save every note to a local cache first; a queue syncs it later.',
      priority: 'high',
    },
    {
      title: 'Sync queue with retry',
      scope: 'Queue edits made offline and send them in order on reconnect.',
      priority: 'high',
      blockedBy: [1],
    },
    {
      title: 'Line-level merge for clashing edits',
      scope: 'Merge edits to different lines; flag edits to the same line.',
      priority: 'medium',
      blockedBy: [2],
    },
    {
      title: 'Conflict view for clashing lines',
      scope: 'Show both versions of a clashing line and let the user pick one.',
      priority: 'medium',
      blockedBy: [3],
    },
    {
      title: 'Offline badge in the editor',
      scope: 'A small badge while edits are waiting to sync.',
      priority: 'low',
    },
  ],
}

async function start() {
  await commitToOrigin(scratch, {
    '.ted/workflow.yaml': 'version: 1\norder: [intake, clarify, work]\n',
    '.gitignore': 'stub-*\n',
  })
  daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
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
    proposalFile: await file('proposal.json', JSON.stringify(proposal)),
    file,
    go: (name: string) => writeFile(path.join(scratch, name), ''),
    waitFile: (name: string) => path.join(scratch, name),
  }
}

type Client = Awaited<ReturnType<typeof start>>

const steps = (...list: unknown[]) => JSON.stringify({ steps: list })

async function startTask(client: Client, ...list: unknown[]): Promise<Task> {
  const task = await client.ok<Task>('POST', '/tasks', {
    title: steps(...list),
    description: 'Let notes be edited offline and sync later.',
    factory: 'NB',
  })
  await client.ok('POST', `/tasks/${task.id}/start`)
  return task
}

const allTasks = (client: Client) => client.ok<Task[]>('GET', '/tasks')

const getTask = async (client: Client, id: string) => {
  const task = (await allTasks(client)).find((t) => t.id === id)
  if (!task) throw new Error(`no Task ${id}`)
  return task
}

const leadRun = async (client: Client, id: string): Promise<Run> => {
  const { leadRunId } = await getTask(client, id)
  if (!leadRunId) throw new Error(`no Task Lead Run for ${id}`)
  return (await client.getRun(leadRunId)).run
}

const commandResults = async (client: Client, task: Task) =>
  assistantTexts((await client.getRun((await leadRun(client, task.id)).id)).conversation).map(
    (text) => JSON.parse(text) as { code: number; stdout: string; stderr: string },
  )

const userMessages = async (client: Client, runId: string) =>
  (await client.getRun(runId)).conversation.flatMap((e) => {
    const line = JSON.parse(e.line) as { type: string; message?: { content?: unknown } }
    return line.type === 'user' && typeof line.message?.content === 'string'
      ? [line.message.content]
      : []
  })

const comments = (client: Client, task: Task) =>
  client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)

const threadLines = async (client: Client, task: Task) =>
  (await client.ok<ThreadEvent[]>('GET', `/tasks/${task.id}/events`)).map((e) => e.text)

const openRequest = (client: Client, kind: string, not?: string) =>
  waitUntil(async () => {
    const items = await client.ok<InboxItem[]>('GET', '/inbox')
    return items.find((i) => i.request.kind === kind && i.request.id !== not)
  }, `a ${kind} in the Inbox`)

const tooBig = {
  run: [
    'ted',
    'clarify',
    'too-big',
    '--settle',
    'How conflicts between devices are resolved',
    '--settle',
    'Which piece ships first',
    'Offline editing touches storage, sync and the editor; that is several pull requests.',
  ],
}
const propose = (file: string) => ({ run: ['ted', 'task', 'propose', '--file', file] })
const advance = { run: ['ted', 'outcome', 'advance'] }
const toDone = JSON.stringify({ steps: [{ everyMessage: [advance] }, advance] })

describe('Size check', () => {
  test('a too-big Task asks with four choices', async () => {
    const client = await start()
    const task = await startTask(client, advance, tooBig, { endTurn: true })

    const item = await openRequest(client, 'question')
    expect(item.request).toMatchObject({
      kind: 'question',
      stage: 'clarify',
      title: 'Too big for one pull request per repo',
      body: 'Offline editing touches storage, sync and the editor; that is several pull requests.',
      choices: ['Plan in chat', 'Split it', 'Plan it outside TED', 'Grill anyway'],
      sizeCheck: {
        settle: ['How conflicts between devices are resolved', 'Which piece ships first'],
      },
      author: { kind: 'run' },
    })
    expect((await getTask(client, task.id)).status).toEqual({ kind: 'waiting-on-you' })
  })

  test('the size check is only for Clarify and only the Task Lead asks it', async () => {
    const client = await start()
    const task = await startTask(client, tooBig, { endTurn: true })
    const [result] = await waitUntil(async () => {
      const found = await commandResults(client, task)
      return found.length >= 1 ? found : undefined
    }, 'the command to finish')
    expect(result).toMatchObject({
      code: 1,
      stderr: expect.stringContaining('the size check is for Clarify'),
    })
  })

  test('Grill anyway keeps one Task and sets the depth to grilling', async () => {
    const client = await start()
    const task = await startTask(client, advance, tooBig, { endTurn: true })
    const item = await openRequest(client, 'question')
    await client.ok('POST', `/comments/${item.request.id}/answer`, {
      action: 'answer',
      choice: 'Grill anyway',
    })
    expect(await getTask(client, task.id)).toMatchObject({
      stage: 'clarify',
      clarifyDepth: 'grilling',
      clarifyDepthBy: 'human',
    })
    const run = await leadRun(client, task.id)
    const said = await waitUntil(
      async () => (await userMessages(client, run.id)).find((m) => m.includes('Grill anyway')),
      'the answer to reach the Task Lead',
    )
    expect(said).toContain('ted ask --round')
  })
})

describe('Split it', () => {
  test('Create N Tasks makes the checked rows children of the original, with blockers by row; the original stops and waits', async () => {
    const client = await start()
    const task = await startTask(
      client,
      advance,
      tooBig,
      { waitFor: client.waitFile('split') },
      propose(client.proposalFile),
      { endTurn: true },
    )
    const size = await openRequest(client, 'question')
    await client.ok('POST', `/comments/${size.request.id}/answer`, {
      action: 'answer',
      choice: 'Split it',
    })
    const run = await leadRun(client, task.id)
    const told = await waitUntil(
      async () => (await userMessages(client, run.id)).find((m) => m.includes('Split it')),
      'the choice to reach the Task Lead',
    )
    expect(told).toContain('ted task propose --file')
    await client.go('split')

    const item = await openRequest(client, 'proposal')
    expect(item.request).toMatchObject({
      kind: 'proposal',
      stage: 'clarify',
      title: proposal.title,
      proposal: {
        firstPiece: { id: task.id, displayId: task.displayId },
        rows: [
          { title: 'Local note cache', priority: 'high', blockedBy: [] },
          { title: 'Sync queue with retry', priority: 'high', blockedBy: [1] },
          { title: 'Line-level merge for clashing edits', priority: 'medium', blockedBy: [2] },
          { title: 'Conflict view for clashing lines', priority: 'medium', blockedBy: [3] },
          { title: 'Offline badge in the editor', priority: 'low', blockedBy: [] },
        ],
      },
    })

    const refused = await client.call('POST', `/comments/${item.request.id}/answer`, {
      action: 'answer',
      text: 'hm',
    })
    expect(refused.status).toBe(400)

    const answered = await client.ok<Comment>('POST', `/comments/${item.request.id}/answer`, {
      action: 'approve',
      proposal: { skip: [3], startUnblocked: false },
    })
    const tasks = await allTasks(client)
    const byTitle = (title: string) => {
      const found = tasks.find((t) => t.title === title)
      if (!found) throw new Error(`no Task ${title}`)
      return found
    }
    const cache = byTitle('Local note cache')
    const sync = byTitle('Sync queue with retry')
    const conflict = byTitle('Conflict view for clashing lines')
    const badge = byTitle('Offline badge in the editor')
    expect(tasks.some((t) => t.title === 'Line-level merge for clashing edits')).toBe(false)
    for (const piece of [cache, sync, conflict, badge]) {
      expect(piece).toMatchObject({
        stage: 'backlog',
        createdBy: 'split',
        parentId: task.id,
        splitFrom: { id: task.id, displayId: task.displayId },
      })
    }
    expect(cache).toMatchObject({
      blockedBy: [],
      description: 'Save every note to a local cache first; a queue syncs it later.',
    })
    expect(sync).toMatchObject({
      priority: 'high',
      blockedBy: [cache.id],
      description: 'Queue edits made offline and send them in order on reconnect.',
    })
    expect(conflict.blockedBy).toEqual([])
    expect(badge).toMatchObject({ priority: 'low', blockedBy: [] })
    expect(answered.answer).toMatchObject({
      kind: 'approved',
      created: {
        skipped: [3],
        startUnblocked: false,
        tasks: [
          { row: 1, id: cache.id, displayId: cache.displayId },
          { row: 2, id: sync.id, displayId: sync.displayId },
          { row: 4, id: conflict.id, displayId: conflict.displayId },
          { row: 5, id: badge.id, displayId: badge.displayId },
        ],
      },
    })

    const original = await getTask(client, task.id)
    expect(original).toMatchObject({
      stage: 'clarify',
      description: 'Let notes be edited offline and sync later.',
      childIds: expect.arrayContaining([cache.id, sync.id, conflict.id, badge.id]),
    })
    await waitUntil(
      async () => (await client.getRun(run.id)).run.state === 'finished',
      'the original’s Task Lead to stop',
    )
    expect(await threadLines(client, task)).toContain(
      `Split into ${cache.displayId}, ${sync.displayId}, ${conflict.displayId} and ${badge.displayId}. This Task waits for them to merge.`,
    )
    expect(await threadLines(client, sync)).toContain(`Split from ${task.displayId}`)
  })

  test('Start the unblocked ones starts them; Request changes sends the text to the Task Lead; the parent finishes when one child merged and the other is archived', async () => {
    const client = await start()
    const two = await client.file(
      'two.json',
      JSON.stringify({
        title: 'Two pieces',
        tasks: [
          { title: 'First piece', scope: 'The first part.', description: toDone },
          {
            title: 'Second piece',
            scope: 'The second part.',
            description: steps({ endTurn: true }),
          },
        ],
      }),
    )
    const task = await startTask(
      client,
      advance,
      propose(two),
      { endTurn: true },
      { waitFor: client.waitFile('again') },
      propose(two),
      { endTurn: true },
    )
    const first = await openRequest(client, 'proposal')
    await client.ok('POST', `/comments/${first.request.id}/answer`, {
      action: 'request-changes',
      text: 'Make the badge its own Task.',
    })
    const run = await leadRun(client, task.id)
    await client.go('again')
    const said = await waitUntil(
      async () =>
        (await userMessages(client, run.id)).find((m) =>
          m.includes('Make the badge its own Task.'),
        ),
      'the changes to reach the Task Lead',
    )
    expect(said).toContain('ted task propose --file')

    const second = await openRequest(client, 'proposal', first.request.id)
    await client.ok('POST', `/comments/${second.request.id}/answer`, {
      action: 'approve',
      proposal: { startUnblocked: true },
    })
    const piece = (await allTasks(client)).find((t) => t.title === 'Second piece')
    expect(piece?.stage).not.toBe('backlog')
    await waitUntil(async () => {
      const done = (await allTasks(client)).find((t) => t.title === 'First piece')
      return done?.stage === 'done' || undefined
    }, 'the first child to merge')
    expect((await getTask(client, task.id)).stage).toBe('clarify')
    await client.ok('POST', `/tasks/${piece?.id}/archive`, {})
    const parent = await waitUntil(async () => {
      const now = await getTask(client, task.id)
      return now.stage === 'done' ? now : undefined
    }, 'the parent to finish once its last unfinished child is archived')
    expect(parent.runs.filter((r) => r.state !== 'finished')).toEqual([])
    expect(
      (await allTasks(client))
        .filter((t) => t.parentId === task.id)
        .map((t) => [t.title, t.stage, t.archived !== undefined]),
    ).toEqual([
      ['First piece', 'done', false],
      ['Second piece', 'intake', true],
    ])
    expect(await threadLines(client, task)).toContain(
      'Every Task under this one has merged and it had no work of its own, so TED finished it.',
    )
  })

  test('proposals are checked: rows in range, no cycles, at least two rows, Task Lead only', async () => {
    const client = await start()
    const bad = async (name: string, tasks: unknown[]) =>
      propose(await client.file(name, JSON.stringify({ title: 'Bad', tasks })))
    const task = await startTask(
      client,
      advance,
      await bad('range.json', [
        { title: 'A', scope: 'a' },
        { title: 'B', scope: 'b', blockedBy: [3] },
      ]),
      await bad('cycle.json', [
        { title: 'A', scope: 'a' },
        { title: 'B', scope: 'b', blockedBy: [3] },
        { title: 'C', scope: 'c', blockedBy: [2] },
      ]),
      await bad('one.json', [{ title: 'A', scope: 'a' }]),
      { endTurn: true },
    )
    const results = await waitUntil(async () => {
      const found = await commandResults(client, task)
      return found.length >= 4 ? found : undefined
    }, 'every command to finish')
    expect(results[1]?.stderr).toContain('row 2 is blocked by row 3, which isn’t in the proposal')
    expect(results[2]?.stderr).toContain('rows 2 → 3 → 2 block each other')
    expect(results[3]?.stderr).toContain('a split needs at least two rows')
    const human = await client.call('POST', `/tasks/${task.id}/comments`, {
      proposal: {
        title: 'Mine',
        tasks: [
          { title: 'A', scope: 'a' },
          { title: 'B', scope: 'b' },
        ],
      },
    })
    expect(human.status).toBe(403)
  })
})

describe('Plan it outside TED', () => {
  test('the Task returns to Backlog with Needs planning and its Run stops; starting it clears the marker and runs Clarify', async () => {
    const client = await start()
    const task = await startTask(client, advance, tooBig, { endTurn: true })
    const item = await openRequest(client, 'question')
    const run = await leadRun(client, task.id)
    await client.ok('POST', `/comments/${item.request.id}/answer`, {
      action: 'answer',
      choice: 'Plan it outside TED',
    })

    const parked = await waitUntil(async () => {
      const found = await getTask(client, task.id)
      return found.stage === 'backlog' && found.repos.every((r) => r.removed) ? found : undefined
    }, 'the Task to go back to Backlog')
    expect(parked.markers).toEqual([{ kind: 'needs-planning' }])
    expect(parked.status).toBeUndefined()
    await waitUntil(
      async () => (await client.getRun(run.id)).run.state === 'finished',
      'the original’s Task Lead to stop',
    )
    const note = (await comments(client, task)).findLast((c) => c.kind === 'note')
    expect(note).toMatchObject({ author: { kind: 'run', runId: run.id } })
    expect(note?.body).toContain(
      'Offline editing touches storage, sync and the editor; that is several pull requests.',
    )
    expect(note?.body).toContain('- How conflicts between devices are resolved')
    expect(await threadLines(client, task)).toContain('Moved to Backlog to be planned outside TED')

    await client.ok('POST', `/tasks/${task.id}/start`)
    const restarted = await waitUntil(async () => {
      const found = await getTask(client, task.id)
      return found.leadRunId !== undefined && found.leadRunId !== run.id ? found : undefined
    }, 'a fresh Task Lead Run')
    expect(restarted.stage).toBe('clarify')
    expect(restarted.markers).toEqual([])
    const fresh = await client.getRun(restarted.leadRunId ?? '')
    expect(fresh.run.prompt).toContain('Picking up after planning outside TED')
  })
})
