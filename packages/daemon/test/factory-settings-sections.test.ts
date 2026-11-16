import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type {
  Banner,
  CheckTry,
  CheckTryOutput,
  Factory,
  FactorySettingsChanges,
  FactorySettingsView,
  SaveSettingsResult,
  SettingsPreview,
} from '@ted/protocol'
import { settingsInput } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { parse } from 'yaml'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { defaultsDir } from '../src/workflow/layers.ts'
import {
  api,
  commitToOrigin,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  tokenFor,
  waitUntil,
} from './helpers.ts'

const run = promisify(execFile)
const until = (check: () => Promise<boolean>) => waitUntil(check, 'the condition', 20_000)

let home: string
let cleanup: () => Promise<void>
let scratch: string
let origin: string
let ghState: string
let daemon: RunningDaemon | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await realpath(await mkdtemp(path.join(tmpdir(), 'ted-settings-sections-')))
  origin = await makeOriginRepo(scratch)
  ghState = path.join(scratch, 'gh.json')
  process.env.TED_STUB_GH = ghState
  process.env.TED_STUB_GH_LOG = path.join(scratch, 'gh.jsonl')
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  delete process.env.TED_STUB_GH
  delete process.env.TED_STUB_GH_LOG
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

const workflowYaml = [
  'version: 1',
  'repos:',
  '  - name: widgets',
  '    worktree:',
  '      setup: echo set-up >> "$HOME_LOG"',
  '      env:',
  '        HOME_LOG: setup.log',
  'stages:',
  '  validate:',
  '    checks:',
  '      - { name: Typecheck, run: npm run typecheck }',
  '',
].join('\n')

async function start(
  options: {
    workflow?: string
    files?: Record<string, string>
    scratchMaxAgeMs?: number
    freeBytes?: number
  } = {},
) {
  await writeFile(ghState, JSON.stringify({ merge: { origin, updateBase: true } }))
  await commitToOrigin(scratch, {
    '.ted/workflow.yaml': options.workflow ?? workflowYaml,
    '.gitignore': 'setup.log\n',
    ...options.files,
  })
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    ...(options.scratchMaxAgeMs !== undefined && { scratchMaxAgeMs: options.scratchMaxAgeMs }),
    ...(options.freeBytes !== undefined && {
      disk: { freeBytes: async () => options.freeBytes ?? 0, checkEveryMs: 20 },
    }),
  })
  const client = api(daemon.port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  const factory = await ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const id = factory.id
  const settings = (refresh?: 'first') =>
    ok<FactorySettingsView>(
      'GET',
      `/factories/${id}/settings${refresh ? `?refresh=${refresh}` : ''}`,
    )
  const preview = (changes: FactorySettingsChanges) =>
    ok<SettingsPreview>('POST', `/factories/${id}/settings/preview`, changes)
  const save = async (changes: FactorySettingsChanges, version: string, extra = {}) => {
    await writeFile(ghState, JSON.stringify({ merge: { origin, updateBase: true } }))
    return ok<SaveSettingsResult>('POST', `/factories/${id}/settings/save`, {
      changes,
      mode: 'merge',
      version,
      ...extra,
    })
  }
  return { ...client, ok, factory, settings, preview, save }
}

function unchanged(view: FactorySettingsView): FactorySettingsChanges {
  return { repos: view.repos.map((r) => structuredClone(settingsInput(r))) }
}

async function originFile(file: string): Promise<string | undefined> {
  return run('git', ['show', `main:${file}`], { cwd: origin }).then(
    ({ stdout }) => stdout,
    () => undefined,
  )
}

function blobHash(text: string): string {
  return createHash('sha1')
    .update(`blob ${Buffer.byteLength(text)}\0`)
    .update(text)
    .digest('hex')
    .slice(0, 7)
}

