import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type AsanaIntakeScope,
  type AutomationDetail,
  type AutomationRun,
  type DaemonClient,
  type RunWithConversation,
  readDaemonInfo,
  type Task,
  tedPaths,
} from '@ted/protocol'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/daemon.ts'
import type { Keyring } from '../src/linear/keyring.ts'
import { loadRunTokens } from '../src/run-token.ts'
import { type StubAsanaTask, startStubAsana, unusedPort } from './fixtures/stub-asana.ts'
import {
  api,
  appClient,
  assistantTexts,
  hostsStarted,
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
let stub: Awaited<ReturnType<typeof startStubAsana>>
let daemon: RunningDaemon | undefined
let callbackPort: number
let secret: string | undefined
let clock: number | undefined
const keyring: Keyring = {
  kind: 'macos-keychain',
  async get() {
    return secret
  },
  async set(value) {
    secret = value
  },
  async delete() {
    secret = undefined
  },
}

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-origin-'))
  origin = await makeOriginRepo(scratch)
  stub = await startStubAsana()
  callbackPort = await unusedPort()
  secret = undefined
  clock = undefined
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await stub.close()
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

async function start(intakeLimit?: number): Promise<DaemonClient> {
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    asana: {
      keyring,
      oauthOrigin: stub.url,
      apiOrigin: stub.url,
      callbackPort,
      ...(intakeLimit !== undefined && { intakeLimit }),
    },
    automations: { now: () => clock ?? Date.now(), checkEveryMs: 50 },
  })
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('No daemon info')
  return appClient(info, daemon.appToken)
}

async function connect(client: DaemonClient) {
  await client.configureAsana({
    clientId: '12345',
    clientSecret: 'client-secret-opaque',
    inFile: false,
  })
  const { url } = await client.connectAsana()
  expect((await fetch(stub.callback(url))).status).toBe(200)
  await waitUntil(async () => (await client.getAsana()).state === 'connected', 'connected')
}

const avery = { gid: '100', name: 'Avery' }
const sam = { gid: '200', name: 'Sam' }
const now = { project: '9', section: '91' }
const later = { project: '9', section: '92' }
const scope: AsanaIntakeScope = {
  workspace: { gid: '1', name: 'Acme' },
  project: { gid: '9', name: 'Roadmap' },
  section: { gid: '91', name: 'Now' },
}

function asanaWorld(extra: StubAsanaTask[] = []) {
  stub.setWorkspaces([
    { gid: '1', name: 'Acme' },
    { gid: '2', name: 'Elsewhere' },
  ])
  stub.setProjects([
    {
      gid: '9',
      name: 'Roadmap',
      workspace: '1',
      sections: [
        { gid: '91', name: 'Now' },
        { gid: '92', name: 'Later' },
      ],
    },
    { gid: '8', name: 'Other', workspace: '1', sections: [{ gid: '81', name: 'Inbox' }] },
    { gid: '7', name: 'Foreign', workspace: '2' },
  ])
  stub.setTasks([
    {
      gid: '501',
      name: 'Checkout redesign',
      assignee: avery,
      memberships: [now],
      subtasks: ['502', '503'],
    },
    { gid: '502', name: 'Payment form', assignee: avery, parent: '501', memberships: [now] },
    {
      gid: '503',
      name: 'Pick provider',
      completed: true,
      assignee: sam,
      parent: '501',
      subtasks: ['504'],
    },
    { gid: '504', name: 'Wire provider', assignee: sam, parent: '503' },
    { gid: '510', name: 'Later work', assignee: avery, memberships: [later] },
    { gid: '520', name: 'Sam’s work', assignee: sam, memberships: [now] },
    { gid: '530', name: 'Shipped', assignee: avery, completed: true, memberships: [now] },
    { gid: '600', name: 'Ops parent', assignee: sam, subtasks: ['540'] },
    { gid: '540', name: 'Rotate keys', assignee: avery, parent: '600', memberships: [now] },
    { gid: '560', name: 'Imported earlier', assignee: avery, subtasks: ['550'] },
    { gid: '550', name: 'New under earlier', assignee: avery, parent: '560', memberships: [now] },
    { gid: '570', name: 'Locked', assignee: avery, memberships: [now] },
    ...extra,
  ])
}

