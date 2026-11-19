import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { availableParallelism, tmpdir } from 'node:os'
import path from 'node:path'
import type {
  Activity,
  Automation,
  AutomationDetail,
  AutomationRun,
  AutomationTemplate,
  Banner,
  Comment,
  Factory,
  RunSlots,
  RunWithConversation,
  Task,
  ThreadEvent,
  WaitingRequest,
} from '@ted/protocol'
import { defaultMachineSettings, tedPaths } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { Clock } from '../src/clock.ts'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import { openStore } from '../src/store/index.ts'
import { checkCpus } from '../src/tasks/check-slots.ts'
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
let load = 0
let memory = 1

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-origin-'))
  await makeOriginRepo(scratch)
  clock = Date.parse('2026-11-09T08:55:00Z')
  free = 500e9
  load = 0
  memory = 1
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
    github?: Parameters<typeof startDaemon>[0]['github']
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
    load: { ratio: () => load, memoryAvailable: () => memory, checkEveryMs: 30 },
    ...(options.linear && { linear: options.linear }),
    ...(options.github && { github: options.github }),
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

const threadTexts = async (client: Client, task: Task) =>
  (await client.ok<ThreadEvent[]>('GET', `/tasks/${task.id}/events`)).map((e) => e.text)
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

const checkLogs = () => path.join(tedPaths(home).logs, 'automation-checks')

const said = async (client: Client, runId: string) =>
  assistantTexts((await client.ok<RunWithConversation>('GET', `/runs/${runId}`)).conversation)