describe('Factory settings: Workflow', () => {
  test('the Workflow table shows each Stage with its settings and where its file comes from', async () => {
    const client = await start({ files: { '.ted/stages/validate.md': '# Validate here\n' } })
    const view = await client.settings()
    expect(view.stages.map((s) => s.id)).toEqual([
      'backlog',
      'intake',
      'clarify',
      'design',
      'work',
      'validate',
      'review',
      'merge',
      'done',
    ])
    const row = (id: string) => view.stages.find((s) => s.id === id)
    expect(row('design')).toMatchObject({ enabled: true, gate: true, maxBack: 3, from: 'ted' })
    expect(row('clarify')).toMatchObject({ depth: 'auto' })
    expect(row('validate')).toMatchObject({
      maxBack: 5,
      from: 'factory',
      factoryFile: '# Validate here\n',
    })
    expect(row('validate')?.inherited?.layer).toBe('ted')
    expect(row('backlog')).toMatchObject({ enabled: true, from: 'ted' })
  })

  test('turning the Design Gate off and changing Send-backs saves to workflow.yaml', async () => {
    const client = await start()
    const view = await client.settings()
    const changes = {
      ...unchanged(view),
      stages: { design: { gate: false }, work: { maxBack: 2 }, clarify: { depth: 'few' as const } },
    }
    const preview = await client.preview(changes)
    expect(preview.valid).toBe(true)
    expect(preview.turnsOnBypass).toBe(false)
    await client.save(changes, view.version)
    const yaml = await originFile('.ted/workflow.yaml')
    expect(yaml).toContain('design:')
    expect(yaml).toMatch(/gate: false/)
    expect(yaml).toMatch(/max_back: 2/)
    expect(yaml).toMatch(/depth: few/)
    expect(yaml).toContain('- { name: Typecheck, run: npm run typecheck }')
    const after = await client.settings()
    expect(after.stages.find((s) => s.id === 'design')?.gate).toBe(false)
    expect(after.stages.find((s) => s.id === 'work')?.maxBack).toBe(2)
  })

  test('the Validate round settings, the Work and Merge switches show their defaults, save to workflow.yaml and turn off again', async () => {
    const client = await start()
    const view = await client.settings()
    const validate = (v: typeof view) => v.stages.find((s) => s.id === 'validate')
    expect(validate(view)).toMatchObject({ p1OnlyFrom: false, subAgents: false })
    expect(view.stages.find((s) => s.id === 'work')).not.toHaveProperty('p1OnlyFrom')

    await client.save(
      {
        ...unchanged(view),
        stages: {
          validate: { p1OnlyFrom: 3, subAgents: true },
          work: { leadClosesFailures: true },
          merge: { commitTitles: false },
        },
      },
      view.version,
    )
    const yaml = await originFile('.ted/workflow.yaml')
    expect(yaml).toMatch(/p1_only_from: 3/)
    expect(yaml).toMatch(/sub_agents: true/)
    expect(yaml).toMatch(/lead_closes_failures: true/)
    expect(yaml).toMatch(/commit_titles: false/)
    expect(yaml).toContain('- { name: Typecheck, run: npm run typecheck }')
    const on = await client.settings()
    expect(validate(on)).toMatchObject({ p1OnlyFrom: 3, subAgents: true, maxBack: 5 })
    expect(view.stages.find((s) => s.id === 'work')).toMatchObject({ leadClosesFailures: false })
    expect(on.stages.find((s) => s.id === 'work')).toMatchObject({ leadClosesFailures: true })
    expect(view.stages.find((s) => s.id === 'merge')).toMatchObject({ commitTitles: true })
    expect(on.stages.find((s) => s.id === 'merge')).toMatchObject({ commitTitles: false })

    for (const stages of [
      { validate: { p1OnlyFrom: 1 } },
      { validate: { subAgents: 'yes' } },
      { work: { p1OnlyFrom: 3 } },
      { work: { subAgents: true } },
      { validate: { leadClosesFailures: true } },
      { work: { commitTitles: false } },
    ]) {
      const refused = await client.call(
        'POST',
        `/factories/${client.factory.id}/settings/preview`,
        {
          ...unchanged(on),
          stages,
        },
      )
      expect(refused.status).toBe(400)
    }
  })

  test('Intake and Work can’t be turned off', async () => {
    const client = await start()
    const view = await client.settings()
    const preview = await client.preview({
      ...unchanged(view),
      stages: { work: { enabled: false } },
    })
    expect(preview.valid).toBe(false)
    expect(preview.problems.map((p) => p.message)).toContain('Work can’t be turned off')
  })

  test('Override copies the inherited Stage file and writes based_on; Reset deletes the copy', async () => {
    const client = await start()
    const view = await client.settings()
    const review = view.stages.find((s) => s.id === 'review')
    const inherited = await readFile(path.join(defaultsDir, 'stages', 'review.md'), 'utf8')
    expect(review?.inherited).toEqual({ layer: 'ted', text: inherited })

    await client.save(
      { ...unchanged(view), stageFiles: { review: `${inherited}\nAlso check the docs.\n` } },
      view.version,
    )
    expect(await originFile('.ted/stages/review.md')).toBe(`${inherited}\nAlso check the docs.\n`)
    expect(parse((await originFile('.ted/workflow.yaml')) ?? '').stages.review.based_on).toBe(
      blobHash(inherited),
    )
    const overridden = await client.settings()
    expect(overridden.stages.find((s) => s.id === 'review')).toMatchObject({
      from: 'factory',
      basedOn: blobHash(inherited),
    })

    await client.save(
      { ...unchanged(overridden), stageFiles: { review: null } },
      overridden.version,
    )
    expect(await originFile('.ted/stages/review.md')).toBeUndefined()
    expect(await originFile('.ted/workflow.yaml')).not.toContain('based_on')
    expect((await client.settings()).stages.find((s) => s.id === 'review')?.from).toBe('ted')
  })

  test('an unknown Stage file shows as ignored', async () => {
    const client = await start({ files: { '.ted/stages/security.md': '# Security\n' } })
    expect((await client.settings()).ignoredStageFiles).toEqual(['.ted/stages/security.md'])
  })
})