const commandResults = (run: RunWithConversation) =>
  assistantTexts(run.conversation).flatMap((text) => {
    try {
      const parsed = JSON.parse(text) as { code: number; stdout: string; stderr: string }
      return typeof parsed.code === 'number' ? [parsed] : []
    } catch {
      return []
    }
  })

const byGid = (all: Task[], gid: string) => all.find((t) => t.source?.asana?.gid === gid)
const asanaWrites = () =>
  stub.requests.filter((r) => r.method !== 'GET' && r.path.startsWith('/api/1.0/'))

test('intake imports eligible roots from the saved section with their subtasks, skips covered items and imports nothing twice after a restart', async () => {
  let client = await start()
  await connect(client)
  await client.addFactory({ repo: origin, key: 'NB' })
  const factory = (await client.listFactories()).find((f) => f.key === 'NB')
  if (!factory) throw new Error('no Factory')
  asanaWorld()
  stub.setTasks([
    { gid: '560', name: 'Imported earlier', assignee: avery },
    { gid: '1000', name: 'unused' },
  ])
  await client.importAsana({ url: 'https://app.asana.com/0/0/560', factory: 'NB' })
  asanaWorld()

  const cli = api(daemon?.port ?? 0, await tokenFor(home))
  expect((await cli.call('POST', '/asana-intake', { factory: 'NB' })).status).toBe(403)
  const local = api(daemon?.port ?? 0, { appKey: daemon?.appToken ?? '' })
  expect(
    (await local.call('PATCH', '/settings', { asanaIntakeScopes: { [factory.id]: scope } })).status,
  ).toBe(400)
  const saved = await client.setFactoryAsanaIntake(factory.id, {
    ...scope,
    project: { gid: '9', name: 'Old name' },
  })
  expect(saved.asanaIntakeScopes[factory.id]).toEqual(scope)

  stub.failNext('/api/1.0/tasks/570', 403, 100)
  stub.failNext('/api/1.0/sections/91/tasks', 429, 1, '2')
  const first = await client.runAsanaIntake({ factory: 'NB' })
  const listing = stub.requests.filter((r) => r.path === '/api/1.0/sections/91/tasks')
  expect((listing[1]?.at ?? 0) - (listing[0]?.at ?? 0)).toBeGreaterThanOrEqual(1900)
  expect(first.imported.map((i) => i.gid).sort()).toEqual(['501', '540'])
  expect(first.tracked).toBe(2)
  expect(first.skipped).toEqual([expect.objectContaining({ gid: '570' })])
  expect(first.left).toBe(0)
  expect(first.incomplete).toBeUndefined()

  let all = await client.listTasks()
  const root = byGid(all, '501')
  expect(root).toMatchObject({ stage: 'backlog', title: 'Checkout redesign' })
  expect(byGid(all, '502')?.parentId).toBe(root?.id)
  expect(byGid(all, '504')).toMatchObject({ parentId: root?.id, stage: 'backlog' })
  expect(byGid(all, '504')?.source?.asana?.assignee).toMatchObject({ name: 'Sam', you: false })
  expect(byGid(all, '503')).toBeUndefined()
  expect(byGid(all, '540')).toMatchObject({ stage: 'backlog' })
  expect(byGid(all, '540')?.parentId).toBeUndefined()
  for (const gid of ['510', '520', '530', '550', '600'])
    expect(byGid(all, gid), `${gid} stays out`).toBeUndefined()
  const count = all.length

  const second = await client.runAsanaIntake({ factory: 'NB' })
  expect(second).toMatchObject({ imported: [], tracked: 4 })
  await daemon?.stop()
  daemon = undefined
  client = await start()
  const third = await client.runAsanaIntake({ factory: 'NB' })
  expect(third).toMatchObject({ imported: [], tracked: 4 })
  all = await client.listTasks()
  expect(all.length).toBe(count)

  stub.failNext('/api/1.0/sections/91/tasks', 403)
  const partial = await client.runAsanaIntake({ factory: 'NB' })
  expect(partial.incomplete).toContain('couldn’t list the tasks in Roadmap › Now')
  expect(asanaWrites()).toEqual([])
})

