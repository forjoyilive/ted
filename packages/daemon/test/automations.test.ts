import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type {
  Activity,
  Automation,
  AutomationDetail,
  AutomationRun,
  Banner,
  Factory,
  RunSlots,
  RunWithConversation,
  Task,
} from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import {
  api,
  assistantTexts,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  waitUntil,
} from './helpers.ts'

let home: string
let cleanup: () => Promise<void>
let scratch: string
let daemon: RunningDaemon | undefined
let clock: number

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-origin-'))
  await makeOriginRepo(scratch)
  clock = Date.parse('2026-11-09T08:55:00Z')
  free = 500e9
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

let free = 500e9

async function startTed(options: { addFactory?: boolean } = {}) {
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    automations: { now: () => clock, checkEveryMs: 50 },
    disk: { freeBytes: async () => free, checkEveryMs: 50 },
  })
  const client = api(daemon.port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  if (options.addFactory !== false) {
    await ok<Factory>('POST', '/dev/factories', {
      repo: path.join(scratch, 'acme', 'widgets.git'),
      key: 'NB',
    })
  }
  return { ...client, ok }
}

type Client = Awaited<ReturnType<typeof startTed>>

const steps = (...list: unknown[]) => JSON.stringify({ steps: list })
const hold = () => ({ waitFor: path.join(scratch, 'release') })
const release = () => writeFile(path.join(scratch, 'release'), '')

const create = (client: Client, body: Record<string, unknown>) =>
  client.ok<Automation>('POST', '/automations', {
    name: 'Sentry crash intake',
    factory: 'NB',
    timeZone: 'Europe/London',
    schedule: { kind: 'daily', at: '09:00' },
    prompt: steps({ say: 'Nothing new' }, { endTurn: true }),
    ...body,
  })

const detail = (client: Client, id: string) =>
  client.ok<AutomationDetail>('GET', `/automations/${id}`)

const history = async (client: Client, id: string) => (await detail(client, id)).history

const waitForHistory = (
  client: Client,
  id: string,
  check: (rows: AutomationRun[]) => boolean,
  what: string,
) =>
  waitUntil(
    async () => {
      const rows = await history(client, id)
      return check(rows) ? rows : undefined
    },
    what,
    20_000,
  )

const said = async (client: Client, runId: string) =>
  assistantTexts((await client.ok<RunWithConversation>('GET', `/runs/${runId}`)).conversation)

