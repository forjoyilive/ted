import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

async function startTed(options: { addFactory?: boolean } = {}) {
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    automations: { now: () => clock, checkEveryMs: 50 },
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
})