test('saving, stale and changing scopes, and Automation imports are checked against fresh Asana reads and one Run’s Task limit', async () => {
  let client = await start(4)
  await connect(client)
  await client.addFactory({ repo: origin, key: 'NB' })
  const factory = (await client.listFactories()).find((f) => f.key === 'NB')
  if (!factory) throw new Error('no Factory')
  asanaWorld()

  const refused = (promise: Promise<unknown>) => promise.then(() => '', String)
  const app = api(daemon?.port ?? 0, { appKey: daemon?.appToken ?? '' })
  const fileToken = api(daemon?.port ?? 0, (await readDaemonInfo(home))?.token ?? '')
  expect((await fileToken.call('GET', '/integrations/asana/workspaces')).status).toBe(403)
  expect((await fileToken.call('GET', `/factories/${factory.id}/asana-intake/check`)).status).toBe(
    403,
  )
  expect(await client.checkFactoryAsanaIntake(factory.id)).toEqual({ state: 'none' })
  stub.setPageSize(1)
  const first = await client.listAsanaWorkspaces()
  expect(first).toEqual({ items: [{ gid: '1', name: 'Acme' }], nextOffset: '1' })
  expect(await client.listAsanaWorkspaces(first.nextOffset)).toEqual({
    items: [{ gid: '2', name: 'Elsewhere' }],
  })
  expect((await client.listAsanaProjects('1')).items).toEqual([{ gid: '9', name: 'Roadmap' }])
  expect(await client.listAsanaSections('9', '1')).toEqual({
    items: [{ gid: '92', name: 'Later' }],
  })
  stub.setPageSize(2)
  stub.failNext('/api/1.0/projects/9/sections', 400)
  expect(await refused(client.listAsanaSections('9'))).toContain('saved choice stays as it was')
  expect((await app.call('GET', '/integrations/asana/workspaces?offset=a%20b')).status).toBe(400)
  expect(
    await refused(
      client.setFactoryAsanaIntake(factory.id, {
        workspace: { gid: '2', name: 'Elsewhere' },
        project: { gid: '9', name: 'Roadmap' },
      }),
    ),
  ).toContain('isn’t in Elsewhere')
  expect(
    await refused(
      client.setFactoryAsanaIntake(factory.id, { ...scope, section: { gid: '81', name: 'Inbox' } }),
    ),
  ).toContain('isn’t a section of Roadmap')
  await client.setFactoryAsanaIntake(factory.id, scope)
  expect(await client.checkFactoryAsanaIntake(factory.id)).toEqual({ state: 'current', scope })
  stub.failNext('/api/1.0/workspaces/1', 400)
  expect(await client.checkFactoryAsanaIntake(factory.id)).toMatchObject({ state: 'unreadable' })
  stub.failNext('/api/1.0/workspaces/1', 400)
  expect(
    await refused(
      client.setFactoryAsanaIntake(factory.id, { ...scope, section: { gid: '92', name: 'Later' } }),
    ),
  ).toContain('Couldn’t confirm')
  expect((await client.getSettings()).asanaIntakeScopes[factory.id]).toEqual(scope)

  let release = () => {}
  stub.holdPath(
    '/api/1.0/tasks/501/subtasks',
    new Promise<void>((resolve) => {
      release = resolve
    }),
  )
  const running = client.runAsanaIntake({ factory: 'NB' })
  await waitUntil(
    async () => stub.requests.some((r) => r.path === '/api/1.0/tasks/501/subtasks'),
    'the tree read started',
  )
  await client.setFactoryAsanaIntake(factory.id, null)
  stub.holdPath('/api/1.0/tasks/501/subtasks', undefined)
  release()
  const stopped = await running
  expect(stopped.stopped).toContain('changed during the import')
  expect(stopped.imported).toEqual([])
  expect((await client.listTasks()).filter((t) => t.source?.asana)).toEqual([])

  await client.setFactoryAsanaIntake(factory.id, scope)
  stub.setProjects([{ gid: '9', name: 'Roadmap', workspace: '1', archived: true, sections: [] }])
  expect(await refused(client.runAsanaIntake({ factory: 'NB' }))).toContain('out of date')
  expect(await client.checkFactoryAsanaIntake(factory.id)).toEqual({
    state: 'stale',
    part: 'project',
    reason: 'Roadmap is archived',
  })
  asanaWorld()

  let local = api(daemon?.port ?? 0, { appKey: daemon?.appToken ?? '' })
  const plain = await client.createTask({ factory: 'NB', title: 'Plain work' })
  const automation = (
    await local.call('POST', '/automations', {
      name: 'Asana intake',
      factory: 'NB',
      on: false,
      schedule: { kind: 'daily', at: '09:00' },
      prompt: JSON.stringify({
        steps: [
          { run: ['ted', 'asana', 'intake'] },
          { run: ['ted', 'task', 'create', '--source', 'https://app.asana.com/0/0/510', 'Later'] },
          { run: ['ted', 'task', 'create', '--source', 'https://app.asana.com/0/0/550', 'Under'] },
          {
            run: [
              'ted',
              'task',
              'create',
              '--source',
              'https://app.asana.com/0/0/501',
              '--follow-up',
              plain.displayId,
              'Again',
            ],
          },
          { waitFor: path.join(scratch, 'release') },
          { run: ['ted', 'asana', 'intake'] },
          { endTurn: true },
        ],
      }),
    })
  ).body as { id: string }
  expect((await local.call('POST', `/automations/${automation.id}/run`)).status).toBeLessThan(300)
  const runId = await waitUntil(async () => {
    const detail = (await local.call('GET', `/automations/${automation.id}`))
      .body as AutomationDetail
    return detail.history[0]?.runId
  }, 'the Automation Run started')
  await waitUntil(async () => {
    const run = (await local.call('GET', `/runs/${runId}`)).body as RunWithConversation
    return assistantTexts(run.conversation).filter((text) => text.includes('"code"')).length >= 4
  }, 'the first four commands ran')
  await hostsStarted(home)
  await daemon?.stop()
  daemon = undefined
  client = await start(4)
  const restarted = daemon as RunningDaemon | undefined
  local = api(restarted?.port ?? 0, { appKey: restarted?.appToken ?? '' })
  await writeFile(path.join(scratch, 'release'), '')
  const row = await waitUntil(async () => {
    const detail = (await local.call('GET', `/automations/${automation.id}`))
      .body as AutomationDetail
    const latest = detail.history[0]
    return latest && !['queued', 'running'].includes(latest.result.kind) ? latest : undefined
  }, 'the Automation Run finished')
  const run = (await local.call('GET', `/runs/${row.runId}`)).body as RunWithConversation
  const results = assistantTexts(run.conversation).flatMap((text) => {
    try {
      const parsed = JSON.parse(text) as { code: number; stdout: string; stderr: string }
      return typeof parsed.code === 'number' ? [parsed] : []
    } catch {
      return []
    }
  })
  expect(results.map((r) => r.code)).toEqual([0, 1, 1, 1, 0])
  expect(results[0]?.stdout).toContain('2 more items wait for the next run')
  expect(results[1]?.stderr).toContain('isn’t in Roadmap › Now')
  expect(results[2]?.stderr).toContain('already created 4 Tasks from Asana')
  expect(results[3]?.stderr).toContain('Follow-up of Asana work')
  expect(results[4]?.stdout).toContain('Imported nothing new')
  expect(results[4]?.stdout).toContain('2 more items wait for the next run')
  const all = await client.listTasks()
  expect(byGid(all, '501')).toMatchObject({ createdBy: 'automation', stage: 'backlog' })
  expect(byGid(all, '570')).toMatchObject({ createdBy: 'automation', stage: 'backlog' })
  for (const gid of ['510', '540', '550']) expect(byGid(all, gid), gid).toBeUndefined()
  expect(asanaWrites()).toEqual([])

  const imported = ['501', '502', '570'].map((gid) => byGid(all, gid) as Task)
  const projectAsks = async () =>
    (await Promise.all(imported.map((task) => client.listComments(task.id))))
      .flat()
      .filter((c) => c.purpose?.kind === 'tracker-group' && c.answer === undefined)
  const asks = await projectAsks()
  expect(asks.map((c) => c.purpose)).toEqual([
    { kind: 'tracker-group', tracker: 'asana', group: { key: '9', name: 'Roadmap' } },
  ])
  for (const task of imported) expect(task.asanaSync?.state, task.displayId).toBe('not-allowed')
  const ask = asks[0]
  if (!ask) throw new Error('no project question')
  const port = restarted?.port ?? 0
  const asRun = api(port, (await loadRunTokens(tedPaths(home).runTokenKey)).issue(row.runId ?? ''))
  const asFile = api(port, await tokenFor(home))
  for (const caller of [asRun, asFile]) {
    for (const [method, route, body] of [
      ['POST', '/integrations/asana/projects', { factoryId: factory.id, project: '9' }],
      [
        'POST',
        '/integrations/asana/projects/remove',
        { factoryId: factory.id, project: '9', list: 'allowed' },
      ],
      ['POST', `/comments/${ask.id}/answer`, { action: 'answer', choice: 'Allow' }],
      ['PATCH', '/settings', { trackerSyncGroups: { asana: { [factory.id]: ['9'] } } }],
    ] as const)
      expect((await caller.call(method, route, body)).status, `${method} ${route}`).toBe(403)
  }
  expect((await asRun.call('GET', '/integrations/asana/projects')).status).toBe(403)
  expect(
    await refused(client.updateSettings({ trackerSyncGroups: { asana: { [factory.id]: ['9'] } } })),
  ).toContain('Settings → Integrations → Asana')
  expect(await refused(client.allowAsanaProject(factory.id, '404'))).toContain('can’t open it')
  expect(await client.asanaProjects()).toEqual({
    projects: [
      { gid: '9', name: 'Roadmap', workspace: 'Acme' },
      { gid: '8', name: 'Other', workspace: 'Acme' },
      { gid: '7', name: 'Foreign', workspace: 'Elsewhere' },
    ],
    complete: true,
  })

  await client.answerRequest(ask.id, { action: 'answer', choice: 'Allow' })
  const settings = await client.getSettings()
  expect(settings.trackerSyncGroups.asana?.[factory.id]).toEqual(['9'])
  expect(settings.trackerSyncGroupAccounts.asana?.[factory.id]).toEqual({ '9': '100' })
  expect(await projectAsks()).toEqual([])
  const after = await client.listTasks()
  for (const task of imported)
    expect(byGid(after, task.source?.asana?.gid ?? '')?.asanaSync?.state, task.displayId).toBe(
      'waiting-merge',
    )

  await client.forgetAsanaProject(factory.id, '9', 'allowed')
  await client.allowAsanaProject(factory.id, '8')
  expect((await client.getSettings()).trackerSyncGroups.asana?.[factory.id]).toEqual(['8'])
  await client.removeFactory(factory.id, { key: 'NB', closePullRequests: false })
  const cleared = await client.getSettings()
  expect(cleared.trackerSyncGroups.asana?.[factory.id]).toBeUndefined()
  expect(cleared.trackerSyncGroupAccounts.asana?.[factory.id]).toBeUndefined()
})