describe('Automations', () => {
  test('an Automation fires at its clock time in its own time zone and the Run finishes', async () => {
    const client = await startTed()
    const automation = await create(client, {})
    expect(automation).toMatchObject({
      name: 'Sentry crash intake',
      scheduleText: 'Daily at 09:00 · Europe/London',
      on: true,
      agent: 'claude',
      nextFirings: [
        '2026-11-09T09:00:00.000Z',
        '2026-11-10T09:00:00.000Z',
        '2026-11-11T09:00:00.000Z',
      ],
    })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await history(client, automation.id)).toEqual([])

    clock = Date.parse('2026-11-09T09:00:10Z')
    const [row] = await waitForHistory(
      client,
      automation.id,
      (rows) => rows[0]?.result.kind === 'no-new-tasks',
      'the firing to finish',
    )
    expect(row).toMatchObject({
      trigger: 'scheduled',
      slotAt: '2026-11-09T09:00:00.000Z',
      message: 'Nothing new',
    })
    const run = await waitUntil(async () => {
      const found = await client.ok<RunWithConversation>('GET', `/runs/${row?.runId}`)
      return found.run.state === 'finished' ? found : undefined
    }, 'TED to stop the finished Run')
    expect(run.run).toMatchObject({ name: 'Sentry crash intake', state: 'finished' })
    expect(run.run.taskId).toBeUndefined()
    expect(run.run.prompt).toContain('# You are an Automation Run in TED')
    expect(run.run.prompt).toContain('## Tasks this Automation has created\n\nNone yet.')
    expect(await said(client, row?.runId ?? '')).toEqual(['Nothing new'])
    const after = (await detail(client, automation.id)).automation
    expect(after.last?.result.kind).toBe('no-new-tasks')
    expect(after.nextFirings[0]).toBe('2026-11-10T09:00:00.000Z')
  })

  test('the shortest interval is 15 minutes and bad schedules are refused', async () => {
    const client = await startTed()
    const tooOften = await client.call('POST', '/automations', {
      name: 'Too often',
      factory: 'NB',
      prompt: 'Look',
      schedule: { kind: 'custom', expression: '*/5 * * * *' },
    })
    expect(tooOften).toMatchObject({
      status: 400,
      body: { error: 'The shortest interval is 15 minutes.' },
    })
    const preview = await client.ok('POST', '/automations/schedule-preview', {
      schedule: { kind: 'custom', expression: '0 9 * * 1-5' },
      timeZone: 'Europe/London',
    })
    expect(preview).toMatchObject({ text: 'Weekdays at 09:00 · Europe/London' })
  })

  test('a firing is skipped while the previous Run works, and starts while it waits on you', async () => {
    const client = await startTed()
    const busy = await create(client, {
      name: 'Busy',
      schedule: { kind: 'every', every: 15, unit: 'minutes' },
      prompt: steps({ say: 'Working' }, hold(), { endTurn: true }),
    })
    const asking = await create(client, {
      name: 'Asking',
      schedule: { kind: 'every', every: 15, unit: 'minutes' },
      prompt: steps(
        { everyMessage: [{ say: 'Got it' }, { endTurn: true }] },
        { run: ['ted', 'comment', '--choice', 'Yes', '--choice', 'No', 'Create NB tasks?'] },
        { endTurn: true },
      ),
    })
    clock = Date.parse('2026-11-09T09:00:05Z')
    await waitUntil(
      async () => (await detail(client, busy.id)).automation.now?.kind === 'working',
      'the busy Run to work',
    )
    await waitUntil(
      async () => (await detail(client, asking.id)).automation.now?.kind === 'waiting',
      'the asking Run to wait on the human',
    )
    const [question] = (await detail(client, asking.id)).requests
    expect(question).toMatchObject({
      kind: 'question',
      body: 'Create NB tasks?',
      choices: ['Yes', 'No'],
    })
    expect((await client.ok<Activity>('GET', '/activity')).waitingOnYou).toBeGreaterThanOrEqual(1)

    clock = Date.parse('2026-11-09T09:15:05Z')
    const busyRows = await waitForHistory(client, busy.id, (rows) => rows.length === 2, 'a skip')
    expect(busyRows[0]).toMatchObject({ trigger: 'scheduled', result: { kind: 'skipped' } })
    const askingRows = await waitForHistory(
      client,
      asking.id,
      (rows) => rows.length === 2 && rows.every((r) => r.result.kind === 'running'),
      'a second Run while the first waits',
    )
    expect(askingRows.map((r) => r.trigger)).toEqual(['scheduled', 'scheduled'])

    await client.ok('POST', `/automation-requests/${question?.id}/answer`, { choice: 'No' })
    const first = askingRows[1]?.runId ?? ''
    await waitUntil(
      async () => (await said(client, first)).includes('Got it'),
      'the answer to reach the Run',
      20_000,
    )
    const answered = await client.ok<RunWithConversation>('GET', `/runs/${first}`)
    expect(answered.conversation.some((e) => e.line.includes('The human answered'))).toBe(true)
    await waitForHistory(
      client,
      asking.id,
      (rows) => rows[1]?.result.kind === 'no-new-tasks',
      'the answered Run to finish',
    )
    await release()
    await waitForHistory(
      client,
      busy.id,
      (rows) => rows[1]?.result.kind === 'no-new-tasks',
      'the busy Run to finish',
    )
  })

  test('missed firings are made up once when TED starts again', async () => {
    let client = await startTed()
    const automation = await create(client, {
      schedule: { kind: 'every', every: 15, unit: 'minutes' },
    })
    await daemon?.stop()
    daemon = undefined
    clock = Date.parse('2026-11-09T10:20:00Z')
    client = await startTed({ addFactory: false })
    const rows = await waitForHistory(
      client,
      automation.id,
      (r) => r[0]?.result.kind === 'no-new-tasks',
      'the made-up firing',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ trigger: 'made-up', slotAt: '2026-11-09T10:15:00.000Z' })
  })

  test('an Automation Run creates Tasks from sources, never twice, and sees them next time', async () => {
    const client = await startTed()
    const url = 'https://acme.sentry.io/issues/4242/'
    const automation = await create(client, {
      prompt: steps(
        { run: ['ted', 'task', 'create', '--source', url, 'Crash in parser'] },
        { run: ['ted', 'task', 'create', '--source', `${url}?project=7`, 'Crash again'] },
        {
          run: ['ted', 'task', 'create', '--factory', 'XX', '--source', 'https://x.io/1', 'Else'],
        },
        { run: ['ted', 'automation', 'list'] },
        { run: ['ted', 'automation', 'disable', 'Sentry crash intake'] },
        { endTurn: true },
      ),
    })
    clock = Date.parse('2026-11-09T09:00:05Z')
    const [row] = await waitForHistory(
      client,
      automation.id,
      (rows) => rows[0]?.result.kind === 'created',
      'the Run to create a Task',
    )
    const tasks = await client.ok<Task[]>('GET', '/tasks')
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      displayId: 'NB-1',
      title: 'Crash in parser',
      stage: 'backlog',
      createdBy: 'automation',
      source: { url },
    })
    expect(row?.result).toMatchObject({ kind: 'created', tasks: [{ displayId: 'NB-1' }] })
    expect(row?.created).toMatchObject([{ displayId: 'NB-1' }])
    const results = await commandResults(client, row?.runId ?? '')
    expect(results[0]).toMatchObject({ code: 0, stdout: 'Created NB-1  Crash in parser\n' })
    expect(results[1]).toMatchObject({
      code: 1,
      stderr: 'ted: Already tracked as NB-1 · Backlog\n',
    })
    expect(results[2]?.stderr).toBe(
      'ted: this Automation creates Tasks only in NB, its own Factory\n',
    )
    expect(results[3]?.code).toBe(0)
    expect(results[3]?.stdout).toContain('Sentry crash intake')
    expect(results[4]).toMatchObject({
      code: 1,
      stderr: 'ted: Ask the human to change Automations\n',
    })
    expect((await detail(client, automation.id)).automation.on).toBe(true)

    clock = Date.parse('2026-11-10T09:00:05Z')
    const rows = await waitForHistory(
      client,
      automation.id,
      (r) => r.length === 2 && r[0]?.runId !== undefined,
      'a second Run',
    )
    const next = await client.ok<RunWithConversation>('GET', `/runs/${rows[0]?.runId}`)
    expect(next.run.prompt).toContain(`- NB-1 · Crash in parser · open, in Backlog · source ${url}`)
  })

  test('a Task Lead can’t create Tasks with ted task create', async () => {
    const client = await startTed()
    const task = await client.ok<Task>('POST', '/tasks', {
      factory: 'NB',
      start: true,
      title: steps({ run: ['ted', 'task', 'create', 'Sneaky'] }, { endTurn: true }),
    })
    const lead = await waitUntil(async () => {
      const found = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === task.id)
      return found?.leadRunId
    }, 'the Task Lead to start')
    const [result] = await waitUntil(async () => {
      const found = await commandResults(client, lead)
      return found.length > 0 ? found : undefined
    }, 'the command to run')
    expect(result?.stderr).toMatch(/^ted: Only an Automation Run creates Tasks/)
  })

  test('a failed Run is resumed once, then fails with Retry; three failures in a row raise a banner', async () => {
    const client = await startTed()
    await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ resumeFails: true }))
    const automation = await create(client, {
      schedule: { kind: 'every', every: 15, unit: 'minutes' },
      prompt: steps({ say: 'Starting' }, { exit: 3 }),
    })
    for (const [i, at] of ['09:00:05', '09:15:05', '09:30:05'].entries()) {
      clock = Date.parse(`2026-11-09T${at}Z`)
      await waitForHistory(
        client,
        automation.id,
        (rows) => rows.length === i + 1 && rows[0]?.result.kind === 'failed',
        `failure ${i + 1}`,
      )
    }
    const rows = await history(client, automation.id)
    const resumes = (await readStarts()).filter((s) => s.argv.includes('--resume'))
    expect(resumes).toHaveLength(3)
    expect((await detail(client, automation.id)).automation.failuresInARow).toBe(3)
    const banners = await client.ok<Banner[]>('GET', '/banners')
    expect(banners.find((b) => b.problem === 'automation-failing')).toMatchObject({
      severity: 'warning',
      text: expect.stringMatching(
        /^Automation “Sentry crash intake” failed 3 times in a row · last error: .+/,
      ),
      action: {
        label: 'Open the Automation',
        opens: { kind: 'automation', automationId: automation.id, factoryId: automation.factoryId },
      },
    })

    const older = await client.call('POST', `/automation-runs/${rows[1]?.id}/retry`, {})
    expect(older.status).toBe(409)
    clock = Date.parse('2026-11-09T09:31:00Z')
    const retry = await client.ok<AutomationRun>(
      'POST',
      `/automation-runs/${rows[0]?.id}/retry`,
      {},
    )
    expect(retry.trigger).toBe('retry')
    const after = await waitForHistory(
      client,
      automation.id,
      (r) => r.length === 4 && r[0]?.result.kind === 'failed',
      'the retry to fail',
    )
    expect(after[1]?.retriedAt).toBeDefined()
    expect(after[0]?.retryOf).toBe(rows[0]?.id)
  })

  test('a full disk holds firings, and held firings are made up once', async () => {
    const client = await startTed()
    const automation = await create(client, {
      schedule: { kind: 'every', every: 15, unit: 'minutes' },
    })
    free = 1e9
    await waitUntil(
      async () =>
        (await client.ok<Banner[]>('GET', '/banners')).some((b) => b.problem === 'disk-full'),
      'the disk-full hold',
    )
    clock = Date.parse('2026-11-09T09:40:00Z')
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(await history(client, automation.id)).toEqual([])
    const refused = await client.call('POST', `/automations/${automation.id}/run`, {})
    expect(refused.status).toBe(409)
    free = 500e9
    const rows = await waitForHistory(
      client,
      automation.id,
      (r) => r[0]?.result.kind === 'no-new-tasks',
      'the made-up firing',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ trigger: 'made-up', slotAt: '2026-11-09T09:30:00.000Z' })
  })

  test('Automation Runs wait as Queued for a slot, ahead of Tasks', async () => {
    const client = await startTed()
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
    const busy = await client.ok<Task>('POST', '/tasks', {
      factory: 'NB',
      start: true,
      title: steps(hold(), { endTurn: true }),
    })
    await waitUntil(async () => {
      const found = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === busy.id)
      return found?.leadRunId
    }, 'the Task to hold the slot')
    const automation = await create(client, {})
    await client.ok<Task>('POST', '/tasks', { factory: 'NB', start: true, title: 'Second' })
    clock = Date.parse('2026-11-09T09:00:05Z')
    await waitUntil(
      async () => (await detail(client, automation.id)).automation.now?.kind === 'queued',
      'the firing to queue',
    )
    const slots = await client.ok<RunSlots>('GET', '/slots')
    expect(slots.queue.map((q) => q.kind)).toEqual(['automation', 'task'])
    expect((await detail(client, automation.id)).automation.now).toEqual({
      kind: 'queued',
      place: 1,
    })
    await release()
    await waitForHistory(
      client,
      automation.id,
      (rows) => rows[0]?.result.kind === 'no-new-tasks',
      'the queued Run to run',
    )
  })

  test('turning an Automation off lets its open Run finish and stops further firings', async () => {
    const client = await startTed()
    const automation = await create(client, {
      schedule: { kind: 'every', every: 15, unit: 'minutes' },
      prompt: steps(hold(), { say: 'Done at last' }, { endTurn: true }),
    })
    expect((await client.ok<Activity>('GET', '/activity')).automationsOn).toBe(1)
    clock = Date.parse('2026-11-09T09:00:05Z')
    await waitUntil(
      async () => (await detail(client, automation.id)).automation.now?.kind === 'working',
      'the Run to work',
    )
    const off = await client.ok<Automation>('POST', `/automations/${automation.id}/disable`, {})
    expect(off).toMatchObject({ on: false, nextFirings: [] })
    expect((await client.ok<Activity>('GET', '/activity')).automationsOn).toBe(0)
    clock = Date.parse('2026-11-09T09:45:05Z')
    await release()
    const rows = await waitForHistory(
      client,
      automation.id,
      (r) => r[0]?.result.kind === 'no-new-tasks',
      'the open Run to finish',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.message).toBe('Done at last')
    await client.ok('DELETE', `/automations/${automation.id}`)
    expect(await client.ok<Automation[]>('GET', '/automations')).toEqual([])
  })
})

