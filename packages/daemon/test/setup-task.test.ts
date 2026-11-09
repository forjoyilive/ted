import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type {
  Banner,
  CheckRun,
  Comment,
  Factory,
  InboxItem,
  RunSlots,
  Task,
  TaskApp,
} from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { resolveWorkflow, setupWorkflow } from '../src/workflow/resolve.ts'
import {
  api,
  commitToOrigin,
  killAppHosts,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  waitUntil,
} from './helpers.ts'

const execFileAsync = promisify(execFile)
const stubGh = fileURLToPath(new URL('./fixtures/stub-gh.ts', import.meta.url))
const stubApp = fileURLToPath(new URL('./fixtures/stub-app.ts', import.meta.url))

let home: string
let cleanup: () => Promise<void>
let scratch: string
let daemon: RunningDaemon | undefined
const savedEnv = { ...process.env }

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await realpath(await mkdtemp(path.join(tmpdir(), 'ted-setup-task-')))
  await makeOriginRepo(scratch)
  const ghState = path.join(scratch, 'gh.json')
  await writeFile(
    ghState,
    JSON.stringify({
      paths: {
        'repos/acme/widgets': {
          body: { full_name: 'acme/widgets', default_branch: 'main', permissions: { push: true } },
        },
        'repos/acme/widgets/commits?per_page=1': { body: [] },
      },
    }),
  )
  process.env.TED_STUB_GH = ghState
  process.env.GIT_CONFIG_COUNT = '1'
  process.env.GIT_CONFIG_KEY_0 = `url.file://${scratch}/.insteadOf`
  process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/'
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killAppHosts(home)
  await killRunHosts(home)
  process.env = { ...savedEnv }
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

async function start() {
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    integrations: { ghBin: stubGh },
  })
  const client = api(daemon.port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  return { ...client, ok }
}

type Client = Awaited<ReturnType<typeof start>>

const tasks = (client: Client) => client.ok<Task[]>('GET', '/tasks')
const banners = (client: Client) => client.ok<Banner[]>('GET', '/banners')
const inbox = (client: Client) => client.ok<InboxItem[]>('GET', '/inbox')
const steps = (...list: unknown[]) => JSON.stringify({ steps: list })

async function addWidgets(client: Client, showTutorial = false): Promise<Factory> {
  return client.ok<Factory>('POST', '/factories', {
    name: 'Widgets',
    key: 'WD',
    repos: [{ source: { remote: 'acme/widgets' }, name: 'widgets' }],
    showTutorial,
  })
}

const setupTask = (client: Client) =>
  waitUntil(
    async () => (await tasks(client)).find((t) => t.setup && t.displayId === 'WD-1'),
    'the setup Task WD-1',
  )

const getTask = async (client: Client, id: string) => {
  const task = (await tasks(client)).find((t) => t.id === id)
  if (!task) throw new Error(`no Task ${id}`)
  return task
}

