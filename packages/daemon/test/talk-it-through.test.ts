import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type Banner,
  type Comment,
  type Factory,
  type InboxItem,
  type RunSlots,
  type Task,
  type ThreadEvent,
  tedPaths,
} from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import { openStore } from '../src/store/index.ts'
import {
  api,
  assistantTexts,
  commitToOrigin,
  hostsStarted,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  rawRequest,
  stubClaudePath,
  waitUntil,
} from './helpers.ts'

const transport = vi.hoisted(() => ({ loseCheckpoint: false, accepted: false }))
vi.mock('../src/runs/run-manager.ts', async (original) => {
  const module = await original<typeof import('../src/runs/run-manager.ts')>()
  return {
    ...module,
    startRunManager: async (...args: Parameters<typeof module.startRunManager>) => {
      const runs = await module.startRunManager(...args)
      return {
        ...runs,
        dispatch: async (...input: Parameters<typeof runs.dispatch>) => {
          const delivered = await runs.dispatch(...input)
          if (delivered && transport.loseCheckpoint) {
            transport.accepted = true
            throw new Error('simulated daemon exit before the talk delivery checkpoint')
          }
          return delivered
        },
      }
    },
  }
})

let home: string
let cleanup: () => Promise<void>
let scratch: string
let origin: string
let daemon: RunningDaemon | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-talk-'))
  origin = await makeOriginRepo(scratch)
})

afterEach(async () => {
  transport.loseCheckpoint = false
  transport.accepted = false
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

const storageRound = {
  title: 'Storage · 2 questions',
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
      choices: ['7 days', '30 days'],
      recommended: '7 days',
    },
  ],
}

const summary = `Summary of Talk it through, Round 1:

1. Conflicts: keep both copies and show a merge view.
2. Delete vs edit: the edit wins.
Still open: how long a device can stay offline.
`