describe('Factory settings: Agents, Permissions and notes', () => {
  test('agent rows show where each choice comes from, and save or reset', async () => {
    const client = await start({
      workflow: `${workflowYaml.replace('version: 1\n', 'version: 1\nreviewer: codex\n')}`,
    })
    const view = await client.settings()
    expect(view.agents.map((a) => [a.role, a.from])).toEqual([
      ['lead', 'ted'],
      ['reviewer', 'factory'],
      ['planner', 'ted'],
    ])
    expect(view.agents.find((a) => a.role === 'reviewer')?.own).toEqual({ agent: 'codex' })
    await client.save(
      {
        ...unchanged(view),
        agents: { lead: { agent: 'claude', model: 'opus', effort: 'high' }, reviewer: null },
      },
      view.version,
    )
    const yaml = await originFile('.ted/workflow.yaml')
    expect(yaml).toContain('lead: { agent: claude, model: opus, effort: high }')
    expect(yaml).not.toContain('reviewer')
    const after = await client.settings()
    expect(after.agents.find((a) => a.role === 'lead')).toMatchObject({
      from: 'factory',
      own: { agent: 'claude', model: 'opus', effort: 'high' },
    })
    expect(after.agents.find((a) => a.role === 'reviewer')?.from).toBe('ted')
  })

  test('an agent row must name claude, codex or antigravity and a model name', async () => {
    const client = await start()
    const view = await client.settings()
    const refused = async (lead: unknown) =>
      client.call('POST', `/factories/${client.factory.id}/settings/preview`, {
        ...unchanged(view),
        agents: { lead },
      })
    expect(await refused({ agent: 'gpt' })).toEqual({
      status: 400,
      body: { error: 'lead.agent must be claude, codex or antigravity' },
    })
    expect(await refused({ agent: 'claude', model: 'opus; rm -rf ~' })).toEqual({
      status: 400,
      body: { error: 'lead.model must be a model name, such as opus or gpt-5.5' },
    })
    expect(await refused('claude')).toEqual({
      status: 400,
      body: { error: 'lead must be an object' },
    })
  })

  test('permission mode saves locally after confirmation; repo settings only save the Run limit', async () => {
    const client = await start()
    const view = await client.settings()
    expect(view.permissions).toBe('auto')
    const route = `/factories/${client.factory.id}/permissions`
    expect((await client.call('PUT', route, { mode: 'bypass' })).status).toBe(409)
    await client.ok('PUT', route, { mode: 'bypass', confirmBypass: true })
    expect((await client.settings()).permissions).toBe('bypass')
    expect(await originFile('.ted/workflow.yaml')).not.toContain('bypass')
    const changes = { ...unchanged(view), maxWorkingRuns: 3 }
    expect((await client.preview(changes)).turnsOnBypass).toBe(false)
    expect(
      (
        await client.call('POST', `/factories/${client.factory.id}/settings/save`, {
          changes: { ...changes, permissions: 'bypass' },
          mode: 'merge',
          version: view.version,
          confirmBypass: true,
        })
      ).status,
    ).toBe(400)
    await client.save(changes, view.version)
    const after = await client.settings()
    expect(after).toMatchObject({ permissions: 'bypass', maxWorkingRuns: 3 })
    await client.ok('PUT', route, { mode: 'auto' })
    expect((await client.settings()).permissions).toBe('auto')
  })

  test('Factory notes save to .ted/notes.md', async () => {
    const client = await start()
    const view = await client.settings()
    expect(view.notes).toBe('')
    const changes = { ...unchanged(view), notes: '# Notebook\n\n## Product\nA notes app.\n' }
    const preview = await client.preview(changes)
    expect(preview.files.map((f) => f.path)).toEqual(['.ted/notes.md'])
    await client.save(changes, view.version)
    expect(await originFile('.ted/notes.md')).toBe('# Notebook\n\n## Product\nA notes app.\n')
    expect((await client.settings()).notes).toBe('# Notebook\n\n## Product\nA notes app.\n')
  })
})