describe('creating the setup Task', () => {
  test('cloning a new Factory creates WD-1 at the front of the queue, with a Setup banner', async () => {
    const client = await start()
    await client.ok('PATCH', '/settings', { maxWorkingRuns: 1 })
    const notes = path.join(scratch, 'other', 'notes.git')
    await execFileAsync('git', [
      'clone',
      '--bare',
      path.join(scratch, 'acme', 'widgets.git'),
      notes,
    ])
    await client.ok('POST', '/dev/factories', { repo: notes, key: 'NB' })
    const hold = path.join(scratch, 'hold')
    const busy = await client.ok<Task>('POST', '/tasks', {
      title: steps({ waitFor: hold }, { endTurn: true }),
      factory: 'NB',
    })
    await client.ok('POST', `/tasks/${busy.id}/start`)
    const urgent = await client.ok<Task>('POST', '/tasks', {
      title: 'Urgent work',
      factory: 'NB',
      priority: 'urgent',
    })
    await client.ok('POST', `/tasks/${urgent.id}/start`)

    await addWidgets(client)
    const setup = await setupTask(client)
    expect(setup).toMatchObject({
      title: 'Set up Widgets',
      priority: 'urgent',
      clarifyDepth: 'grilling',
      createdBy: 'setup',
      setup: true,
    })
    const slots = await waitUntil(async () => {
      const current = await client.ok<RunSlots>('GET', '/slots')
      return current.queue.length === 2 ? current : undefined
    }, 'both Tasks queued')
    expect(slots.queue.map((q) => (q.kind === 'task' ? [q.displayId, q.setup] : []))).toEqual([
      ['WD-1', true],
      ['NB-2', undefined],
    ])
    const banner = (await banners(client)).find((b) => b.problem === 'setup-unfinished')
    expect(banner).toMatchObject({
      severity: 'warning',
      text: 'Setup isn’t finished · Tasks use TED’s defaults until WD-1 merges',
      action: { label: 'Open WD-1', opens: { kind: 'task', taskId: setup.id } },
    })
    await writeFile(hold, '')
  })

  test('a Task created while the Factory clones leaves WD-1 for the setup Task', async () => {
    const client = await start()
    const factory = await addWidgets(client)
    const early = await client.ok<Task>('POST', '/tasks', { title: 'Early', factory: 'WD' })
    expect(early.displayId).toBe('WD-2')
    await waitUntil(
      async () =>
        (await client.ok<Factory[]>('GET', '/factories')).find((f) => f.id === factory.id)?.cloned,
      'the clone',
    )
    expect((await setupTask(client)).number).toBe(1)
  })

  test('a repo that already has .ted/ gets its setup Task in Backlog and no banner', async () => {
    await commitToOrigin(scratch, { '.ted/workflow.yaml': 'version: 1\n' })
    const client = await start()
    await addWidgets(client)
    const setup = await setupTask(client)
    await new Promise((resolve) => setTimeout(resolve, 300))
    const now = await getTask(client, setup.id)
    expect(now.stage).toBe('backlog')
    expect(now.statuses).not.toContain('queued')
    expect(now.description).toMatch(/as a diff/)
    expect((await banners(client)).some((b) => b.problem === 'setup-unfinished')).toBe(false)
  })

  test('an empty repo, whose Workflow TED can’t read yet, still gets its setup Task started', async () => {
    const bare = path.join(scratch, 'acme', 'widgets.git')
    await rm(bare, { recursive: true, force: true })
    await execFileAsync('git', ['init', '--bare', '--quiet', '--initial-branch=main', bare])
    const client = await start()
    await addWidgets(client)
    const setup = await setupTask(client)
    const started = await waitUntil(async () => {
      const now = await getTask(client, setup.id)
      return now.stage !== 'backlog' ? now : undefined
    }, 'the setup Task to start')
    expect(started.stage).not.toBe('backlog')
  })

  test('New setup Task is refused while one is open, and the banner offers one when none is', async () => {
    await commitToOrigin(scratch, { '.ted/workflow.yaml': 'version: 1\n' })
    const client = await start()
    const factory = await addWidgets(client)
    const setup = await setupTask(client)
    const refused = await client.call('POST', `/factories/${factory.id}/setup-task`)
    expect(refused.status).toBe(409)
    expect(refused.body).toMatchObject({ error: 'WD-1 is already setting up Widgets' })
    await client.ok('POST', `/tasks/${setup.id}/archive`, {})
    const again = await client.ok<Task>('POST', `/factories/${factory.id}/setup-task`)
    expect(again).toMatchObject({ displayId: 'WD-2', setup: true, title: 'Set up Widgets' })
  })
})

describe('the setup Workflow', () => {
  test('forces Clarify at grilling depth and the Design and Review Gates, and targets the default branch', () => {
    const base = resolveWorkflow([
      {
        kind: 'library',
        files: {},
        valid: true,
        problems: [],
        settings: {
          order: ['intake', 'work', 'merge'],
          stages: { design: { gate: false }, review: { enabled: false, gate: false } },
          repos: [
            { name: 'app', base_branch: 'develop' },
            { name: 'api', base_branch: 'next' },
          ],
        },
        stageFiles: { intake: 'Intake', design: 'Design', work: 'Work' },
      },
    ])
    const setup = setupWorkflow(base, (stage) => `setup ${stage}`)
    expect(setup.stages).toEqual([
      'backlog',
      'intake',
      'clarify',
      'design',
      'work',
      'review',
      'merge',
      'done',
    ])
    expect(setup.settings.stages.design?.gate).toBe(true)
    expect(setup.settings.stages.review?.gate).toBe(true)
    expect(setup.settings.stages.clarify?.depth).toBe('grilling')
    expect(setup.settings.repos).toEqual([{ name: 'app' }, { name: 'api', base_branch: 'next' }])
    expect(setup.stageFile('design')?.text).toBe('Design\n\nsetup design')
    expect(base.stages).toEqual(['backlog', 'intake', 'work', 'merge', 'done'])
  })
})