test('removing a Factory deletes its Automations and stops their Runs', async () => {
  const client = await startTed()
  const automation = await create(client, { prompt: steps(hold(), { endTurn: true }) })
  clock = Date.parse('2026-11-09T09:00:05Z')
  const [row] = await waitForHistory(
    client,
    automation.id,
    (rows) => rows[0]?.runId !== undefined,
    'the Run to start',
  )
  const [factory] = await client.ok<Factory[]>('GET', '/factories')
  await client.ok('POST', `/factories/${factory?.id}/remove`, { key: 'NB' })
  expect(await client.ok<Automation[]>('GET', '/automations')).toEqual([])
  expect((await client.ok<Activity>('GET', '/activity')).automationsOn).toBe(0)
  await waitUntil(async () => {
    const run = await client.ok<RunWithConversation>('GET', `/runs/${row?.runId}`)
    return run.run.state === 'finished'
  }, 'the Run to stop')
})

test('an Automation that is on keeps a daemon started by ted from exiting when idle', async () => {
  let idled = 0
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    idleExit: { afterMs: 300, onIdle: () => idled++ },
    automations: { now: () => clock, checkEveryMs: 50 },
  })
  const client = api(daemon.port, { appKey: daemon.appToken })
  await client.call('POST', '/dev/factories', {
    repo: path.join(scratch, 'acme', 'widgets.git'),
    key: 'NB',
  })
  const created = await client.call('POST', '/automations', {
    name: 'Nightly',
    factory: 'NB',
    prompt: 'Look',
    schedule: { kind: 'daily', at: '02:00' },
  })
  idled = 0
  await new Promise((resolve) => setTimeout(resolve, 800))
  expect(idled).toBe(0)
  await client.call('POST', `/automations/${created.body.id}/disable`, {})
  await waitUntil(() => idled > 0, 'the idle exit once the Automation is off')
})

interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

async function commandResults(client: Client, runId: string): Promise<CommandResult[]> {
  return (await said(client, runId)).flatMap((text) => {
    try {
      const parsed = JSON.parse(text) as CommandResult
      return typeof parsed.code === 'number' ? [parsed] : []
    } catch {
      return []
    }
  })
}

async function readStarts(): Promise<{ argv: string[] }[]> {
  const dir = path.join(home, 'automations')
  const starts: { argv: string[] }[] = []
  for (const name of await readdir(dir).catch(() => [])) {
    const text = await readFile(path.join(dir, name, 'stub-starts.jsonl'), 'utf8').catch(() => '')
    for (const line of text.split('\n').filter(Boolean)) starts.push(JSON.parse(line))
  }
  return starts
}