describe('Factory settings: Checks', () => {
  test('Checks and Cleanup list, add and save to stages.validate.checks and stages.cleanup', async () => {
    const client = await start()
    const view = await client.settings()
    expect(view.checks).toEqual([{ was: 0, name: 'Typecheck', run: 'npm run typecheck' }])
    expect(view.cleanup).toEqual({ enabled: false, steps: [] })
    const steps = [
      { name: 'Tell Asana', instruction: 'Comment on the Asana task.' },
      { name: 'Stop stack', command: 'docker compose down', timeout: '2m' },
    ]
    await client.save(
      {
        ...unchanged(view),
        checks: [
          { was: 0, name: 'Typecheck', run: 'npm run typecheck' },
          { name: 'Unit tests', run: 'npm test', timeout: '15m' },
        ],
        cleanup: { enabled: true, steps },
      },
      view.version,
    )
    const yaml = await originFile('.ted/workflow.yaml')
    expect(yaml).toContain('- { name: Typecheck, run: npm run typecheck }')
    expect(yaml).toMatch(/name: Unit tests[\s\S]*run: npm test[\s\S]*timeout: 15m/)
    expect(parse(yaml ?? '').stages.cleanup).toEqual({ enabled: true, steps })
    const saved = await client.settings()
    expect(saved.checks.map((c) => c.name)).toEqual(['Typecheck', 'Unit tests'])
    expect(saved.cleanup).toEqual({ enabled: true, steps })
  })

  test('a Check or a Cleanup step without a command isn’t saved', async () => {
    const client = await start()
    const view = await client.settings()
    const preview = await client.preview({
      ...unchanged(view),
      checks: [{ name: 'Lint', run: '' }],
    })
    expect(preview.valid).toBe(false)
    const cleanupPreview = await client.preview({
      ...unchanged(view),
      cleanup: { enabled: true, steps: [{ name: 'Stop stack', command: '' }] },
    })
    expect(cleanupPreview.valid).toBe(false)
    expect(cleanupPreview.problems.map((p) => p.message)).toContain(
      'Cleanup step Stop stack: Write the command.',
    )
  })

  test('Run now runs in a scratch worktree on the base branch; setup runs only when it is made', async () => {
    const client = await start()
    const id = client.factory.id
    const tryCheck = async (body: Record<string, unknown>) => {
      const started = await client.ok<CheckTry>('POST', `/factories/${id}/checks/try`, body)
      expect(started.state).toBe('running')
      let done: CheckTry | undefined
      await until(async () => {
        const view = await client.settings()
        done = view.tries.find(
          (t) => t.startedAt === started.startedAt && t.name === body.name && t.state !== 'running',
        )
        return done !== undefined
      })
      return done as CheckTry
    }
    const first = await tryCheck({
      name: 'Probe',
      run: 'test -f README.md && cat setup.log && echo stray > stray.txt',
    })
    expect(first).toMatchObject({ state: 'passed', exitCode: 0, repo: 'widgets' })
    const output = await client.ok<CheckTryOutput>(
      'GET',
      `/factories/${id}/checks/try/output?name=Probe`,
    )
    expect(output.text).toContain('set-up')

    const second = await tryCheck({
      name: 'Probe',
      run: 'test ! -f stray.txt && grep -c set-up setup.log',
    })
    expect(second.state).toBe('passed')
    const again = await client.ok<CheckTryOutput>(
      'GET',
      `/factories/${id}/checks/try/output?name=Probe`,
    )
    expect(again.text.trim()).toBe('1')
    const worktrees = await readdir(path.join(home, 'scratch'))
    expect(worktrees.length).toBeGreaterThan(0)
  })

  test('a command that isn’t found raises the setup-suggested banner, and Stop stops a Check', async () => {
    const client = await start()
    const id = client.factory.id
    await client.ok('POST', `/factories/${id}/checks/try`, {
      name: 'Missing',
      run: 'no-such-command-ted-test',
    })
    await until(async () =>
      (await client.ok<Banner[]>('GET', '/banners')).some((b) =>
        b.text.includes('no-such-command-ted-test'),
      ),
    )
    await client.ok('POST', `/factories/${id}/checks/try`, { name: 'Slow', run: 'sleep 30' })
    await client.ok('POST', `/factories/${id}/checks/try/stop`, { name: 'Slow' })
    await until(async () =>
      (await client.settings()).tries.some((t) => t.name === 'Slow' && t.state === 'stopped'),
    )
  })

  test('a scratch worktree older than its time limit is deleted and made again', async () => {
    const client = await start({ scratchMaxAgeMs: 1500 })
    const id = client.factory.id
    const finished = (name: string) =>
      until(async () =>
        (await client.settings()).tries.some((t) => t.name === name && t.state !== 'running'),
      )
    await client.ok('POST', `/factories/${id}/checks/try`, { name: 'A', run: 'true' })
    await finished('A')
    await until(async () => (await readdir(path.join(home, 'scratch'))).length === 0)
    await client.ok('POST', `/factories/${id}/checks/try`, {
      name: 'B',
      run: 'grep -c set-up setup.log',
    })
    await finished('B')
    const output = await client.ok<CheckTryOutput>(
      'GET',
      `/factories/${id}/checks/try/output?name=B`,
    )
    expect(output.text.trim()).toBe('1')
  })

  test('a failing setup is reported as such, and its output is kept', async () => {
    const client = await start({
      workflow: workflowYaml.replace('echo set-up >> "$HOME_LOG"', 'echo no-npm && exit 3'),
    })
    const id = client.factory.id
    await client.ok('POST', `/factories/${id}/checks/try`, { name: 'A', run: 'true' })
    let done: CheckTry | undefined
    await until(async () => {
      done = (await client.settings()).tries.find((t) => t.name === 'A' && t.state !== 'running')
      return done !== undefined
    })
    expect(done).toMatchObject({ state: 'failed', exitCode: 3, setupFailed: true })
    const output = await client.ok<CheckTryOutput>(
      'GET',
      `/factories/${id}/checks/try/output?name=A`,
    )
    expect(output.text).toContain('no-npm')
  })

  test('Run now is refused while a full disk holds new work', async () => {
    const client = await start({ freeBytes: 1e9 })
    await until(async () => (await client.ok<Banner[]>('GET', '/banners')).length > 0)
    const res = await client.call('POST', `/factories/${client.factory.id}/checks/try`, {
      name: 'A',
      run: 'true',
    })
    expect(res.status).toBe(409)
    expect(JSON.stringify(res.body)).toContain('isn’t starting new work')
  })

  test('cleaning up scratch worktrees never follows a link out of the scratch folder', async () => {
    const outside = path.join(scratch, 'outside')
    await mkdir(path.join(outside, 'worktrees', 'app'), { recursive: true })
    await writeFile(path.join(outside, 'worktrees', 'app', 'keep.txt'), 'keep')
    await writeFile(
      path.join(outside, 'state.json'),
      JSON.stringify({
        worktrees: [{ repo: 'acme/widgets', name: 'app', createdAt: '2020', usedAt: '2020' }],
        tries: [],
      }),
    )
    await mkdir(path.join(home, 'scratch'), { recursive: true })
    await symlink(outside, path.join(home, 'scratch', 'linked'))
    const client = await start({ scratchMaxAgeMs: 100 })
    await client.ok('POST', `/factories/${client.factory.id}/checks/try`, {
      name: 'A',
      run: 'true',
    })
    await until(
      async () => !(await readdir(path.join(home, 'scratch'))).includes(client.factory.id),
    )
    expect(await readFile(path.join(outside, 'worktrees', 'app', 'keep.txt'), 'utf8')).toBe('keep')
  })

  test('only the TED app can run a Check', async () => {
    const client = await start()
    const fileToken = api(daemon?.port ?? 0, await tokenFor(home))
    const res = await fileToken.call('POST', `/factories/${client.factory.id}/checks/try`, {
      name: 'X',
      run: 'true',
    })
    expect(res.status).toBe(403)
  })
})