describe('the proposal', () => {
  const proposal = (checks: unknown[]) => ({
    title: 'Proposed setup for Widgets',
    summary: 'One repo with a test script. I ran each Check on main.',
    setup: {
      workflow: [{ stage: 'intake' }, { stage: 'design', setting: 'Gate on' }],
      checks,
      apps: [
        {
          name: 'Web',
          kind: 'web',
          ready: 'ready in 9s at localhost:5174',
          passed: true,
        },
      ],
      files: [
        { path: '.ted/notes.md', about: 'Factory notes' },
        { path: '.ted/workflow.yaml', about: 'Checks and Stage settings' },
        { path: '.ted/stages/validate.md', about: 'How to check Widgets' },
      ],
      defaults: 'Left as TED’s defaults: agents and permissions.',
    },
  })

  test('Design and Review Gates hold the setup Task, the proposal shows tried Checks, and Validate runs only approved Checks from the branch', async () => {
    await commitToOrigin(scratch, {
      '.ted/workflow.yaml': [
        'version: 1',
        'order: [intake, design, work, validate, review, merge]',
        'stages:',
        '  design: { gate: false }',
        '  review: { gate: false }',
        '',
      ].join('\n'),
    })
    const client = await start()
    await addWidgets(client, true)
    const setup = await setupTask(client)
    const brief = path.join(scratch, 'brief.md')
    await writeFile(
      brief,
      '## Goal\n\nSet up Widgets\n\n## Decisions so far\n\nNone.\n\n## Current state\n\nReading.\n\n## Open questions\n\nNone.\n\n## Next step\n\nPropose.\n',
    )
    const missingSetup = path.join(scratch, 'plain.json')
    await writeFile(missingSetup, JSON.stringify({ summary: 'No setup section.' }))
    const design = path.join(scratch, 'design.json')
    await writeFile(
      design,
      JSON.stringify(
        proposal([
          { name: 'Unit', command: 'true', passed: true, durationMs: 1200 },
          {
            name: 'End-to-end',
            command: 'false',
            passed: false,
            durationMs: 900,
            reason: 'Fails on main: needs the API running',
          },
        ]),
      ),
    )
    const branchSettings = path.join(scratch, 'branch-workflow.yaml')
    await writeFile(
      branchSettings,
      [
        'version: 1',
        'order: [intake, design, work, validate, review, merge]',
        'stages:',
        '  validate:',
        '    checks:',
        '      - { name: Unit, run: "true" }',
        `      - { name: Sneaky, run: "touch ${path.join(scratch, 'sneaky')}" }`,
        'repos:',
        '  - name: widgets',
        '    apps:',
        '      - name: Web',
        '        kind: command',
        `        run: "'${process.execPath}' '${stubApp}'"`,
        '      - name: Sneaky App',
        '        kind: command',
        `        run: "touch ${path.join(scratch, 'sneaky-app')}"`,
        '',
      ].join('\n'),
    )
    const writeSettings = `grep -q Sneaky .ted/workflow.yaml || (cp ${branchSettings} .ted/workflow.yaml && git add .ted && git -c user.name=T -c user.email=t@example.com commit -qm settings)`
    const each = [
      { run: ['ted', 'comment', '--tutorial', 'Each Stage, explained.'] },
      { run: ['ted', 'brief', 'write', '--file', brief] },
      { run: ['ted', 'outcome', 'advance', '--skip'] },
      { run: ['ted', 'outcome', 'advance', '--design', missingSetup] },
      { run: ['ted', 'outcome', 'advance', '--design', design] },
      { run: ['sh', '-c', writeSettings] },
      { run: ['ted', 'outcome', 'advance'] },
      { endTurn: true },
    ]
    await client.ok('PUT', `/tasks/${setup.id}`, { title: steps({ everyMessage: each }, ...each) })
    await client.ok('POST', `/tasks/${setup.id}/start`)

    const answer = async (stage: string) => {
      const item = await waitUntil(
        async () => (await inbox(client)).find((i) => i.request.stage === stage),
        `the ${stage} request`,
      )
      await client.ok('POST', `/comments/${item.request.id}/answer`, { action: 'approve' })
      return item.request
    }
    await answer('clarify')
    const review = await answer('design')
    expect(review).toMatchObject({
      kind: 'review',
      title: 'Proposed setup for Widgets',
      design: {
        summary: 'One repo with a test script. I ran each Check on main.',
        setup: {
          checks: [
            { name: 'Unit', command: 'true', passed: true, durationMs: 1200 },
            { name: 'End-to-end', passed: false, reason: 'Fails on main: needs the API running' },
          ],
          apps: [{ name: 'Web', kind: 'web', passed: true }],
          files: [
            { path: '.ted/notes.md' },
            { path: '.ted/workflow.yaml' },
            { path: '.ted/stages/validate.md' },
          ],
        },
      },
    })

    const checkRun = await waitUntil(async () => {
      const runs = await client.ok<CheckRun[]>('GET', `/tasks/${setup.id}/check-runs`)
      return runs.find((r) => r.checks.every((c) => c.state !== 'waiting' && c.state !== 'running'))
    }, 'the Validate Checks')
    expect(checkRun.checks.map((c) => c.name)).toEqual(['Unit', 'TED settings'])
    expect(existsSync(path.join(scratch, 'sneaky'))).toBe(false)
    const web = await waitUntil(async () => {
      const apps = await client.ok<TaskApp[]>('GET', `/tasks/${setup.id}/apps`)
      return apps.find((a) => a.name === 'Web' && a.state === 'running') && apps
    }, 'TED to start the proposed App')
    expect(web.map((a) => a.name)).toEqual(['Web'])
    expect(existsSync(path.join(scratch, 'sneaky-app'))).toBe(false)
    await answer('review')

    const comments = await client.ok<Comment[]>('GET', `/tasks/${setup.id}/comments`)
    expect(comments.filter((c) => c.tutorial).map((c) => c.body)).toContain(
      'Each Stage, explained.',
    )
  }, 60_000)

  test('only a setup Task can post a setup proposal or a tutorial Comment', async () => {
    await commitToOrigin(scratch, {
      '.ted/workflow.yaml': 'version: 1\norder: [intake, design, work, merge]\n',
    })
    const client = await start()
    await client.ok('POST', '/dev/factories', {
      repo: path.join(scratch, 'acme', 'widgets.git'),
      key: 'NB',
    })
    const brief = path.join(scratch, 'brief.md')
    await writeFile(
      brief,
      '## Goal\n\nX\n\n## Decisions so far\n\nNone.\n\n## Current state\n\nX\n\n## Open questions\n\nNone.\n\n## Next step\n\nX\n',
    )
    const design = path.join(scratch, 'design.json')
    await writeFile(design, JSON.stringify(proposal([])))
    const task = await client.ok<Task>('POST', '/tasks', {
      factory: 'NB',
      title: steps(
        {
          everyMessage: [
            { run: ['ted', 'comment', '--tutorial', 'Not mine to post.'] },
            { run: ['ted', 'brief', 'write', '--file', brief] },
            { run: ['ted', 'outcome', 'advance', '--design', design] },
            { endTurn: true },
          ],
        },
        { run: ['ted', 'outcome', 'advance'] },
        { endTurn: true },
      ),
    })
    await client.ok('POST', `/tasks/${task.id}/start`)
    const said = await waitUntil(async () => {
      const t = await getTask(client, task.id)
      if (t.stage !== 'design' || t.runs[0]?.state !== 'idle') return undefined
      const text = JSON.stringify((await client.getRun(t.leadRunId ?? '')).conversation)
      return text.includes('# Design') && text.includes('tutorial Comments') ? text : undefined
    }, 'Design to finish its turn')
    expect(said).toContain('only a setup Task proposes TED settings')
    expect(said).toContain('only a setup Task’s Task Lead posts tutorial Comments')
  }, 30_000)
})