function connection() {
  if (!daemon) throw new Error('no daemon')
  const client = api(daemon.port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  return { ...client, ok }
}

async function start(options: Pick<Parameters<typeof startDaemon>[0], 'disk'> = {}) {
  await commitToOrigin(scratch, {
    '.ted/workflow.yaml': 'version: 1\norder: [intake, clarify, work]\n',
  })
  daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath, ...options })
  const client = connection()
  const { ok } = client
  await ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const file = async (name: string, content: string) => {
    const at = path.join(scratch, name)
    await writeFile(at, content)
    return at
  }
  return {
    ...client,
    ok,
    storageFile: await file('storage.json', JSON.stringify(storageRound)),
    syncFile: await file('sync.json', JSON.stringify(syncRound)),
    summaryFile: await file('summary.md', summary),
    emptyFile: await file('empty.md', '  \n'),
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

const leadId = async (client: Client, task: Task): Promise<string> => {
  const { leadRunId } = await getTask(client, task.id)
  if (!leadRunId) throw new Error(`no Task Lead Run for ${task.displayId}`)
  return leadRunId
}

const agentTexts = async (client: Client, task: Task) =>
  assistantTexts((await client.getRun(await leadId(client, task))).conversation)

const commandResults = async (client: Client, task: Task) =>
  (await agentTexts(client, task)).flatMap((text) => {
    try {
      const parsed = JSON.parse(text) as { code?: number; stdout: string; stderr: string }
      return parsed.code === undefined ? [] : [parsed]
    } catch {
      return []
    }
  })

const userMessages = async (client: Client, task: Task) =>
  (await client.getRun(await leadId(client, task))).conversation.flatMap((e) => {
    const line = JSON.parse(e.line) as { type: string; message?: { content?: unknown } }
    return line.type === 'user' && typeof line.message?.content === 'string'
      ? [line.message.content]
      : []
  })

const comments = (client: Client, task: Task) =>
  client.ok<Comment[]>('GET', `/tasks/${task.id}/comments`)

const threadLines = async (client: Client, task: Task) =>
  (await client.ok<ThreadEvent[]>('GET', `/tasks/${task.id}/events`)).map((e) => e.text)

const openRound = (client: Client, number: number) =>
  waitUntil(async () => {
    const items = await client.ok<InboxItem[]>('GET', '/inbox')
    return items.find((i) => i.request.kind === 'round' && i.request.round?.number === number)
  }, `Round ${number} in the Inbox`)

const ask = (file: string) => ({ run: ['ted', 'ask', '--round', file] })
const close = (file: string) => ({ run: ['ted', 'ask', '--close', '--summary', file] })
const advance = { run: ['ted', 'outcome', 'advance'] }
const few = { run: ['ted', 'clarify', 'depth', 'few', 'two questions'] }
const reply = { everyMessage: [{ say: 'Noted.' }, { endTurn: true }] }

const waitForReply = (client: Client, task: Task, text: string) =>
  waitUntil(
    async () => (await agentTexts(client, task)).includes(text) || undefined,
    `the Task Lead to say “${text}”`,
  )

describe('Talk it through', () => {
  test('opens a talk with the Task Lead; Done talking makes it post a summary that closes the round, and open questions go into a new round', async () => {
    const client = await start()
    const task = await startTask(client, advance, few, ask(client.storageFile), reply, {
      endTurn: true,
    })
    const item = await openRound(client, 1)
    const lead = await leadId(client, task)
    await waitForReply(client, task, 'Noted.')

    const talking = await client.ok<Comment>('POST', `/comments/${item.request.id}/talk`)
    expect(talking.talk).toMatchObject({ runId: lead, startedAt: expect.any(String) })
    expect(talking.talk?.doneAt).toBeUndefined()
    expect(talking.answer).toBeUndefined()
    const again = await client.ok<Comment>('POST', `/comments/${item.request.id}/talk`)
    expect(again.talk?.startedAt).toBe(talking.talk?.startedAt)

    const opened = await waitUntil(
      async () =>
        (await userMessages(client, task)).find((m) => m.includes('wants to talk Round 1')),
      'the talk line to reach the Task Lead',
    )
    expect(opened.split('\n\n')[0]).toBe(
      'The human wants to talk Round 1 “Storage · 2 questions” through with you here; when it’s settled, post a summary with `ted ask --close --summary <file>`.',
    )
    await waitUntil(
      async () => (await agentTexts(client, task)).filter((t) => t === 'Noted.').length >= 2,
      'the Task Lead to answer the talk line',
    )

    await client.ok('POST', `/runs/${lead}/messages`, {
      text: steps({ say: 'Two copies side by side.' }, { endTurn: true }),
    })
    await waitForReply(client, task, 'Two copies side by side.')
    await client.ok('POST', `/runs/${lead}/messages`, {
      text: steps(
        { everyMessage: [close(client.summaryFile), ask(client.syncFile), { endTurn: true }] },
        { say: 'Fine, the edit wins.' },
        { endTurn: true },
      ),
    })
    await waitForReply(client, task, 'Fine, the edit wins.')

    const done = await client.ok<Comment>('POST', `/comments/${item.request.id}/done-talking`)
    expect(done.talk?.doneAt).toEqual(expect.any(String))
    const ending = await waitUntil(
      async () =>
        (await userMessages(client, task)).find((m) => m.includes('done talking Round 1')),
      'Done talking to reach the Task Lead',
    )
    expect(ending).toContain('`ted ask --close --summary <file>`')
    expect(ending).toContain('`ted ask --round <file>`')

    const closed = await waitUntil(
      async () => (await comments(client, task)).find((c) => c.id === item.request.id && c.answer),
      'the round to close',
    )
    const note = (await comments(client, task)).find(
      (c) => c.kind === 'note' && c.body === summary.trim(),
    )
    expect(note).toMatchObject({ author: { kind: 'run', runId: lead }, stage: 'clarify' })
    expect(closed.answer).toEqual({
      kind: 'answered',
      at: expect.any(String),
      talkedThrough: { runId: lead, summaryId: note?.id, messages: 5 },
    })

    const second = await openRound(client, 2)
    expect(second.request.title).toBe('Sync · 1 question')
    const results = await waitUntil(async () => {
      const found = await commandResults(client, task)
      return found.length >= 5 ? found : undefined
    }, 'the close and the new round')
    expect(results[3]).toMatchObject({
      code: 0,
      stdout: expect.stringMatching(/^Closed Round 1 as answered in Talk it through/),
    })
    expect(results[4]).toMatchObject({ code: 0 })

    expect(await threadLines(client, task)).not.toContain(
      'You steered the Task Lead in its Conversation',
    )
  })

  test('the Task Lead can close the round on its own, but not before the human starts a talk', async () => {
    const client = await start()
    const task = await startTask(
      client,
      advance,
      few,
      ask(client.storageFile),
      close(client.summaryFile),
      reply,
      { endTurn: true },
    )
    const item = await openRound(client, 1)
    await waitUntil(
      async () => (await commandResults(client, task)).length >= 4,
      'the early close to fail',
    )
    const early = (await commandResults(client, task))[3]
    expect(early).toMatchObject({
      code: 1,
      stderr: expect.stringContaining('no round is being talked through'),
    })

    const lead = await leadId(client, task)
    await client.ok('POST', `/comments/${item.request.id}/talk`)
    await client.ok('POST', `/runs/${lead}/messages`, {
      text: steps(close(client.emptyFile), close(client.summaryFile), { endTurn: true }),
    })
    const closed = await waitUntil(
      async () => (await comments(client, task)).find((c) => c.id === item.request.id && c.answer),
      'the round to close',
    )
    expect(closed.answer).toMatchObject({ kind: 'answered', talkedThrough: { runId: lead } })
    expect(closed.talk?.doneAt).toBeUndefined()
    const results = await waitUntil(async () => {
      const found = await commandResults(client, task)
      return found.length >= 6 ? found : undefined
    }, 'both closes')
    expect(results[4]).toMatchObject({
      code: 2,
      stderr: expect.stringContaining('the summary file is empty'),
    })
    expect(results[5]).toMatchObject({ code: 0 })

    const late = await client.call('POST', `/comments/${item.request.id}/talk`)
    expect(late).toMatchObject({ status: 409 })
    const lateDone = await client.call('POST', `/comments/${item.request.id}/done-talking`)
    expect(lateDone).toMatchObject({ status: 409 })
  })

  test('a talk needs a round and app authority; a stopped Task needs confirmation before a fresh Lead starts', async () => {
    const client = await start()
    const task = await startTask(client, advance, few, ask(client.storageFile), reply, {
      endTurn: true,
    })
    const item = await openRound(client, 1)
    const lead = await leadId(client, task)

    const notTalking = await client.call('POST', `/comments/${item.request.id}/done-talking`)
    expect(notTalking).toMatchObject({
      status: 409,
      body: { error: 'this round isn’t being talked through' },
    })

    const runToken = (await loadRunTokens(tedPaths(home).runTokenKey)).issue(lead)
    for (const route of [
      `/comments/${item.request.id}/talk`,
      `/comments/${item.request.id}/done-talking`,
    ]) {
      const res = await rawRequest(daemon?.port ?? 0, {
        method: 'POST',
        path: route,
        headers: { authorization: `Bearer ${runToken}` },
      })
      expect(res.status).toBe(403)
    }

    const note = await client.ok<Comment>('POST', `/tasks/${task.id}/comments`, { body: 'Hi' })
    expect(await client.call('POST', `/comments/${note.id}/talk`)).toMatchObject({ status: 400 })

    await client.ok('POST', `/tasks/${task.id}/stop`)
    const stopped = await client.call('POST', `/comments/${item.request.id}/talk`)
    expect(stopped).toMatchObject({ status: 200, body: { resumeRequired: true } })
    expect((await getTask(client, task.id)).leadRunId).toBe(lead)
    expect((await getTask(client, task.id)).runs.every((r) => r.state === 'finished')).toBe(true)
    expect(
      (await comments(client, task)).find((c) => c.id === item.request.id)?.talkRequested,
    ).toBeUndefined()
    await client.ok('POST', `/comments/${item.request.id}/talk`, { confirmResume: true })
    const talking = await waitUntil(async () => {
      const round = (await comments(client, task)).find((c) => c.id === item.request.id)
      return round?.talk && round.talk.runId !== lead ? round : undefined
    }, 'the confirmed talk to bind to a fresh Lead')
    expect(talking.answer).toBeUndefined()
    expect((await getTask(client, task.id)).stage).toBe('clarify')
    await waitUntil(
      async () =>
        (await userMessages(client, task)).some((m) => m.includes('wants to talk Round 1')),
      'the new Lead to receive the talk request',
    )
  })

  test('a Task stopped by TED starts directly for a talk without asking to resume', async () => {
    let client = await start()
    const task = await startTask(client, advance, few, ask(client.storageFile), reply, {
      endTurn: true,
    })
    const item = await openRound(client, 1)
    const first = await leadId(client, task)
    await client.ok('POST', `/tasks/${task.id}/stop`)
    await daemon?.stop()
    const store = await openStore({ directory: tedPaths(home).store })
    try {
      store.stopTask(task.id, { runs: store.getTask(task.id)?.runs.length ?? 0, why: 'prepared' })
      await store.persisted()
    } finally {
      await store.close()
    }
    daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
    client = { ...client, ...connection() }
    const requested = await client.ok<Comment>('POST', `/comments/${item.request.id}/talk`)
    expect(requested).not.toHaveProperty('resumeRequired')
    await waitUntil(async () => {
      const round = (await comments(client, task)).find((c) => c.id === item.request.id)
      return round?.talk && round.talk.runId !== first ? round : undefined
    }, 'the automatically started Lead to receive the talk')
  })

  test('a queued talk survives a restart, starts once, and is cancelled by stopping or answering the round', async () => {
    await writeFile(
      path.join(home, 'stub-claude.json'),
      JSON.stringify({ resumeSteps: [{ endTurn: true }] }),
    )
    let client = await start()
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
    const task = await startTask(client, advance, few, ask(client.storageFile), reply, {
      endTurn: true,
    })
    const item = await openRound(client, 1)
    const first = await leadId(client, task)
    await client.ok('POST', `/tasks/${task.id}/stop`)
    const blocker = await startTask(
      client,
      { waitFor: path.join(scratch, 'never') },
      { endTurn: true },
    )
    await waitUntil(
      async () => (await getTask(client, blocker.id)).runs.some((r) => r.state === 'working'),
      'the other Task to hold the slot',
    )
    await client.ok('POST', `/tasks/${task.id}/resume`, {})
    const pending = await client.ok<Comment>('POST', `/comments/${item.request.id}/talk`)
    expect(pending.talkRequested).toBe(true)
    await client.ok('POST', `/comments/${item.request.id}/talk`)
    expect((await getTask(client, task.id)).leadRunId).toBe(first)

    await hostsStarted(home)
    await daemon?.stop()
    daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
    client = { ...client, ...connection() }
    expect(
      (await comments(client, task)).find((c) => c.id === item.request.id)?.talkRequested,
    ).toBe(true)
    await client.ok('POST', `/tasks/${blocker.id}/stop`)
    const talking = await waitUntil(async () => {
      const round = (await comments(client, task)).find((c) => c.id === item.request.id)
      return round?.talk?.runId !== first && round?.talk ? round : undefined
    }, 'the queued talk to bind after restart')
    const ready = await waitUntil(async () => {
      const round = (await comments(client, task)).find((c) => c.id === item.request.id)
      return round?.talk?.notifiedAt && round.talk.runId === talking.talk?.runId ? round : undefined
    }, 'the queued talk to be acknowledged after binding')
    expect(ready.talkRequested).toBeUndefined()
    expect(
      (await getTask(client, task.id)).runs.filter((r) => r.state !== 'finished'),
    ).toHaveLength(1)
    await waitUntil(
      async () =>
        (await userMessages(client, task)).filter((m) => m.includes('wants to talk Round 1'))
          .length === 1,
      'exactly one talk request',
    )

    await client.ok('POST', `/tasks/${task.id}/stop`)
    const nextBlocker = await startTask(
      client,
      { waitFor: path.join(scratch, 'never-again') },
      { endTurn: true },
    )
    await waitUntil(
      async () => (await getTask(client, nextBlocker.id)).runs.some((r) => r.state === 'working'),
      'the slot to be occupied again',
    )
    await client.ok('POST', `/comments/${item.request.id}/talk`, { confirmResume: true })
    await client.ok('POST', `/tasks/${task.id}/stop`)
    expect(
      (await comments(client, task)).find((c) => c.id === item.request.id)?.talkRequested,
    ).toBeUndefined()
    await client.ok('POST', `/comments/${item.request.id}/talk`, { confirmResume: true })
    await client.ok('POST', `/comments/${item.request.id}/answer`, {
      action: 'answer-round',
      answers: storageRound.questions.map((q) => ({ answer: q.recommended })),
    })
    const answered = (await comments(client, task)).find((c) => c.id === item.request.id)
    expect(answered?.answer?.kind).toBe('answered')
    expect(answered?.talkRequested).toBeUndefined()
    expect(await client.call('POST', `/comments/${item.request.id}/talk`)).toMatchObject({
      status: 409,
    })
  })

  test('a live unavailable Lead keeps the talk pending until the default model is restored', async () => {
    const client = await start()
    const task = await startTask(client, advance, few, ask(client.storageFile), reply, {
      endTurn: true,
    })
    const item = await openRound(client, 1)
    await waitUntil(
      async () => (await client.getRun(await leadId(client, task))).run.state !== 'working',
      'the initial Lead to settle',
    )
    const lead = await leadId(client, task)
    const inputReady = path.join(scratch, 'resume-input-ready')
    await writeFile(inputReady, '')
    await writeFile(
      path.join(home, 'stub-claude.json'),
      JSON.stringify({ resumeInputWaitsFor: inputReady, resumeSteps: [{ endTurn: true }] }),
    )
    await client.ok('PUT', `/tasks/${task.id}/lead`, { agent: 'claude', model: 'unavailable-9' })
    await client.ok('POST', `/runs/${lead}/messages`, { text: 'Continue on the selected model.' })
    await waitUntil(
      async () =>
        (await client.getRun(await leadId(client, task))).run.problem === 'model-unavailable',
      'the live Lead to wait for a model',
    )
    const pending = await client.ok<Comment>('POST', `/comments/${item.request.id}/talk`)
    expect(pending.talkRequested).toBe(true)
    expect(pending.talk).toBeUndefined()
    expect((await getTask(client, task.id)).leadRunId).toBe(lead)
    expect(
      (await userMessages(client, task)).some((m) => m.includes('wants to talk Round 1')),
    ).toBe(false)
    await client.ok('POST', `/tasks/${task.id}/lead/use-default-model`)
    await waitUntil(async () => {
      const round = (await comments(client, task)).find((c) => c.id === item.request.id)
      return round?.talk?.runId === lead && round.talk.notifiedAt && !round.talkRequested
    }, 'the recovered live Lead to acknowledge the talk')
    expect(
      (await userMessages(client, task)).filter((m) => m.includes('wants to talk Round 1')),
    ).toHaveLength(1)
  })

  test('answering before a working Lead’s next boundary cancels its bound talk notification', async () => {
    const client = await start()
    const gate = path.join(scratch, 'allow-boundary')
    const task = await startTask(
      client,
      advance,
      few,
      ask(client.storageFile),
      { say: 'Before boundary' },
      { waitFor: gate },
      { tool: 'Read' },
      reply,
      { endTurn: true },
    )
    const item = await openRound(client, 1)
    await waitForReply(client, task, 'Before boundary')
    const lead = await leadId(client, task)
    const pending = await waitUntil(async () => {
      const requested = await client.ok<Comment>('POST', `/comments/${item.request.id}/talk`)
      return requested.talk?.runId === lead ? requested : undefined
    }, 'the talk to bind while the Lead is working')
    expect(pending.talk?.runId).toBe(lead)
    expect(pending.talkRequested).toBe(true)
    await client.ok('POST', `/comments/${item.request.id}/answer`, {
      action: 'answer-round',
      answers: storageRound.questions.map((q) => ({ answer: q.recommended })),
    })
    await writeFile(gate, '')
    await waitUntil(
      async () => (await client.getRun(lead)).run.state !== 'working',
      'the Lead to pass its boundary',
    )
    expect(
      (await userMessages(client, task)).some((m) => m.includes('wants to talk Round 1')),
    ).toBe(false)
    expect(
      (await comments(client, task)).find((c) => c.id === item.request.id)?.talkRequested,
    ).toBeUndefined()
  })

  test('answering revokes talk input already written before the host consumes it', async () => {
    const client = await start()
    const task = await startTask(client, advance, few, ask(client.storageFile), reply, {
      endTurn: true,
    })
    const item = await openRound(client, 1)
    const lead = await leadId(client, task)
    await waitUntil(async () => {
      const { state } = (await client.getRun(lead)).run
      return state === 'idle' || state === 'waiting'
    }, 'the Lead to wait')
    const runDir = path.join(home, 'runs', lead)
    const host = Number(await readFile(path.join(runDir, 'host.pid'), 'utf8'))
    process.kill(host, 'SIGSTOP')
    try {
      await client.ok('POST', `/comments/${item.request.id}/talk`)
      await waitUntil(
        async () =>
          (await readFile(path.join(runDir, 'input.jsonl'), 'utf8').catch(() => '')).includes(
            'wants to talk Round 1',
          ),
        'talk input written before host consumption',
      )
      await client.ok('POST', `/comments/${item.request.id}/answer`, {
        action: 'answer-round',
        answers: storageRound.questions.map((q) => ({ answer: q.recommended })),
      })
    } finally {
      process.kill(host, 'SIGCONT')
    }
    await client.ok('POST', `/runs/${lead}/messages`, {
      text: steps({ say: 'After canceled talk' }, { endTurn: true }),
    })
    await waitForReply(client, task, 'After canceled talk')
    expect(
      (await userMessages(client, task)).some((m) => m.includes('wants to talk Round 1')),
    ).toBe(false)
    const closed = (await comments(client, task)).find((c) => c.id === item.request.id)
    expect(closed?.answer?.kind).toBe('answered')
    expect(closed?.talk?.notifiedAt).toBeUndefined()
  })

  test('an existing waiting Lead’s talk waits for slot admission and disk recovery', async () => {
    let free = 500e9
    const client = await start({ disk: { freeBytes: async () => free, checkEveryMs: 20 } })
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
    const task = await startTask(client, advance, few, ask(client.storageFile), reply, {
      endTurn: true,
    })
    const item = await openRound(client, 1)
    const lead = await leadId(client, task)
    await waitUntil(async () => {
      const { state } = (await client.getRun(lead)).run
      return state === 'idle' || state === 'waiting'
    }, 'the Lead to wait')
    const blocker = await startTask(
      client,
      { waitFor: path.join(scratch, 'hold-slot') },
      { endTurn: true },
    )
    await waitUntil(
      async () => (await getTask(client, blocker.id)).runs.some((r) => r.state === 'working'),
      'the occupied slot',
    )
    await client.ok('POST', `/comments/${item.request.id}/talk`)
    await waitUntil(
      async () =>
        (await client.ok<RunSlots>('GET', '/slots')).queue.some(
          (q) => q.kind === 'task' && q.taskId === task.id,
        ),
      'the talk to queue behind the working Task',
    )
    expect(
      (await userMessages(client, task)).some((m) => m.includes('wants to talk Round 1')),
    ).toBe(false)
    free = 100e6
    await waitUntil(
      async () =>
        (await client.ok<Banner[]>('GET', '/banners')).some((b) => b.problem === 'disk-full'),
      'the disk hold',
    )
    await client.ok('POST', `/tasks/${blocker.id}/stop`)
    await waitUntil(
      async () => (await client.ok<RunSlots>('GET', '/slots')).working === 0,
      'the slot to be free while the disk holds work',
    )
    const held = (await comments(client, task)).find((c) => c.id === item.request.id)
    expect(held?.talkRequested).toBe(true)
    expect(held?.talk?.notifiedAt).toBeUndefined()
    expect(
      (await userMessages(client, task)).some((m) => m.includes('wants to talk Round 1')),
    ).toBe(false)
    free = 500e9
    await waitUntil(async () => {
      const ready = (await comments(client, task)).find((c) => c.id === item.request.id)
      return ready?.talk?.notifiedAt && !ready.talkRequested
    }, 'the admitted talk after disk recovery')
    await waitUntil(
      async () =>
        (await userMessages(client, task)).filter((m) => m.includes('wants to talk Round 1'))
          .length === 1,
      'one admitted notification',
    )
    expect((await getTask(client, task.id)).leadRunId).toBe(lead)
  })

  test('a restart after host acknowledgement replays the checkpoint without delivering the talk twice', async () => {
    let client = await start()
    const task = await startTask(client, advance, few, ask(client.storageFile), reply, {
      endTurn: true,
    })
    const item = await openRound(client, 1)
    await waitUntil(
      async () => (await client.getRun(await leadId(client, task))).run.state !== 'working',
      'the Lead to settle',
    )
    const lead = await leadId(client, task)
    transport.loseCheckpoint = true
    await client.ok('POST', `/comments/${item.request.id}/talk`)
    await waitUntil(() => transport.accepted, 'host acknowledgement before the simulated exit')
    expect(
      (await comments(client, task)).find((c) => c.id === item.request.id)?.talkRequested,
    ).toBe(true)
    await waitUntil(
      async () =>
        (await userMessages(client, task)).some((m) => m.includes('wants to talk Round 1')),
      'the host to receive the original talk',
    )
    await hostsStarted(home)
    await daemon?.stop()
    transport.loseCheckpoint = false
    daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
    client = { ...client, ...connection() }
    await waitUntil(async () => {
      const round = (await comments(client, task)).find((c) => c.id === item.request.id)
      return round?.talk?.runId === lead && !round.talkRequested
    }, 'the replayed acknowledgement checkpoint')
    expect(
      (await userMessages(client, task)).filter((m) => m.includes('wants to talk Round 1')),
    ).toHaveLength(1)
  })

  test('after the Task Lead is replaced, Done talking asks for a fresh talk and the new Run can’t close the old one', async () => {
    const client = await start()
    const task = await startTask(client, advance, few, ask(client.storageFile), reply, {
      endTurn: true,
    })
    const item = await openRound(client, 1)
    const first = await leadId(client, task)
    await client.ok('POST', `/comments/${item.request.id}/talk`)
    await client.ok('POST', `/tasks/${task.id}/stop`)
    await client.ok('POST', `/tasks/${task.id}/resume`, {})
    const second = await waitUntil(async () => {
      const id = (await getTask(client, task.id)).leadRunId
      return id !== undefined && id !== first ? id : undefined
    }, 'a fresh Task Lead Run')
    await waitUntil(
      async () => (await client.getRun(second)).run.state !== 'working' || undefined,
      'the fresh Run to settle',
    )

    const stale = await client.call('POST', `/comments/${item.request.id}/done-talking`)
    expect(stale.status).toBe(409)
    expect(stale.body.error).toMatch(/restarted since this talk began/)

    await client.ok('POST', `/runs/${second}/messages`, {
      text: steps(close(client.summaryFile), { endTurn: true }),
    })
    const refused = await waitUntil(
      async () =>
        (await commandResults(client, task)).find((r) => /earlier Task Lead Run/.test(r.stderr)),
      'the close to be refused',
    )
    expect(refused.code).toBe(1)

    const again = await client.ok<Comment>('POST', `/comments/${item.request.id}/talk`)
    expect(again.talk?.runId).toBe(second)
  })
})