test('the Asana template’s scheduled firings refuse without a scope or a connection, then import into Backlog once, after a schedule change and a restart too', async () => {
  clock = Date.parse('2026-11-09T08:55:00Z')
  let client = await start()
  await client.addFactory({ repo: origin, key: 'NB' })
  const factory = (await client.listFactories()).find((f) => f.key === 'NB')
  if (!factory) throw new Error('no Factory')
  asanaWorld()
  const template = (await client.automationTemplates()).find((t) => t.id === 'asana')
  if (!template) throw new Error('missing asana template')
  expect(template.schedule).toEqual({ kind: 'every', every: 30, unit: 'minutes' })
  expect(template.prompt).toContain('ted asana intake')
  const automation = await client.createAutomation({
    template: 'asana',
    factory: 'NB',
    name: template.name,
    schedule: template.schedule,
    prompt: `${template.prompt}\n${JSON.stringify({
      steps: [{ run: ['ted', 'asana', 'intake'] }, { endTurn: true }],
    })}`,
  })
  expect(automation).toMatchObject({ template: 'asana', on: true })

  let firings = 0
  const fire = async (): Promise<{
    row: AutomationRun
    results: { code: number; stdout: string; stderr: string }[]
  }> => {
    const { automation: current } = await client.getAutomation(automation.id)
    const slot = current.nextFirings[0]
    if (!slot) throw new Error('no next firing')
    clock = Date.parse(slot) + 10_000
    firings++
    const row = await waitUntil(async () => {
      const { history } = await client.getAutomation(automation.id)
      const latest = history[0]
      return history.length === firings &&
        latest &&
        !['queued', 'running'].includes(latest.result.kind)
        ? latest
        : undefined
    }, `firing ${firings} finished`)
    expect(row).toMatchObject({ trigger: 'scheduled', slotAt: slot })
    return { row, results: commandResults(await client.getRun(row.runId ?? '')) }
  }

  const noScope = await fire()
  expect(noScope.row.result.kind).toBe('no-new-tasks')
  expect(noScope.results).toMatchObject([{ code: 1 }])
  expect(noScope.results[0]?.stderr).toContain('Choose one in Configuration first')

  await connect(client)
  await client.setFactoryAsanaIntake(factory.id, scope)
  await client.disconnectAsana()
  const disconnected = await fire()
  expect(disconnected.row.result.kind).toBe('no-new-tasks')
  expect(disconnected.results[0]?.stderr).toContain('Connect Asana')
  expect((await client.listTasks()).filter((t) => t.source?.asana)).toEqual([])

  await connect(client)
  const hourly = await client.editAutomation(automation.id, {
    schedule: { kind: 'every', every: 1, unit: 'hours' },
  })
  const [next, after] = hourly.nextFirings.map(Date.parse)
  expect((after ?? 0) - (next ?? 0)).toBe(60 * 60 * 1000)
  const imported = await fire()
  expect(imported.row.slotAt).toBe(hourly.nextFirings[0])
  expect(imported.results).toMatchObject([{ code: 0 }])
  expect(imported.row.result).toMatchObject({ kind: 'created' })
  let all = await client.listTasks()
  for (const gid of ['501', '502', '504', '540', '570'])
    expect(byGid(all, gid), gid).toMatchObject({ stage: 'backlog', createdBy: 'automation' })
  for (const gid of ['510', '520', '530'])
    expect(byGid(all, gid), `${gid} stays out`).toBeUndefined()
  const count = all.length

  const again = await fire()
  expect(again.row.result.kind).toBe('no-new-tasks')
  expect(again.results[0]?.stdout).toContain('Imported nothing new')
  await daemon?.stop()
  daemon = undefined
  client = await start()
  const restarted = await fire()
  expect(restarted.row.result.kind).toBe('no-new-tasks')
  expect(restarted.results[0]?.stdout).toContain('Imported nothing new')
  all = await client.listTasks()
  expect(all.length).toBe(count)
  expect(asanaWrites()).toEqual([])
})
