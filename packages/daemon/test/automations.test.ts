import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type {
  Activity,
  Automation,
  AutomationDetail,
  AutomationRun,
  AutomationTemplate,
  Banner,
  Factory,
  RunSlots,
  RunWithConversation,
  Task,
  WaitingRequest,
} from '@ted/protocol'
import { tedPaths } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { Clock } from '../src/clock.ts'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { openStore } from '../src/store/index.ts'
import { stubKeyring, stubKeyringFile } from './fixtures/stub-keyring.ts'
import { startStubLinear } from './fixtures/stub-linear.ts'
import {
  api,
  assistantTexts,
  commitToOrigin,
  devRunToken,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  stubCodexPath,
  tokenFor,
  waitUntil,
} from './helpers.ts'
import { eventWait } from './support/event-wait.ts'
import { ManualClock } from './support/manual-clock.ts'

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

async function startTed(
  options: {
    timers?: Clock
    addFactory?: boolean
    resetSettings?: boolean
    systemTimeZone?: () => string
    linear?: Parameters<typeof startDaemon>[0]['linear']
  } = {},
) {
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    codexBin: stubCodexPath,
    automations: {
      ...(options.timers && { clock: options.timers }),
      now: () => clock,
      checkEveryMs: 50,
      ...(options.systemTimeZone && { systemTimeZone: options.systemTimeZone }),
    },
    disk: { freeBytes: async () => free, checkEveryMs: 50 },
    ...(options.linear && { linear: options.linear }),
  })
  const client = api(daemon.port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  if (options.resetSettings !== false)
    await ok('PATCH', '/settings', { timeFormat: '24-hour', timeZone: 'Europe/London' })
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
  eventWait(
    client.subscribe,
    async () => {
      const rows = await history(client, id)
      return check(rows) ? rows : undefined
    },
    what,
    20_000,
  )

const said = async (client: Client, runId: string) =>
  assistantTexts((await client.ok<RunWithConversation>('GET', `/runs/${runId}`)).conversation)

describe('app-wide Automation time zone', () => {
  test('a zone change preserves clock times and queued Runs, without catch-up after restart', async () => {
    const client = await startTed()
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
    const working = await create(client, {
      name: 'Held Run',
      schedule: { kind: 'every', every: 15, unit: 'minutes' },
      prompt: steps(hold()),
    })
    clock = Date.parse('2026-11-09T09:00:05Z')
    const [held] = await waitForHistory(
      client,
      working.id,
      (rows) => rows.some((r) => r.result.kind === 'running'),
      'the held Run',
    )
    const queued = await create(client, {
      name: 'Queued daily',
      schedule: { kind: 'daily', at: '09:15' },
    })
    clock = Date.parse('2026-11-09T09:15:05Z')
    const [waiting] = await waitForHistory(
      client,
      queued.id,
      (rows) => rows.some((r) => r.result.kind === 'queued'),
      'the queued daily firing',
    )
    await client.ok('PATCH', '/settings', { timeZone: 'America/New_York' })
    const changed = await detail(client, queued.id)
    expect(changed.automation.schedule).toEqual({ kind: 'daily', at: '09:15' })
    expect(changed.automation.nextFirings[0]).toBe('2026-11-09T14:15:00.000Z')
    expect(changed.history).toHaveLength(1)
    expect(changed.history[0]).toMatchObject({
      id: waiting?.id,
      slotAt: '2026-11-09T09:15:00.000Z',
      result: { kind: 'queued' },
    })
    expect((await history(client, working.id)).find((r) => r.id === held?.id)?.result.kind).toBe(
      'running',
    )
    await daemon?.stop()
    const reopened = await startTed({ addFactory: false, resetSettings: false })
    expect((await detail(reopened, queued.id)).automation.nextFirings[0]).toBe(
      '2026-11-09T14:15:00.000Z',
    )
    expect(await history(reopened, queued.id)).toHaveLength(1)
  })

  test('preview and creation ignore stale per-Automation overrides and use app settings', async () => {
    const client = await startTed()
    await client.ok('PATCH', '/settings', { timeZone: 'Asia/Tokyo', timeFormat: '12-hour' })
    const automation = await create(client, { timeZone: 'Europe/London' })
    const preview = await client.ok<{ text: string; nextFirings: string[] }>(
      'POST',
      '/automations/schedule-preview',
      { schedule: automation.schedule, timeZone: 'UTC' },
    )
    expect(automation.timeZone).toBe('Asia/Tokyo')
    expect(preview.text).toBe('Daily at 9:00 AM · Asia/Tokyo')
    expect(preview.nextFirings).toEqual(automation.nextFirings)
    await client.ok('PATCH', `/automations/${automation.id}`, {
      timeZone: 'Europe/London',
      name: 'Renamed',
    })
    expect((await detail(client, automation.id)).automation.timeZone).toBe('Asia/Tokyo')
  })

  test('legacy zones are adopted before scheduling and format-only changes retain missed firings', async () => {
    const client = await startTed()
    const automation = await create(client, {})
    await daemon?.stop()
    const store = await openStore({ directory: tedPaths(home).store })
    const legacy = store.automations.get(automation.id)
    if (!legacy) throw new Error('missing Automation')
    store.automations.edit(
      legacy.id,
      { ...legacy, timeZone: 'America/New_York' },
      new Date(clock).toISOString(),
    )
    await store.close()
    clock = Date.parse('2026-11-09T10:00:00Z')
    const reopened = await startTed({ addFactory: false, resetSettings: false })
    const adopted = await detail(reopened, automation.id)
    expect(adopted.automation.timeZone).toBe('Europe/London')
    expect(adopted.automation.nextFirings[0]).toBe('2026-11-10T09:00:00.000Z')
    expect(adopted.history).toHaveLength(0)
    clock = Date.parse('2026-11-10T08:55:00Z')
    await reopened.ok('PATCH', '/settings', { timeFormat: '12-hour' })
    await daemon?.stop()
    clock = Date.parse('2026-11-10T10:00:00Z')
    const third = await startTed({ addFactory: false, resetSettings: false })
    const [missed] = await waitForHistory(
      third,
      automation.id,
      (rows) => rows.length > 0,
      'the ordinary missed firing',
    )
    expect(missed).toMatchObject({ trigger: 'made-up', slotAt: '2026-11-10T09:00:00.000Z' })
  })

  test('system-zone changes recalculate future firings without catch-up', async () => {
    let zone = 'Europe/London'
    const client = await startTed({ systemTimeZone: () => zone })
    await client.ok('PATCH', '/settings', { timeZone: 'system' })
    const automation = await create(client, {})
    zone = 'Asia/Tokyo'
    const changed = await detail(client, automation.id)
    expect(changed.automation.nextFirings[0]).toBe('2026-11-10T00:00:00.000Z')
    expect(changed.history).toHaveLength(0)
    await client.ok('PATCH', '/settings', { timeZone: 'UTC' })
    zone = 'America/New_York'
    expect((await detail(client, automation.id)).automation.nextFirings[0]).toBe(
      '2026-11-09T09:00:00.000Z',
    )
  })
})

describe('Automations', () => {
  test('an Automation fires at its clock time in the app-wide time zone and the Run finishes', async () => {
    const timers = new ManualClock()
    const client = await startTed({ timers })
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
    timers.advance(300)
    expect(await history(client, automation.id)).toEqual([])

    clock = Date.parse('2026-11-09T09:00:10Z')
    timers.advance(50)
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
    expect(run.run.prompt).toContain('## Write clearly for the user')
    expect(run.run.prompt).toContain('## Tasks this Automation has created\n\nNone yet.')
    expect(await said(client, row?.runId ?? '')).toEqual(['Nothing new'])
    const after = (await detail(client, automation.id)).automation
    expect(after.last?.result.kind).toBe('no-new-tasks')
    expect(after.nextFirings[0]).toBe('2026-11-10T09:00:00.000Z')
  })

  test('weekly architecture reviews queue and create distinct, deduplicated Backlog Tasks; the Run can list Automations but not change them, and the next Run sees the Tasks', async () => {
    const client = await startTed()
    const templates = await client.ok<AutomationTemplate[]>('GET', '/automations/templates')
    const template = templates.find((t) => t.id === 'architecture')
    if (!template) throw new Error('missing architecture template')
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
    const blocker = await create(client, {
      name: 'Holding the slot',
      on: false,
      prompt: steps(hold(), { endTurn: true }),
    })
    await client.ok('POST', `/automations/${blocker.id}/run`)
    await waitUntil(
      async () => (await detail(client, blocker.id)).automation.now?.kind === 'working',
      'the slot holder',
    )
    const source = 'https://github.com/acme/widgets/tree/main/src/parser'
    const other = 'https://github.com/acme/widgets/blob/main/src/queue.ts'
    const automation = await create(client, {
      template: template.id,
      name: template.name,
      schedule: template.schedule,
      prompt: `${template.prompt}\n${steps(
        {
          run: [
            'ted',
            'task',
            'create',
            '--source',
            source,
            '--description',
            'Evidence at abc123; verify through the parser API.',
            'Deepen the parser boundary',
          ],
        },
        {
          run: [
            'ted',
            'task',
            'create',
            '--source',
            `${source}?scan=2#finding`,
            'Duplicate parser finding',
          ],
        },
        { run: ['ted', 'task', 'create', '--source', other, 'Concentrate queue ownership'] },
        { run: ['ted', 'task', 'create', '--factory', 'XX', '--source', other, 'Wrong Factory'] },
        { run: ['ted', 'automation', 'list'] },
        { run: ['ted', 'automation', 'disable', template.name] },
        { endTurn: true },
      )}`,
    })
    expect(automation).toMatchObject({
      template: 'architecture',
      nextFirings: [
        '2026-11-09T09:00:00.000Z',
        '2026-11-16T09:00:00.000Z',
        '2026-11-23T09:00:00.000Z',
      ],
    })
    clock = Date.parse('2026-11-09T09:00:05Z')
    await waitForHistory(
      client,
      automation.id,
      (rows) => rows[0]?.result.kind === 'queued',
      'the architecture review to queue',
    )
    expect(await client.ok<Task[]>('GET', '/tasks')).toEqual([])
    await release()
    const [row] = await waitForHistory(
      client,
      automation.id,
      (rows) => rows[0]?.result.kind === 'created',
      'the architecture review to finish',
    )
    const tasks = await client.ok<Task[]>('GET', '/tasks')
    expect(tasks).toHaveLength(2)
    expect(tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'Deepen the parser boundary',
          description: 'Evidence at abc123; verify through the parser API.',
          source: expect.objectContaining({ url: source }),
        }),
        expect.objectContaining({
          title: 'Concentrate queue ownership',
          source: expect.objectContaining({ url: other }),
        }),
      ]),
    )
    for (const task of tasks) {
      expect(task).toMatchObject({
        stage: 'backlog',
        createdBy: 'automation',
        factoryId: automation.factoryId,
      })
      expect(task.leadRunId).toBeUndefined()
    }
    expect(
      tasks.find((t) => t.displayId === 'NB-1'),
      'the first Task',
    ).toMatchObject({
      title: 'Deepen the parser boundary',
      stage: 'backlog',
      createdBy: 'automation',
      source: { url: source },
    })
    expect(row?.result).toMatchObject({ kind: 'created', tasks: expect.any(Array) })
    expect(row?.created).toHaveLength(2)
    const createdIds = (list: { displayId: string }[] | undefined) =>
      (list ?? []).map((t) => t.displayId).sort()
    expect(
      createdIds(row?.result.kind === 'created' ? row.result.tasks : undefined),
      'the Run’s result',
    ).toEqual(['NB-1', 'NB-2'])
    expect(createdIds(row?.created), 'the Run’s created Tasks').toEqual(['NB-1', 'NB-2'])
    const results = await commandResults(client, row?.runId ?? '')
    expect(results.map((r) => r.code)).toEqual([0, 1, 0, 1, 0, 1])
    expect(results[0], 'the first create').toMatchObject({
      code: 0,
      stdout: 'Created NB-1  Deepen the parser boundary\n',
    })
    expect(results[1], 'a source already tracked').toMatchObject({
      code: 1,
      stderr: 'ted: Already tracked as NB-1 · Backlog\n',
    })
    expect(results[3]?.stderr, 'another Factory').toBe(
      'ted: this Automation creates Tasks only in NB, its own Factory\n',
    )
    expect(results[4]?.code, 'automation list').toBe(0)
    expect(results[4]?.stdout, 'automation list').toContain(template.name)
    expect(results[5], 'automation disable').toMatchObject({
      code: 1,
      stderr: 'ted: Ask the human to change Automations\n',
    })
    expect((await detail(client, automation.id)).automation.on, 'still on').toBe(true)
    const run = await client.ok<RunWithConversation>('GET', `/runs/${row?.runId}`)
    expect(run.run.prompt).toContain(template.prompt)

    clock = Date.parse('2026-11-16T09:00:05Z')
    const [next] = await waitForHistory(
      client,
      automation.id,
      (rows) => rows.length === 2 && rows[0]?.result.kind === 'no-new-tasks',
      'the repeat review to skip existing sources',
    )
    expect(await client.ok<Task[]>('GET', '/tasks')).toHaveLength(2)
    const repeated = await client.ok<RunWithConversation>('GET', `/runs/${next?.runId}`)
    expect(repeated.run.prompt, 'the next Run’s prompt').toContain(
      `- NB-1 · Deepen the parser boundary · open, in Backlog · source ${source}`,
    )
    expect(repeated.run.prompt, 'the next Run’s prompt').toContain(
      `- NB-2 · Concentrate queue ownership · open, in Backlog · source ${other}`,
    )
  })

  test('an edit sending null for model or effort clears it back to the default', async () => {
    const client = await startTed()
    const automation = await create(client, { model: 'sonnet', effort: 'high', on: false })
    const cleared = await client.ok<Automation>('PATCH', `/automations/${automation.id}`, {
      model: null,
      effort: null,
    })
    expect(cleared.model).toBeUndefined()
    expect(cleared.effort).toBeUndefined()
    const kept = await client.ok<Automation>('PATCH', `/automations/${automation.id}`, {
      effort: 'low',
    })
    expect(kept).toMatchObject({ effort: 'low' })
    expect(kept.model).toBeUndefined()
  })

  test('a Run token can only read Automations, and the file token can only read, preview and turn off', async () => {
    const client = await startTed()
    const automation = await create(client, { on: true })
    const id = automation.id
    const changes: [string, string, unknown?][] = [
      [
        'POST',
        '/automations',
        {
          name: 'Mine',
          factory: 'NB',
          prompt: 'x',
          schedule: { kind: 'daily', at: '09:00' },
        },
      ],
      ['PATCH', `/automations/${id}`, { name: 'Renamed' }],
      ['POST', `/automations/${id}/enable`],
      ['POST', `/automations/${id}/disable`],
      ['POST', `/automations/${id}/run`],
      ['POST', '/automation-runs/firing-1/retry'],
      ['DELETE', `/automations/${id}`],
    ]
    const asRun = api(
      daemon?.port ?? 0,
      await devRunToken(home, daemon?.port ?? 0, daemon?.appToken ?? ''),
    )
    for (const [method, route, body] of changes) {
      expect(await asRun.call(method, route, body), `${method} ${route}`).toEqual({
        status: 403,
        body: { error: 'Ask the human to change Automations' },
      })
    }
    const asFile = api(daemon?.port ?? 0, await tokenFor(home))
    for (const [method, route, body] of changes.filter(([, r]) => !r.endsWith('/disable'))) {
      expect(await asFile.call(method, route, body), `${method} ${route}`).toEqual({
        status: 403,
        body: { error: 'only the TED app can do this' },
      })
    }
    expect((await detail(client, id)).automation).toMatchObject({ name: automation.name, on: true })
    expect(
      await asFile.call('POST', '/automations/schedule-preview', {
        schedule: { kind: 'daily', at: '09:00' },
        timeZone: 'Europe/London',
      }),
    ).toMatchObject({ status: 200 })
    expect(await asFile.call('POST', `/automations/${id}/disable`)).toMatchObject({
      status: 200,
      body: { on: false },
    })
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
    expect(await client.ok<WaitingRequest[]>('GET', '/inbox/waiting')).toEqual([
      expect.objectContaining({
        source: 'automation',
        id: question?.id,
        automationId: asking.id,
        headline: 'Create NB tasks?',
      }),
    ])

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

  test('an answer given before the asking turn ends still reaches the Run', async () => {
    const client = await startTed()
    const turnEnds = path.join(scratch, 'turn-ends')
    const readsAnswer = path.join(scratch, 'reads-answer')
    const automation = await create(client, {
      name: 'Asking',
      schedule: { kind: 'every', every: 15, unit: 'minutes' },
      prompt: steps(
        { everyMessage: [{ say: 'Got it' }, { endTurn: true }] },
        { run: ['ted', 'comment', '--choice', 'Yes', '--choice', 'No', 'Create NB tasks?'] },
        { readNextAfter: readsAnswer },
        { waitFor: turnEnds },
        { endTurn: true },
      ),
    })
    clock = Date.parse('2026-11-09T09:00:05Z')
    const question = await waitUntil(
      async () => (await detail(client, automation.id)).requests[0],
      'the question',
    )
    const runId = question.runId ?? ''
    const run = async () => (await client.ok<RunWithConversation>('GET', `/runs/${runId}`)).run
    expect((await run()).state).toBe('working')
    await client.ok('POST', `/automation-requests/${question.id}/answer`, { choice: 'No' })
    await writeFile(turnEnds, '')
    await waitUntil(async () => (await run()).state !== 'working', 'the asking turn to end')
    await writeFile(readsAnswer, '')
    await waitUntil(
      async () => (await said(client, runId)).includes('Got it'),
      'the answer to reach the Run',
      20_000,
    )
    await waitForHistory(
      client,
      automation.id,
      (rows) => rows[0]?.result.kind === 'no-new-tasks',
      'the answered Run to finish',
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

  test('an Automation imports Linear issues through the CLI', async () => {
    const key = 'lin_api_abcdefghijklmnopqrstuvwxyz0123456789ABCD'
    const url = 'https://linear.app/acme/issue/NB-42/search'
    const linear = await startStubLinear({
      [key]: {
        name: 'Nabha',
        workspace: { name: 'Acme', urlKey: 'acme' },
        issues: [{ identifier: 'NB-42', title: 'Search', description: 'Fix search', priority: 2 }],
      },
    })
    const image = linear.uploadUrl('acme/1/2')
    linear.uploads.set('/uploads/acme/1/2', {
      body: Buffer.from('GIF89a tiny'),
      contentType: 'image/gif',
    })
    const issue = linear.accounts.get(key)?.issues?.[0]
    if (issue) issue.description = `Fix search\n\n![results](${image})`
    try {
      await writeFile(stubKeyringFile(home), JSON.stringify({ secret: key }))
      const client = await startTed({
        linear: { apiUrl: linear.url, keyring: stubKeyring(stubKeyringFile(home)) },
      })
      const automation = await create(client, {
        name: 'Pull new Linear issues assigned to me',
        agent: 'codex',
        prompt: steps(
          { run: ['ted', 'task', 'create', '--source', url, 'Search'] },
          { run: ['ted', 'task', 'create', '--source', url, 'Duplicate'] },
          { run: ['ted', 'task', 'create', '--factory', 'XX', '--source', url, 'Else'] },
          { endTurn: true },
        ),
      })
      clock = Date.parse('2026-11-09T09:00:05Z')
      const [row] = await waitForHistory(
        client,
        automation.id,
        (rows) => rows[0]?.result.kind === 'created' || rows[0]?.result.kind === 'no-new-tasks',
        'the Linear import to finish',
      )
      const results = await commandResults(client, row?.runId ?? '')
      expect(results[0]).toMatchObject({ code: 0, stdout: 'Created NB-1  Search\n', stderr: '' })
      expect(results[1]).toMatchObject({
        code: 1,
        stderr: 'ted: Already tracked as NB-1 · Backlog\n',
      })
      expect(results[2]?.stderr).toBe(
        'ted: this Automation creates Tasks only in NB, its own Factory\n',
      )
      const tasks = await client.ok<Task[]>('GET', '/tasks')
      expect(tasks).toHaveLength(1)
      expect(tasks[0]).toMatchObject({
        stage: 'backlog',
        createdBy: 'automation',
        priority: 'high',
        source: { url, linear: { identifier: 'NB-42' } },
        attachments: [expect.objectContaining({ name: 'results.gif', mediaType: 'image/gif' })],
      })
      expect(tasks[0]?.source?.linear?.description).toBe(
        `Fix search\n\n![results](${path.join(tedPaths(home).attachments, `${tasks[0]?.attachments[0]?.hash}.gif`)})`,
      )
      expect(row?.result.kind).toBe('created')
    } finally {
      await linear.close()
    }
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
    const timers = new ManualClock()
    const client = await startTed({ timers })
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
    timers.advance(400)
    expect(await history(client, automation.id)).toEqual([])
    const refused = await client.call('POST', `/automations/${automation.id}/run`, {})
    expect(refused.status).toBe(409)
    free = 500e9
    await eventWait(
      client.subscribe,
      async () =>
        !(await client.ok<Banner[]>('GET', '/banners')).some((b) => b.problem === 'disk-full'),
      'the disk-full hold to clear',
    )
    timers.advance(50)
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

test('Automation Runs use auto permissions even when the Factory is set to bypass', async () => {
  await commitToOrigin(scratch, { '.ted/workflow.yaml': 'version: 1\npermissions: bypass\n' })
  const client = await startTed()
  const [factory] = await client.ok<Factory[]>('GET', '/factories')
  await client.ok('PUT', `/factories/${factory?.id}/permissions`, {
    mode: 'bypass',
    confirmBypass: true,
  })
  for (const agent of ['claude', 'codex'] as const) {
    const automation = await create(client, { name: `Intake ${agent}`, agent })
    await client.ok('POST', `/automations/${automation.id}/run`)
    const [row] = await waitForHistory(
      client,
      automation.id,
      (rows) => rows[0]?.runId !== undefined,
      'the Run to start',
    )
    const { run } = await client.ok<RunWithConversation>('GET', `/runs/${row?.runId}`)
    expect(run.permissions).toBe('auto')
    const { argv } = await waitUntil(
      () =>
        readFile(path.join(run.cwd, 'stub-record.json'), 'utf8')
          .then((s) => JSON.parse(s) as { argv: string[] })
          .catch(() => undefined),
      `the ${agent} stub to start`,
    )
    if (agent === 'claude') {
      expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('auto')
    } else {
      expect(argv).toEqual(
        expect.arrayContaining(['sandbox_mode="workspace-write"', 'approval_policy="on-request"']),
      )
      expect(argv.join(' ')).not.toContain('danger-full-access')
    }
  }
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
  const timers = new ManualClock()
  let idled = 0
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    clock: timers,
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
  timers.advance(800)
  expect(idled).toBe(0)
  await client.call('POST', `/automations/${created.body.id}/disable`, {})
  timers.advance(300)
  expect(idled).toBe(1)
})

describe('Tasks an Automation Run starts', () => {
  const advance = ['ted', 'outcome', 'advance']
  const getTask = async (client: Client, id: string) => {
    const task = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === id)
    if (!task) throw new Error(`no Task ${id}`)
    return task
  }
  const waitForTask = (client: Client, id: string, check: (t: Task) => boolean, what: string) =>
    waitUntil(
      async () => {
        const task = await getTask(client, id)
        return check(task) ? task : undefined
      },
      what,
      20_000,
    )

  async function doneTask(client: Client, source?: string) {
    const gate = path.join(scratch, 'gate')
    const task = await client.ok<Task>('POST', '/tasks', {
      ...(source && { source }),
      factory: 'NB',
      start: true,
      title: steps(
        { run: ['sh', '-c', 'printf "Goal: export notes\\n" | ted brief write'] },
        { waitFor: gate },
        { everyMessage: [{ run: advance }] },
        { run: advance },
      ),
    })
    await waitForTask(client, task.id, (t) => t.leadRunId !== undefined, 'the Task to start')
    await writeFile(gate, '')
    return waitForTask(
      client,
      task.id,
      (t) => t.stage === 'done' && t.repos.every((r) => r.removed),
      'the Task to reach Done',
    )
  }

  async function fire(client: Client, done: Task, mode: string) {
    const titles = { created: `Fix the crash (${mode})`, followUp: `Fix it again (${mode})` }
    const automation = await create(client, {
      name: `Sentry crash intake (${mode})`,
      prompt: steps(
        { run: ['ted', 'task', 'create', '--start', titles.created] },
        { run: ['ted', 'task', 'create', '--follow-up', done.displayId, titles.followUp] },
        { endTurn: true },
      ),
    })
    await client.ok('POST', `/automations/${automation.id}/run`)
    const [row] = await waitForHistory(
      client,
      automation.id,
      (rows) => rows[0]?.result.kind === 'created' && rows[0].result.tasks.length === 2,
      'the Run to create two Tasks',
    )
    const results = await commandResults(client, row?.runId ?? '')
    expect(
      results.map((r) => r.code),
      mode,
    ).toEqual([0, 0])
    const tasks = await client.ok<Task[]>('GET', '/tasks')
    const created = tasks.find((t) => t.title === titles.created)
    const followUp = tasks.find((t) => t.title === titles.followUp)
    if (!created || !followUp) throw new Error('the Tasks weren’t created')
    return { automation, created, followUp }
  }

  test('Factory Linear intake scope applies to a Follow-up’s inherited source', async () => {
    await commitToOrigin(scratch, {
      '.ted/workflow.yaml': 'version: 1\npermissions: bypass\norder: [intake, work, merge]\n',
    })
    const client = await startTed()
    const done = await doneTask(client, 'https://linear.app/acme/issue/NB-50')
    await client.ok('PATCH', '/settings', {
      linearIntakeScopes: {
        [done.factoryId]: {
          kind: 'project',
          id: 'project-one',
          name: 'One',
          workspace: 'acme',
          workspaceId: 'workspace-acme',
        },
      },
    })
    const automation = await create(client, {
      on: false,
      prompt: steps(
        { run: ['ted', 'task', 'create', '--follow-up', done.displayId, 'Retry'] },
        { endTurn: true },
      ),
    })
    await client.ok('POST', `/automations/${automation.id}/run`)
    const [row] = await waitForHistory(
      client,
      automation.id,
      (rows) => rows[0]?.result.kind === 'no-new-tasks',
      'Follow-up scope refusal',
    )
    const [result] = await commandResults(client, row?.runId ?? '')
    expect(result?.code).toBe(1)
    expect(result?.stderr).toContain('Couldn’t verify Linear intake scope')
    expect(await client.ok<Task[]>('GET', '/tasks')).toHaveLength(1)
    expect((await getTask(client, done.id)).stage).toBe('done')
  })

  test('in a Bypass Factory they stay in Backlog for the human to start; back in Auto, --start and a Follow-up start at once', async () => {
    await commitToOrigin(scratch, {
      '.ted/workflow.yaml': 'version: 1\npermissions: bypass\norder: [intake, work, merge]\n',
    })
    const client = await startTed()
    const [factory] = await client.ok<Factory[]>('GET', '/factories')
    await client.ok('PUT', `/factories/${factory?.id}/permissions`, {
      mode: 'bypass',
      confirmBypass: true,
    })
    const done = await doneTask(client)
    const held = await fire(client, done, 'Bypass')
    for (const task of [held.created, held.followUp]) {
      const now = await getTask(client, task.id)
      expect(now.stage, `Bypass: ${task.title}`).toBe('backlog')
      expect(now.leadRunId, `Bypass: ${task.title}`).toBeUndefined()
      expect(now.runs, `Bypass: ${task.title}`).toEqual([])
      const comments = await client.ok<{ body: string; author: { kind: string } }[]>(
        'GET',
        `/tasks/${task.id}/comments`,
      )
      expect(comments, `Bypass: ${task.title}`).toContainEqual(
        expect.objectContaining({
          author: { kind: 'ted' },
          body: `Created by ${held.automation.name} · left in Backlog because this Factory runs in Bypass`,
        }),
      )
    }
    expect(held.followUp.followUpOf, 'Bypass: the Follow-up').toEqual({
      id: done.id,
      displayId: done.displayId,
    })

    await client.ok('PUT', `/factories/${factory?.id}/permissions`, { mode: 'auto' })
    const started = await fire(client, done, 'Auto')
    for (const task of [started.created, started.followUp]) {
      await waitForTask(client, task.id, (t) => t.stage !== 'backlog', `${task.displayId} to start`)
      const comments = await client.ok<{ body: string }[]>('GET', `/tasks/${task.id}/comments`)
      expect(
        comments.some((c) => c.body.includes('left in Backlog')),
        `Auto: ${task.title}`,
      ).toBe(false)
    }
  })
})

test('a Run reads only its own Factory’s Automations', async () => {
  const client = await startTed()
  const gadgets = path.join(scratch, 'acme', 'gadgets.git')
  await cp(path.join(scratch, 'acme', 'widgets.git'), gadgets, { recursive: true })
  await client.ok<Factory>('POST', '/dev/factories', { repo: gadgets, key: 'OT' })
  {
    const secret = await create(client, { name: 'Other intake', factory: 'OT' })
    const reads = (...extra: string[]) => [
      { run: ['ted', 'automation', 'list'] },
      { run: ['ted', 'automation', 'list', '--factory', 'OT'] },
      { run: ['ted', 'automation', 'show', secret.id] },
      { run: ['ted', 'automation', 'show', secret.id, '--factory', 'OT'] },
      ...extra.map((name) => ({ run: ['ted', 'automation', 'show', name] })),
    ]
    const checkReads = (results: CommandResult[]) => {
      expect(results[0]?.code).toBe(0)
      expect(results[0]?.stdout).not.toContain('Other intake')
      expect(results[1]).toMatchObject({ code: 1 })
      expect(results[1]?.stderr).toMatch(/only its own Factory/)
      expect(results[2]).toMatchObject({ code: 1 })
      expect(results[2]?.stdout).toBe('')
      expect(results[3]).toMatchObject({ code: 1 })
      expect(results[3]?.stderr).toMatch(/only its own Factory/)
    }

    const own = await create(client, {
      name: 'Own intake',
      prompt: steps(...reads('Own intake'), { endTurn: true }),
    })
    await client.ok('POST', `/automations/${own.id}/run`)
    const [row] = await waitForHistory(
      client,
      own.id,
      (rows) => rows[0]?.runId !== undefined,
      'the Automation Run to start',
    )
    const automationResults = await waitUntil(async () => {
      const found = await commandResults(client, row?.runId ?? '')
      return found.length === 5 ? found : undefined
    }, 'the Automation Run’s commands')
    checkReads(automationResults)
    expect(automationResults[0]?.stdout).toContain('Own intake')
    expect(automationResults[4]?.code).toBe(0)

    const task = await client.ok<Task>('POST', '/tasks', {
      factory: 'NB',
      start: true,
      title: steps(...reads(), { waitFor: path.join(scratch, 'never') }),
    })
    const lead = await waitUntil(async () => {
      const found = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === task.id)
      return found?.leadRunId
    }, 'the Task Lead to start')
    const taskResults = await waitUntil(async () => {
      const found = await commandResults(client, lead)
      return found.length === 4 ? found : undefined
    }, 'the Task Lead’s commands')
    checkReads(taskResults)
    expect(taskResults[0]?.stdout).toContain('Own intake')
  }
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

describe('Factory Linear intake enforcement', () => {
  test('enforces no scope, then a team scope, then a project scope for custom Automations, names the scope in the Run’s prompt, and allows manual imports', async () => {
    const key = 'lin_api_abcdefghijklmnopqrstuvwxyz0123456789ABCD'
    const sets = {
      none: ['NB-42', 'NB-43', 'OT-44', 'OT-45'],
      team: ['NB-52', 'NB-53', 'OT-54', 'OT-55'],
      project: ['NB-62', 'NB-63', 'OT-64', 'OT-65'],
    }
    const linear = await startStubLinear({
      [key]: {
        name: 'Nabha',
        workspace: { name: 'Acme', urlKey: 'acme' },
        teams: [{ id: 'team-NB', name: 'Widgets', key: 'NB' }],
        projects: [{ id: 'project-one', name: 'One' }],
        issues: Object.values(sets).flatMap(
          ([both = '', team = '', project = '', neither = '']) => [
            { identifier: both, title: 'Matching both', projectId: 'project-one' },
            { identifier: team, title: 'Matching team', projectId: 'project-two' },
            { identifier: project, title: 'Matching project', projectId: 'project-one' },
            { identifier: neither, title: 'Matching neither' },
          ],
        ),
      },
    })
    try {
      await writeFile(stubKeyringFile(home), JSON.stringify({ secret: key }))
      const client = await startTed({
        linear: { apiUrl: linear.url, keyring: stubKeyring(stubKeyringFile(home)) },
      })
      const [factory] = await client.ok<Factory[]>('GET', '/factories')
      if (!factory) throw new Error('no Factory')
      for (const kind of ['none', 'team', 'project'] as const) {
        if (kind !== 'none')
          await client.ok('PUT', `/factories/${factory.id}/linear-intake`, {
            scope: {
              kind,
              id: kind === 'team' ? 'team-NB' : 'project-one',
              name: 'Client label',
              workspaceId: 'workspace-acme',
              workspace: 'acme',
            },
          })
        const ids = sets[kind]
        const automation = await create(client, {
          on: false,
          name: `Custom intake (${kind})`,
          prompt: steps(
            ...ids.map((id) => ({
              run: ['ted', 'task', 'create', '--source', `https://linear.app/acme/issue/${id}`, id],
            })),
            { endTurn: true },
          ),
        })
        await client.ok('POST', `/automations/${automation.id}/run`)
        const [row] = await waitForHistory(
          client,
          automation.id,
          (rows) => rows[0]?.result.kind === 'created',
          `scoped import (${kind})`,
        )
        const results = await commandResults(client, row?.runId ?? '')
        expect(
          results.map((result) => result.code),
          `${kind}: exit codes`,
        ).toEqual(kind === 'team' ? [0, 0, 1, 1] : kind === 'project' ? [0, 1, 0, 1] : [0, 0, 0, 0])
        for (const result of results.filter((result) => result.code !== 0))
          expect(result.stderr, `${kind}: refusal`).toContain(
            'outside this Factory’s Linear intake scope',
          )
        const imported = (await client.ok<Task[]>('GET', '/tasks'))
          .map((task) => task.source?.linear?.identifier)
          .filter((id) => id !== undefined && ids.includes(id))
        expect(imported.sort(), `${kind}: imported issues`).toEqual(
          kind === 'team'
            ? [ids[0], ids[1]]
            : kind === 'project'
              ? [ids[0], ids[2]]
              : [...ids].sort(),
        )
        const run = await client.ok<RunWithConversation>('GET', `/runs/${row?.runId}`)
        expect(run.run.prompt, `${kind}: prompt`).toContain(
          kind === 'none' ? 'Linear intake scope: Unscoped' : `Linear intake scope: ${kind}`,
        )
        const manual = await client.ok<Task>('POST', '/tasks', {
          factory: 'NB',
          source: `https://linear.app/acme/issue/${ids[3]}`,
          title: 'Human override',
        })
        expect(manual.createdBy, `${kind}: manual import`).not.toBe('automation')
      }
    } finally {
      await linear.close()
    }
  })

  test('a scoped Automation cannot import unverifiable issues, but a human can', async () => {
    const client = await startTed()
    const [factory] = await client.ok<Factory[]>('GET', '/factories')
    if (!factory) throw new Error('no Factory')
    await client.ok('PATCH', '/settings', {
      linearIntakeScopes: {
        [factory.id]: {
          kind: 'project',
          id: 'project-one',
          name: 'One',
          workspaceId: 'workspace-acme',
          workspace: 'acme',
        },
      },
    })
    const url = 'https://linear.app/acme/issue/NB-50'
    const automation = await create(client, {
      on: false,
      prompt: steps(
        { run: ['ted', 'task', 'create', '--source', url, 'Unavailable'] },
        { endTurn: true },
      ),
    })
    await client.ok('POST', `/automations/${automation.id}/run`)
    const [row] = await waitForHistory(
      client,
      automation.id,
      (rows) => rows[0]?.result.kind === 'no-new-tasks',
      'unverifiable import to finish',
    )
    expect((await commandResults(client, row?.runId ?? ''))[0]?.code).toBe(1)
    expect(await client.ok<Task[]>('GET', '/tasks')).toEqual([])
    await client.ok('POST', '/tasks', { factory: 'NB', source: url, title: 'Manual link' })
    expect(await client.ok<Task[]>('GET', '/tasks')).toHaveLength(1)
  })
})