describe('Factory settings: an invalid file', () => {
  test('shows the error, the last valid version, a banner, and saving replaces it', async () => {
    const client = await start()
    const valid = await client.settings()
    expect(valid.invalid).toBeUndefined()
    const { stdout } = await run('git', ['rev-parse', '--short=7', 'main'], { cwd: origin })
    await commitToOrigin(scratch, {
      '.ted/workflow.yaml': `${workflowYaml}  review:\n    max_back: lots\n`,
    })
    const view = await client.settings('first')
    expect(view.source).toBe('last-valid')
    expect(view.invalid).toMatchObject({
      file: '.ted/workflow.yaml',
      line: 13,
      message: '`stages.review.max_back` must be a whole number, 0 or more',
      url: 'https://github.com/acme/widgets/blob/main/.ted/workflow.yaml#L13',
      lastValid: { version: stdout.trim() },
    })
    expect(Date.parse(view.invalid?.lastValid?.at ?? '')).toBeGreaterThan(Date.now() - 600_000)
    const banners = await client.ok<Banner[]>('GET', '/banners')
    expect(
      banners.find((b) => b.factoryId === client.factory.id && b.problem === 'workflow-invalid'),
    ).toMatchObject({
      severity: 'warning',
      text: `.ted/workflow.yaml has an error on line 13 · using the last valid version (${stdout.trim()})`,
      action: { opens: { kind: 'factory-settings', factoryId: client.factory.id } },
    })

    await client.save({ ...unchanged(view), notes: 'Notes.\n' }, view.version)
    expect(await originFile('.ted/workflow.yaml')).toBe(workflowYaml)
    const fixed = await client.settings()
    expect(fixed.invalid).toBeUndefined()
    await until(async () =>
      (await client.ok<Banner[]>('GET', '/banners')).every((b) => b.problem !== 'workflow-invalid'),
    )
  })
})

test('Stage effort overrides Library effort and Inherit removes only the Factory value', async () => {
  const client = await start()
  await mkdir(path.join(home, 'library'), { recursive: true })
  await writeFile(
    path.join(home, 'library', 'workflow.yaml'),
    'version: 1\nstages:\n  work: { effort: medium }\n',
  )
  const before = await client.settings()
  expect(before.stages.find((s) => s.id === 'work')).toMatchObject({
    effort: null,
    inheritedEffort: 'medium',
    inheritedEffortFrom: 'library',
  })
  const changes = { ...unchanged(before), stages: { work: { effort: 'high' as const } } }
  await client.save(changes, before.version)
  expect(await originFile('.ted/workflow.yaml')).toContain('effort: high')
  const after = await client.settings()
  expect(after.stages.find((s) => s.id === 'work')).toMatchObject({
    effort: 'high',
    inheritedEffort: 'medium',
  })
  const preview = await client.preview({ ...unchanged(after), stages: { work: { effort: null } } })
  expect(preview.valid).toBe(true)
  expect(preview.files.find((f) => f.path === '.ted/workflow.yaml')?.lines).toContainEqual({
    kind: 'removed',
    text: '    effort: high',
  })
})