describe('app-wide Automation time zone', () => {
  test('a zone change preserves clock times and queued Runs, without catch-up after restart', async () => {
    const client = await startTed()
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
    const working = await create(client, {
      name: 'Held Run',
      agent: 'claude',
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
    await writeFile(path.join(home, 'stub-codex.json'), JSON.stringify({ signedIn: false }))
    await client.ok('POST', '/agents/health/check')
    const queued = await create(client, {
      agent: 'codex',
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
    }, 'Ted to stop the finished Run')
    expect(run.run).toMatchObject({ name: 'Sentry crash intake', state: 'finished' })
    expect(run.run.taskId).toBeUndefined()
    expect(run.run.prompt).toContain('# You are an Automation Run in Ted')
    expect(run.run.prompt).toContain('## Write clearly for the user')
    expect(run.run.prompt).toContain('## Tasks this Automation has created\n\nNone yet.')
    expect(await said(client, row?.runId ?? '')).toEqual(['Nothing new'])
    const after = (await detail(client, automation.id)).automation
    expect(after.last?.result.kind).toBe('no-new-tasks')
    expect(after.nextFirings[0]).toBe('2026-11-10T09:00:00.000Z')
  })

  test('weekly architecture reviews start over the slot limit and create distinct, deduplicated Backlog Tasks; the Run can list Automations but not change them, and the next Run sees the Tasks', async () => {
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
    await writeFile(path.join(scratch, 'before.png'), 'before')
    await writeFile(path.join(scratch, 'after.png'), 'after')
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
            '--attach',
            path.join(scratch, 'before.png'),
            '--attach',
            path.join(scratch, 'after.png'),
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
    const [row] = await waitForHistory(
      client,
      automation.id,
      (rows) => rows[0]?.result.kind === 'created',
      'the architecture review to finish',
    )
    expect((await detail(client, blocker.id)).automation.now?.kind).toBe('working')
    const attached = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.displayId === 'NB-1')
    expect(attached?.attachments.map((a) => [a.name, a.mediaType])).toEqual([
      ['before.png', 'image/png'],
      ['after.png', 'image/png'],
    ])
    const slots = await client.ok<RunSlots>('GET', '/slots')
    const [blockerRun = ''] = slots.holders.flatMap((h) =>
      h.kind === 'automation' && h.automationId === blocker.id ? [h.runId] : [],
    )
    const otherRun = api(
      daemon?.port ?? 0,
      (await loadRunTokens(tedPaths(home).runTokenKey)).issue(blockerRun),
    )
    expect(
      await otherRun.call('POST', '/tasks', {
        title: 'Borrowed files',
        attachments: attached?.attachments,
      }),
      'another Automation Run naming files it didn’t upload',
    ).toEqual({
      status: 403,
      body: {
        error:
          'before.png wasn’t uploaded by this Run; attach your own files with ted task create --attach',
      },
    })
    await release()
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
    const links = ['NB-1', 'NB-2'].flatMap((displayId) => {
      const task = tasks.find((t) => t.displayId === displayId)
      return task
        ? [
            {
              id: task.id,
              displayId,
              title: task.title,
              stage: task.stage,
              source: task.source?.url,
            },
          ]
        : []
    })
    expect(row?.created, 'each created Task’s link').toEqual(links)
    expect(row?.result, 'the Run’s result').toEqual({ kind: 'created', tasks: links })
    expect(row?.runId, 'the Run’s ID is its firing’s').toBe(row?.id)
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
    const shown = await detail(client, automation.id)
    expect(shown.history, 'the history, newest first').toEqual([next, row])
    expect(shown.automation).toMatchObject({
      factoryKey: 'NB',
      last: next,
      failuresInARow: 0,
      totals: { runs: 2, tasksCreated: 2 },
    })
    expect(shown.automation.now).toBeUndefined()
    const listed = await client.ok<Automation[]>('GET', '/automations?factory=NB')
    expect(
      listed.find((a) => a.id === automation.id),
      'the list’s row',
    ).toEqual(shown.automation)
    const everywhere = await client.ok<Automation[]>('GET', '/automations')
    expect(everywhere.map((a) => a.id)).toEqual(listed.map((a) => a.id))
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
        body: { error: 'only the Ted app can do this' },
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

  test('missed firings are made up once when Ted starts again', async () => {
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

  test('a Task Lead creates up to 10 Tasks in Backlog, with a reminder past 3, and starts and waits for a child it made', async () => {
    const client = await startTed()
    const factory = (await client.ok<Factory[]>('GET', '/factories')).find((f) => f.key === 'NB')
    await client.ok('PUT', '/backlog-starts', {
      enabled: true,
      all: false,
      groupIds: [],
      factoryIds: [factory?.id],
    })
    const make = (...args: string[]) => ({ run: ['ted', 'task', 'create', ...args] })
    const childTitle = steps(
      make('--child', 'Grandchild'),
      { endTurn: true },
      {
        everyMessage: [{ endTurn: true }],
      },
    )
    const task = await client.ok<Task>('POST', '/tasks', {
      factory: 'NB',
      start: true,
      title: steps(
        make('--description', 'Found while working', 'Separate work'),
        make('--start', 'Started at once'),
        make('--factory', 'OTHER', 'Elsewhere'),
        make('--child', childTitle),
        make('Third'),
        make('Fourth'),
        ...['Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth'].map((title) => make(title)),
        make('Eleventh'),
        { endTurn: true },
        { everyMessage: [{ endTurn: true }] },
      ),
    })
    const lead = await waitUntil(async () => {
      const found = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === task.id)
      return found?.leadRunId
    }, 'the Task Lead to start')
    const results = await waitUntil(
      async () => {
        const found = await commandResults(client, lead)
        return found.length === 13 ? found : undefined
      },
      'the commands to run',
      60_000,
    )
    expect(results.map((r) => r.code)).toEqual([0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])
    expect(results[1]?.stderr).toMatch(/Backlog; the user starts them/)
    expect(results[2]?.stderr).toMatch(/only in NB, its own Factory/)
    expect(results[4]?.stdout).toMatch(/^Created NB-\d+ {2}Third\n$/)
    expect(results[5]?.stdout).toContain(
      `${task.displayId} has now created 4 Tasks, past the suggested 3. Next time, suggest a planning chat or Split it to the user instead.`,
    )
    expect(results[11]?.stdout).toContain('has now created 10 Tasks')
    expect(results[12]?.stderr).toMatch(
      /already created 10 Tasks, the most one Task creates\. .*suggest a planning chat or Split it/,
    )

    const made = (await client.ok<Task[]>('GET', '/tasks')).filter(
      (t) => t.createdBy === 'task-lead' && t.title !== 'Grandchild',
    )
    expect(made).toHaveLength(10)
    expect(made.slice(0, 4).map((t) => [t.title, t.createdBy, t.parentId ?? null])).toEqual([
      ['Separate work', 'task-lead', null],
      [childTitle, 'task-lead', task.id],
      ['Third', 'task-lead', null],
      ['Fourth', 'task-lead', null],
    ])
    expect(made.at(-1)?.title).toBe('Tenth')
    const child = made[1]
    expect(await threadTexts(client, made[0] as Task)).toContain(
      `${task.displayId}’s Task Lead created this Task`,
    )
    expect(await threadTexts(client, child as Task)).toContain(
      `${task.displayId}’s Task Lead created this Task as its child`,
    )
    expect(await threadTexts(client, task)).toEqual(
      expect.arrayContaining([
        `The Task Lead created ${made[0]?.displayId}`,
        `The Task Lead created ${child?.displayId} as a child of this Task`,
      ]),
    )
    await waitUntil(async () => {
      const found = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === task.id)
      return found?.status?.kind === 'blocked' ? found : undefined
    }, 'the creating Task to wait for its child')
    await waitUntil(async () => {
      const found = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === child?.id)
      return found && found.stage !== 'backlog' ? found : undefined
    }, 'the child to start without the user')
    expect(await threadTexts(client, child as Task)).toContain(
      'Started because the Task Lead of the Task above it filed it',
    )
    const grandchild = await waitUntil(async () => {
      const found = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.title === 'Grandchild')
      return found
    }, 'the child’s Task Lead to file its own child')
    expect(grandchild).toMatchObject({ stage: 'backlog', parentId: child?.id, runs: [] })
    const held = await waitUntil(async () => {
      const comments = await client.ok<Comment[]>('GET', `/tasks/${child?.id}/comments`)
      return comments.find((c) => c.title === 'Child Task waits in Backlog')
    }, 'the note that the nested child waits')
    expect(held.body).toContain('this Task was itself created by a Task Lead')
    const later = await client.ok<Task[]>('GET', '/tasks')
    const laterMade = later.filter(
      (t) => t.createdBy === 'task-lead' && t.id !== child?.id && t.id !== grandchild.id,
    )
    expect(laterMade.map((t) => [t.stage, t.runs.length])).toEqual(
      laterMade.map(() => ['backlog', 0]),
    )
    expect(laterMade).toHaveLength(9)
    const waits = async () => {
      const now = await client.ok<Task[]>('GET', '/tasks')
      return {
        made: now.filter((t) => laterMade.some((m) => m.id === t.id)).map((t) => t.backlogWait),
        grandchild: now.find((t) => t.id === grandchild.id)?.backlogWait,
      }
    }
    await waitUntil(async () => {
      const found = await waits()
      return found.made.every((w) => w === 'task-lead') && found.grandchild === 'follow-up'
    }, 'Backlog rows to say a Task Lead filed them')
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
    await client.ok('PUT', '/backlog-starts', {
      enabled: true,
      all: false,
      groupIds: [],
      factoryIds: [factory?.id],
      includeAgentFiled: true,
    })
    await waitUntil(async () => {
      const found = await waits()
      return found.made.every((w) => w === undefined) && found.grandchild === 'follow-up'
    }, 'Tasks a Task Lead filed to start on their own, but not a follow-up of a follow-up')
  }, 90_000)

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

  test('Automation Runs start over slot limits and load holds while Tasks stay queued', async () => {
    await commitToOrigin(scratch, { '.ted/workflow.yaml': 'version: 1\nmax_working_runs: 1\n' })
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
    const automation = await create(client, { prompt: steps(hold(), { endTurn: true }) })
    load = 2
    const second = await client.ok<Task>('POST', '/tasks', {
      factory: 'NB',
      start: true,
      title: 'Second',
    })
    clock = Date.parse('2026-11-09T09:00:05Z')
    await waitUntil(
      async () => (await detail(client, automation.id)).automation.now?.kind === 'working',
      'the firing to start despite the occupied slot',
    )
    await expect
      .poll(async () => (await client.ok<RunSlots>('GET', '/slots')).busy?.cpuHeld)
      .toBe(true)
    const slots = await client.ok<RunSlots>('GET', '/slots')
    expect(slots).toMatchObject({ working: 2, busy: { cpuHeld: true } })
    expect(slots.queue.map((q) => q.kind)).toEqual(['task'])
    expect(slots.holders.map((h) => h.kind)).toContain('automation')
    const tasks = await client.ok<Task[]>('GET', '/tasks')
    expect(tasks.find((t) => t.id === second.id)?.leadRunId).toBeUndefined()
    expect(tasks.find((t) => t.id === busy.id)?.leadRunId).toBeDefined()
    await expect
      .poll(() => client.ok<Activity>('GET', '/activity'))
      .toMatchObject({ runs: { active: 2, queued: 1 } })
    await release()
    await waitForHistory(
      client,
      automation.id,
      (rows) => rows[0]?.result.kind === 'no-new-tasks',
      'the Automation Run to finish',
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

  test('a scheduled Check waits while the computer is busy until its cutoff, runs sandboxed on the default branch, makes Tasks for failing tests and updates them when they fail again; its agent step files, notes and starts Tasks, and Ted falls back when the agent doesn’t report', async () => {
    const client = await startTed()
    const fail = path.join(scratch, 'fail-check')
    const kill = path.join(scratch, 'kill-check')
    const command = [
      `if [ -f '${kill}' ]; then kill -9 $$; fi`,
      'echo "sandboxed=$TED_SANDBOX task=$TED_TASK. cpus=$TED_CHECK_CPUS."',
      'cat README.md',
      'echo "TED_SANDBOX_SKIPPED: the Electron app tests"',
      `if [ -f '${fail}' ]; then echo ' FAIL  |node| packages/x/test/a.test.ts > t'; echo ' FAIL  |node| packages/x/test/b.test.ts'; exit 1; fi`,
    ].join('; ')
    const automation = await create(client, {
      name: 'Nightly tests',
      prompt: undefined,
      check: { command, timeout: '5m', runBy: '07:00', agentStep: 'never' },
    })
    expect(automation).toMatchObject({
      prompt: '',
      check: { command, timeout: '5m', runBy: '07:00', agentStep: 'never', startTasks: false },
    })
    load = 5
    clock = Date.parse('2026-11-09T09:00:05Z')
    await waitUntil(async () => {
      const now = (await detail(client, automation.id)).automation.now
      return now?.kind === 'paused' && now.reason.includes('busy')
    }, 'the firing to wait for a quiet computer')
    expect(await client.ok<Activity>('GET', '/activity')).toMatchObject({ checksWaiting: 1 })
    clock = Date.parse('2026-11-10T07:00:30Z')
    const [passed] = await waitForHistory(
      client,
      automation.id,
      (rows) => rows[0]?.result.kind === 'passed',
      'the Check to pass',
    )
    expect(passed).toMatchObject({
      trigger: 'scheduled',
      check: { state: 'passed', exitCode: 0, failing: [], skipped: ['the Electron app tests'] },
    })
    expect(passed?.check?.ranWhileBusy).toBe(true)
    await waitUntil(async () => {
      const activity = await client.ok<Activity>('GET', '/activity')
      return activity.checksRunning === 0 && activity.checksWaiting === 0
    }, 'the finished Check to leave the activity counts')
    expect(passed?.runId).toBeUndefined()
    const firstOutput = await client.ok<{ text: string; log: string }>(
      'GET',
      `/automation-runs/${passed?.id}/output`,
    )
    expect(firstOutput.text).toContain(
      `sandboxed=1 task=. cpus=${checkCpus(availableParallelism(), 1, defaultMachineSettings.checkCpuPercent)}.`,
    )
    expect(firstOutput.text).toContain('# widgets')
    expect(firstOutput.log).toBe(path.join(checkLogs(), automation.id, `${passed?.id}.log`))

    memory = 0.05
    await writeFile(kill, '')
    clock = Date.parse('2026-11-10T07:05:00Z')
    await client.ok('POST', `/automations/${automation.id}/run`)
    const [outOfMemory] = await waitForHistory(
      client,
      automation.id,
      (rows) => rows[0]?.result.kind === 'stopped',
      'the Check to be stopped for memory',
    )
    expect(outOfMemory?.message).toContain('ran out of memory')
    expect(outOfMemory?.created).toBeUndefined()
    await rm(kill)
    memory = 1

    await writeFile(fail, '')
    clock = Date.parse('2026-11-10T07:10:00Z')
    await client.ok('POST', `/automations/${automation.id}/run`)
    const [failed] = await waitForHistory(
      client,
      automation.id,
      (rows) => rows[0]?.result.kind === 'check-failed',
      'the Check to fail',
    )
    expect(failed).toMatchObject({
      trigger: 'run-now',
      check: {
        state: 'failed',
        exitCode: 1,
        failing: ['packages/x/test/a.test.ts', 'packages/x/test/b.test.ts'],
      },
    })
    const created = failed?.result.kind === 'check-failed' ? failed.result.tasks : []
    expect(created.map((t) => [t.title, t.stage])).toEqual([
      ['Fix failing tests in packages/x/test/a.test.ts', 'backlog'],
      ['Fix failing tests in packages/x/test/b.test.ts', 'backlog'],
    ])
    const task = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === created[0]?.id)
    expect(task?.description).toContain('- packages/x/test/a.test.ts')
    expect(task?.description).toContain(`Full output: ${path.join(checkLogs(), automation.id)}`)

    clock = Date.parse('2026-11-10T07:20:00Z')
    await client.ok('POST', `/automations/${automation.id}/run`)
    const rows = await waitForHistory(
      client,
      automation.id,
      (r) => r.filter((row) => row.result.kind === 'check-failed').length === 2,
      'the Check to fail again',
    )
    expect(rows[0]).toMatchObject({ result: { kind: 'check-failed', tasks: [] } })
    expect(rows[0]?.check?.updated?.map((t) => t.id)).toEqual(created.map((t) => t.id))
    const comments = await client.ok<{ body: string; author: { kind: string } }[]>(
      'GET',
      `/tasks/${created[0]?.displayId}/comments`,
    )
    expect(comments.at(-1)).toMatchObject({ author: { kind: 'ted' } })
    expect(comments.at(-1)?.body).toMatch(/^It failed again\./)
    expect(
      (await client.ok<Task[]>('GET', '/tasks')).filter(
        (t) => t.factoryId === automation.factoryId,
      ),
    ).toHaveLength(2)
    expect(await readdir(tedPaths(home).automationRuns).catch(() => [])).toEqual([])

    const manual = await client.ok<Task>('POST', '/tasks', { factory: 'NB', title: 'Manual task' })
    const run = (...args: string[]) => ({ run: ['ted', ...args] })
    await client.ok('PATCH', `/automations/${automation.id}`, {
      check: { command, agentStep: 'on-failure', startTasks: true },
      prompt: steps(
        run('task', 'create', '--description', 'a and b share one cause', 'Fix the shared parser'),
        run('automation', 'note', created[0]?.displayId ?? '', 'Same cause as the parser'),
        run('automation', 'note', manual.displayId, 'Not ours'),
        run('automation', 'start', 'NB-4'),
        run('automation', 'start', created[0]?.displayId ?? ''),
        run('task', 'create', '--start', 'Started at once'),
        run('automation', 'output'),
        run('automation', 'report', 'One parser bug breaks a and b; filed NB-4'),
        { endTurn: true },
      ),
    })
    clock = Date.parse('2026-11-10T07:30:00Z')
    await client.ok('POST', `/automations/${automation.id}/run`)
    const [reported] = await waitForHistory(
      client,
      automation.id,
      (r) => r[0]?.check?.agent?.state === 'reported',
      'the agent step to report',
    )
    expect(reported).toMatchObject({
      result: {
        kind: 'check-failed',
        tasks: [{ displayId: 'NB-4', title: 'Fix the shared parser' }],
      },
      message: 'One parser bug breaks a and b; filed NB-4',
      check: {
        state: 'failed',
        agent: {
          report: 'One parser bug breaks a and b; filed NB-4',
          noted: [{ id: created[0]?.id }],
          started: [{ displayId: 'NB-4' }],
        },
      },
    })
    expect(reported?.check?.updated).toBeUndefined()
    const agentSaid = (await said(client, reported?.runId ?? '')).join('\n')
    expect(agentSaid).toContain('wasn’t created by this Automation')
    expect(agentSaid).toContain('wasn’t created by this Run')
    expect(agentSaid).toContain('create it without --start')
    expect(agentSaid).toContain('FAIL  |node| packages/x/test/a.test.ts')
    const noted = await client.ok<{ body: string }[]>(
      'GET',
      `/tasks/${created[0]?.displayId}/comments`,
    )
    expect(noted.at(-1)?.body).toBe(
      'From the Automation “Nightly tests”:\n\nSame cause as the parser',
    )
    await waitUntil(
      async () =>
        (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.displayId === 'NB-4')?.stage !==
        'backlog',
      'the agent’s Task to start',
    )
    expect(
      (await client.ok<Task[]>('GET', '/tasks')).filter(
        (t) => t.factoryId === automation.factoryId,
      ),
    ).toHaveLength(4)

    await client.ok('PATCH', `/automations/${automation.id}`, {
      check: { command, startTasks: false },
      prompt: steps(run('automation', 'start', 'NB-4'), { endTurn: true }),
    })
    clock = Date.parse('2026-11-10T07:40:00Z')
    await client.ok('POST', `/automations/${automation.id}/run`)
    const [fellBack] = await waitForHistory(
      client,
      automation.id,
      (r) => r[0]?.check?.agent?.state === 'fallback',
      'Ted to fall back after the agent ends without reporting',
    )
    expect(fellBack).toMatchObject({
      result: { kind: 'check-failed', tasks: [] },
      check: { agent: { fallback: 'The agent Run ended without reporting' } },
    })
    expect(fellBack?.check?.updated?.map((t) => t.id)).toEqual(created.map((t) => t.id))
    expect((await said(client, fellBack?.runId ?? '')).join('\n')).toContain(
      'Start the Tasks it creates',
    )
    await waitUntil(
      async () => (await readdir(tedPaths(home).automationRuns).catch(() => [])).length === 0,
      'the agent checkout to go',
    )

    await client.ok('DELETE', `/automations/${automation.id}`)
    expect(await readdir(checkLogs())).toEqual([])
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
      if (process.platform === 'darwin') {
        expect(argv).toEqual(
          expect.arrayContaining(['default_permissions="ted"', 'approval_policy="on-request"']),
        )
        expect(argv.find((arg) => arg.startsWith('permissions='))).toContain('extends=":workspace"')
      } else {
        expect(argv).toEqual(
          expect.arrayContaining([
            'sandbox_mode="workspace-write"',
            'approval_policy="on-request"',
          ]),
        )
      }
      expect(argv.join(' ')).not.toContain('danger-full-access')
    }
  }
})

test('removing a Factory deletes its Automations, stops their Runs and removes scheduled Check files', async () => {
  const client = await startTed()
  const automation = await create(client, { prompt: steps(hold(), { endTurn: true }) })
  const check = await create(client, {
    name: 'Nightly tests',
    prompt: undefined,
    schedule: { kind: 'daily', at: '03:00' },
    check: { command: 'echo "cpus=$TED_CHECK_CPUS."' },
  })
  await client.ok('PATCH', '/settings', { limitScheduledCheckCpus: false })
  await client.ok('POST', `/automations/${check.id}/run`)
  const [unlimited] = await waitForHistory(
    client,
    check.id,
    (rows) => rows[0]?.result.kind === 'passed',
    'the Check',
  )
  const output = await client.ok<{ text: string }>(
    'GET',
    `/automation-runs/${unlimited?.id}/output`,
  )
  expect(output.text).toContain('cpus=.')
  expect(await readdir(checkLogs())).toEqual([check.id])
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
  expect(await readdir(checkLogs())).toEqual([])
  expect((await client.ok<Activity>('GET', '/activity')).automationsOn).toBe(0)
  await waitUntil(async () => {
    const run = await client.ok<RunWithConversation>('GET', `/runs/${row?.runId}`)
    return run.run.state === 'finished'
  }, 'the Run to stop')
})

test('an Automation that is on keeps a daemon started by ted from exiting when idle, and the Linear sync timer doesn’t', async () => {
  const timers = new ManualClock()
  let idled = 0
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    clock: timers,
    idleExit: { afterMs: 300, onIdle: () => idled++ },
    automations: { now: () => clock, checkEveryMs: 50 },
    linearSyncMs: 100,
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
    const parent = await client.ok<Task>('POST', '/tasks', {
      factory: 'NB',
      start: true,
      title: steps(
        { run: ['ted', 'task', 'create', '--child', 'Bypass child'] },
        { endTurn: true },
        { everyMessage: [{ endTurn: true }] },
      ),
    })
    const child = await waitUntil(async () => {
      const found = (await client.ok<Task[]>('GET', '/tasks')).find(
        (t) => t.title === 'Bypass child',
      )
      return found
    }, 'the Task Lead to file a child')
    expect(child).toMatchObject({ stage: 'backlog', parentId: parent.id, runs: [] })
    const childNote = await waitUntil(async () => {
      const comments = await client.ok<Comment[]>('GET', `/tasks/${parent.id}/comments`)
      return comments.find((c) => c.title === 'Child Task waits in Backlog')
    }, 'the note that the child waits')
    expect(childNote.body).toContain('this Factory runs agents without the sandbox')

    await client.ok('PUT', `/factories/${factory?.id}/permissions`, { mode: 'auto' })
    const started = await fire(client, done, 'Auto')
    for (const task of [started.created, started.followUp]) {
      await waitForTask(client, task.id, (t) => t.stage !== 'backlog', `${task.displayId} to start`)
      const comments = await client.ok<{ body: string }[]>('GET', `/tasks/${task.id}/comments`)
      expect(
        comments.some((c) => c.body.includes('left in Backlog')),
        `Auto: ${task.title}`,
      ).toBe(false)
      const lines = await threadTexts(client, task)
      expect(lines, `Auto: ${task.title}`).not.toContain('Task started')
      expect(
        lines.filter(
          (line) =>
            line === 'Started by an Automation' ||
            line === `The Automation “${started.automation.name}” started this Task`,
        ),
        `Auto: ${task.title}`,
      ).toHaveLength(1)
    }
  }, 90_000)
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

  test('ted linear intake creates Backlog Tasks for the not-started issues assigned to the user in the scope, skips tracked ones and refuses without a scope or a connection', async () => {
    const key = 'lin_api_abcdefghijklmnopqrstuvwxyz0123456789ABCD'
    const linear = await startStubLinear({
      [key]: {
        name: 'Nabha',
        workspace: { name: 'Acme', urlKey: 'acme' },
        teams: [{ id: 'team-NB', name: 'Widgets', key: 'NB' }],
        issues: [
          { identifier: 'NB-1', title: 'Todo for me', assignedToMe: true },
          { identifier: 'NB-2', title: 'Backlog for me', state: 'Backlog', assignedToMe: true },
          { identifier: 'NB-3', title: 'Triage for me', state: 'Triage', assignedToMe: true },
          { identifier: 'NB-4', title: 'Tracked already', state: 'Backlog', assignedToMe: true },
          { identifier: 'NB-5', title: 'Started', state: 'In Progress', assignedToMe: true },
          { identifier: 'NB-6', title: 'Not mine' },
          { identifier: 'OT-7', title: 'Other team', assignedToMe: true },
        ],
      },
    })
    try {
      await writeFile(stubKeyringFile(home), JSON.stringify({ secret: key }))
      const client = await startTed({
        linear: {
          apiUrl: linear.url,
          keyring: stubKeyring(stubKeyringFile(home)),
          intakeLimit: 2,
        },
      })
      const [factory] = await client.ok<Factory[]>('GET', '/factories')
      if (!factory) throw new Error('no Factory')
      const unscoped = await client.call('POST', '/linear-intake', { factory: 'NB' })
      expect(unscoped.status).toBe(403)
      expect(JSON.stringify(unscoped.body)).toContain('Choose a Linear Team or Project')
      await client.ok('PUT', `/factories/${factory.id}/linear-intake`, {
        scope: {
          kind: 'team',
          id: 'team-NB',
          name: 'Widgets',
          workspaceId: 'workspace-acme',
          workspace: 'acme',
        },
      })
      await client.ok<Task>('POST', '/tasks', {
        factory: 'NB',
        source: 'https://linear.app/acme/issue/NB-4',
        title: 'Tracked already',
      })
      const automation = await create(client, {
        on: false,
        name: 'Import my Linear work',
        prompt: steps({ run: ['ted', 'linear', 'intake'] }, { endTurn: true }),
      })
      const outputs: string[] = []
      const seen = new Set<string>()
      for (const firings of [1, 2]) {
        await client.ok('POST', `/automations/${automation.id}/run`)
        const rows = await waitForHistory(
          client,
          automation.id,
          (rows) => rows.length === firings && rows.every((row) => row.result.kind === 'created'),
          `Linear intake firing ${firings}`,
        )
        const runId = rows.find((row) => row.runId && !seen.has(row.runId))?.runId ?? ''
        seen.add(runId)
        const [result] = await commandResults(client, runId)
        expect(result?.code, result?.stderr).toBe(0)
        outputs.push(result?.stdout ?? '')
      }
      expect(outputs[0]).toContain('Imported 2 Linear issues from the Linear team Widgets')
      expect(outputs[0]).toContain('1 issue is already tracked')
      expect(outputs[0]).toContain('1 more issue waits for the next run')
      expect(outputs[1]).toContain('Imported 1 Linear issue from the Linear team Widgets')
      expect(outputs[1]).toContain('3 issues are already tracked')
      const imported = (await client.ok<Task[]>('GET', '/tasks'))
        .filter((task) => task.createdBy === 'automation')
        .map((task) => ({ id: task.source?.linear?.identifier, stage: task.stage }))
        .sort((a, b) => (a.id ?? '').localeCompare(b.id ?? ''))
      expect(imported).toEqual([
        { id: 'NB-1', stage: 'backlog' },
        { id: 'NB-2', stage: 'backlog' },
        { id: 'NB-3', stage: 'backlog' },
      ])
      const account = linear.accounts.get(key)
      if (!account?.issues) throw new Error('no stub account')
      account.issues.push({ identifier: 'NB-8', title: 'Scope cleared', assignedToMe: true })
      let release = () => {}
      account.lookupReady = new Promise((resolve) => {
        release = resolve
      })
      const looking = new Promise<void>((resolve) => {
        account.onLookup = (id) => {
          if (id === 'NB-8') resolve()
        }
      })
      await client.ok('POST', `/automations/${automation.id}/run`)
      await looking
      await client.ok('PUT', `/factories/${factory.id}/linear-intake`, { scope: null })
      release()
      const rows = await waitForHistory(
        client,
        automation.id,
        (rows) => rows.length === 3 && rows.every((row) => row.result.kind !== 'running'),
        'Linear intake firing 3',
      )
      const runId = rows.find((row) => row.runId && !seen.has(row.runId))?.runId ?? ''
      const [stopped] = await commandResults(client, runId)
      expect(stopped?.stdout).toContain(
        'Linear intake scope changed during the import. Ted stopped; the next run uses the new scope.',
      )
      expect(
        (await client.ok<Task[]>('GET', '/tasks')).some(
          (task) => task.source?.linear?.identifier === 'NB-8',
        ),
      ).toBe(false)
      await client.ok('PUT', `/factories/${factory.id}/linear-intake`, {
        scope: {
          kind: 'team',
          id: 'team-NB',
          name: 'Widgets',
          workspaceId: 'workspace-acme',
          workspace: 'acme',
        },
      })
      await client.ok('DELETE', '/integrations/linear/key')
      const disconnected = await client.call('POST', '/linear-intake', { factory: 'NB' })
      expect(disconnected.status).toBe(409)
      expect(JSON.stringify(disconnected.body)).toContain('Linear isn’t connected')
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

describe('Factory GitHub intake enforcement', () => {
  const previousState = process.env.TED_STUB_GH
  afterEach(() => {
    if (previousState === undefined) delete process.env.TED_STUB_GH
    else process.env.TED_STUB_GH = previousState
  })

  // One daemon and two Runs cover every rule; each start of a daemon and a Run costs seconds.
  test('with a label set, an Automation imports only open, labelled issues in the Factory’s repos and never starts them, even with Start Backlog Tasks automatically on; with Any open issue the label isn’t needed; the human isn’t limited', async () => {
    process.env.TED_STUB_GH = path.join(home, 'gh.json')
    const client = await startTed()
    const [factory] = await client.ok<Factory[]>('GET', '/factories')
    if (!factory) throw new Error('no Factory')
    const repo = factory.repo
    const url = (n: number, where = repo) => `https://github.com/${where}/issues/${n}`
    const answer = (
      n: number,
      extra: { state?: string; labels?: string[]; parent?: number; where?: string } = {},
    ) => ({
      number: n,
      title: `Issue ${n}`,
      state: extra.state ?? 'OPEN',
      locked: false,
      url: url(n, extra.where),
      body: 'Details',
      bodyHTML: '',
      createdAt: '2026-11-01T10:00:00Z',
      authorAssociation: 'OWNER',
      author: { login: 'owner' },
      repository: { nameWithOwner: extra.where ?? repo },
      labels: {
        totalCount: extra.labels?.length ?? 0,
        nodes: (extra.labels ?? []).map((name) => ({ name })),
      },
      ...(extra.parent !== undefined && { parent: { url: url(extra.parent) } }),
      comments: { totalCount: 0, nodes: [] },
    })
    const key = (n: number, where = repo) => `${where.toLowerCase()}#${n}`
    await writeFile(
      path.join(home, 'gh.json'),
      JSON.stringify({
        issues: {
          [key(1)]: answer(1, { labels: ['bug', 'Ready'] }),
          [key(2)]: answer(2),
          [key(3)]: answer(3, { state: 'CLOSED', labels: ['ready'] }),
          [key(4, 'someone/else')]: answer(4, { labels: ['ready'], where: 'someone/else' }),
          [key(5)]: answer(5, { labels: ['ready'], parent: 1 }),
          [key(6)]: answer(6, { labels: ['ready'] }),
        },
      }),
    )
    await client.ok('PUT', `/factories/${factory.id}/github-intake`, { scope: { label: 'ready' } })
    await client.ok('PUT', '/backlog-starts', {
      enabled: true,
      all: false,
      groupIds: [],
      factoryIds: [factory.id],
    })
    const create_ = (n: number, ...extra: string[]) => ({
      run: [
        'ted',
        'task',
        'create',
        ...extra,
        '--source',
        url(n, n === 4 ? 'someone/else' : repo),
        `Issue ${n}`,
      ],
    })
    const labelled = await create(client, {
      on: false,
      name: 'Daily GitHub issue triage',
      prompt: steps(
        create_(1),
        create_(2),
        create_(3),
        create_(4),
        create_(5),
        create_(6, '--start'),
        { endTurn: true },
      ),
    })
    await client.ok('POST', `/automations/${labelled.id}/run`)
    const [row] = await waitForHistory(
      client,
      labelled.id,
      (rows) => rows[0]?.result.kind === 'created',
      'the labelled import to finish',
    )
    const results = await commandResults(client, row?.runId ?? '')
    expect(results.map((r) => r.code)).toEqual([0, 1, 1, 1, 1, 1])
    expect(results[1]?.stderr).toContain('doesn’t have the label "ready"')
    expect(results[2]?.stderr).toContain('is closed on GitHub')
    expect(results[3]?.stderr).toContain('isn’t in one of this Factory’s repos')
    expect(results[4]?.stderr).toContain(
      `is a sub-issue of ${repo}#1, which this Factory already tracks as NB-1`,
    )
    expect(results[5]?.stderr).toContain('Leave out --start')
    const run = await client.ok<RunWithConversation>('GET', `/runs/${row?.runId}`)
    expect(run.run.prompt).toContain('GitHub intake: only issues with the label "ready"')
    let tasks = await client.ok<Task[]>('GET', '/tasks')
    expect(tasks.map((t) => [t.source?.github?.number, t.stage, t.createdBy])).toEqual([
      [1, 'backlog', 'automation'],
    ])
    await waitUntil(async () => {
      const found = await client.ok<Task[]>('GET', '/tasks')
      return found[0]?.backlogWait === 'automation' ? found : undefined
    }, 'the imported issue to say an Automation filed it')

    await client.ok('PUT', `/factories/${factory.id}/github-intake`, { scope: null })
    const anyIssue = await create(client, {
      on: false,
      name: 'Any open issue',
      prompt: steps(create_(2), create_(3), { endTurn: true }),
    })
    await client.ok('POST', `/automations/${anyIssue.id}/run`)
    const [second] = await waitForHistory(
      client,
      anyIssue.id,
      (rows) => rows[0]?.result.kind === 'created',
      'the unlabelled import to finish',
    )
    expect((await commandResults(client, second?.runId ?? '')).map((r) => r.code)).toEqual([0, 1])
    const secondRun = await client.ok<RunWithConversation>('GET', `/runs/${second?.runId}`)
    expect(secondRun.run.prompt).toContain('GitHub intake: any open issue')

    await client.ok('PUT', `/factories/${factory.id}/github-intake`, { scope: { label: 'ready' } })
    const byHand = await client.ok<Task>('POST', '/tasks', {
      factory: 'NB',
      source: url(3),
      title: 'Closed, by hand',
    })
    await waitUntil(
      async () =>
        (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === byHand.id)?.stage !==
        'backlog',
      'Start Backlog Tasks automatically to start the Task made by hand',
    )
    tasks = await client.ok<Task[]>('GET', '/tasks')
    expect(tasks.map((t) => t.source?.github?.number).sort()).toEqual([1, 2, 3])
    expect(
      tasks
        .filter((t) => t.createdBy === 'automation')
        .map((t) => [t.source?.github?.number, t.stage]),
    ).toEqual([
      [1, 'backlog'],
      [2, 'backlog'],
    ])
  })

  // Its own daemon: the per-run cap is lowered through startDaemon's github.intakeLimit.
  test('ted github intake imports every labelled open issue into Backlog, skips tracked ones and sub-issues of tracked ones, imports past a tree too big for the cap, stops at the cap, and refuses without a label or outside an Automation', async () => {
    process.env.TED_STUB_GH = path.join(home, 'gh.json')
    const client = await startTed({ github: { intakeLimit: 2 } })
    const [factory] = await client.ok<Factory[]>('GET', '/factories')
    if (!factory) throw new Error('no Factory')
    const repo = factory.repo
    const url = (n: number) => `https://github.com/${repo}/issues/${n}`
    const answer = (
      n: number,
      extra: { state?: string; labels?: string[]; parent?: number; sub?: number[] } = {},
    ) => ({
      number: n,
      title: `Issue ${n}`,
      state: extra.state ?? 'OPEN',
      locked: false,
      url: url(n),
      body: 'Details',
      bodyHTML: '',
      createdAt: '2026-11-01T10:00:00Z',
      authorAssociation: 'OWNER',
      author: { login: 'owner' },
      repository: { nameWithOwner: repo },
      labels: {
        totalCount: extra.labels?.length ?? 0,
        nodes: (extra.labels ?? []).map((name) => ({ name })),
      },
      ...(extra.parent !== undefined && { parent: { url: url(extra.parent) } }),
      comments: { totalCount: 0, nodes: [] },
      ...(extra.sub && {
        subIssues: {
          totalCount: extra.sub.length,
          nodes: extra.sub.map((number) => ({
            number,
            state: 'OPEN',
            repository: { nameWithOwner: repo },
          })),
        },
      }),
    })
    const ready = ['Ready']
    await writeFile(
      path.join(home, 'gh.json'),
      JSON.stringify({
        issues: Object.fromEntries(
          [
            answer(1, { labels: ready, sub: [5, 11] }),
            answer(2),
            answer(3, { state: 'CLOSED', labels: ready }),
            answer(5, { labels: ready, parent: 1 }),
            answer(7, { labels: ready }),
            answer(8, { labels: ready, parent: 7 }),
            answer(9, { labels: ready }),
            answer(10, { labels: ready }),
            answer(11, { labels: ready, parent: 1 }),
            answer(12, { labels: ready }),
          ].map((issue) => [`${repo.toLowerCase()}#${issue.number}`, issue]),
        ),
      }),
    )
    const intake = await create(client, {
      on: false,
      name: 'Import GitHub issues',
      prompt: steps({ run: ['ted', 'github', 'intake'] }, { endTurn: true }),
    })
    await client.ok('POST', `/automations/${intake.id}/run`)
    const [refused] = await waitForHistory(
      client,
      intake.id,
      (rows) => rows[0]?.result.kind === 'no-new-tasks',
      'the import without a label to finish',
    )
    const [noLabel] = await commandResults(client, refused?.runId ?? '')
    expect(noLabel?.code).toBe(1)
    expect(noLabel?.stderr).toContain('Choose a label in')
    expect((await client.call('POST', '/github-intake', {})).status).toBe(403)

    await client.ok('PUT', `/factories/${factory.id}/github-intake`, { scope: { label: 'ready' } })
    const byHand = await client.ok<Task>('POST', '/tasks', { factory: 'NB', source: url(7) })
    await client.ok('POST', `/automations/${intake.id}/run`)
    const rows = await waitForHistory(
      client,
      intake.id,
      (rows) => rows.some((r) => r.result.kind === 'created'),
      'the labelled bulk import to finish',
    )
    const row = rows.find((r) => r.result.kind === 'created')
    const [imported] = await commandResults(client, row?.runId ?? '')
    expect(imported?.code).toBe(0)
    expect(imported?.stdout).toContain('Imported 2 GitHub issues labelled "ready"')
    expect(imported?.stdout).toContain(`${repo}#9`)
    expect(imported?.stdout).not.toContain('Issue 9')
    expect(imported?.stdout).toContain('2 issues are already tracked or under a tracked issue.')
    expect(imported?.stdout).toContain('2 more issues wait for the next run')
    const tasks = await client.ok<Task[]>('GET', '/tasks')
    expect(
      tasks
        .filter((t) => t.id !== byHand.id)
        .map((t) => [t.source?.github?.number, t.stage, t.createdBy])
        .sort(),
    ).toEqual([
      [10, 'backlog', 'automation'],
      [9, 'backlog', 'automation'],
    ])
  })
})
