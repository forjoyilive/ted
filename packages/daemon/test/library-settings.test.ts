import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type DaemonEvent,
  type Factory,
  type FactorySettingsView,
  type LibraryChanges,
  type LibraryPreview,
  type LibraryView,
  readDaemonInfo,
  type Task,
} from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { parse } from 'yaml'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import type { LibraryWatchOptions } from '../src/library-watch.ts'
import { defaultsDir } from '../src/workflow/layers.ts'
import {
  api,
  appClient,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  stubCodexPath,
  tokenFor,
  waitUntil,
} from './helpers.ts'

let home: string
let cleanup: () => Promise<void>
let scratch: string
let origin: string
let daemon: RunningDaemon | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await realpath(await mkdtemp(path.join(tmpdir(), 'ted-library-')))
  origin = await makeOriginRepo(scratch)
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

const libraryDir = () => path.join(home, 'library')
const libraryFile = (file: string) =>
  readFile(path.join(libraryDir(), file), 'utf8').catch(() => undefined)

function blobHash(text: string): string {
  return createHash('sha1')
    .update(`blob ${Buffer.byteLength(text)}\0`)
    .update(text)
    .digest('hex')
    .slice(0, 7)
}

async function start(
  options: { healthCheck?: boolean; codex?: boolean; libraryWatch?: LibraryWatchOptions } = {},
) {
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    codexBin: options.codex ? stubCodexPath : path.join(scratch, 'no-codex-here'),
    ...(options.healthCheck && { checkAgentsOnStart: true }),
    ...(options.libraryWatch && { libraryWatch: options.libraryWatch }),
  })
  const client = api(daemon.port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  const view = () => ok<LibraryView>('GET', '/library')
  const preview = (changes: LibraryChanges) =>
    ok<LibraryPreview>('POST', '/library/preview', changes)
  const save = (changes: LibraryChanges, version: string) =>
    ok<LibraryView>('POST', '/library/save', { changes, version })
  return { ...client, ok, view, preview, save }
}

describe('Library settings', () => {
  test('with no Library every Stage and agent comes from Ted’s defaults', async () => {
    const client = await start()
    const view = await client.view()
    expect(view.path).toBe(libraryDir())
    expect(view.invalid).toBeUndefined()
    expect(view.stages.map((s) => s.id)).toEqual([
      'backlog',
      'intake',
      'clarify',
      'design',
      'work',
      'validate',
      'review',
      'merge',
      'cleanup',
      'done',
    ])
    expect(view.stages.find((s) => s.id === 'cleanup')).toMatchObject({ enabled: false })
    const design = view.stages.find((s) => s.id === 'design')
    expect(design).toMatchObject({ from: 'ted', gate: true, enabled: true })
    expect(design?.libraryFile).toBeUndefined()
    expect(design?.defaultText).toBe(
      await readFile(path.join(defaultsDir, 'stages/design.md'), 'utf8'),
    )
    expect(view.agents.map((a) => [a.role, a.from, a.own])).toEqual([
      ['lead', 'ted', undefined],
      ['reviewer', 'ted', undefined],
      ['planner', 'ted', undefined],
    ])
    expect(view.agents[0]?.default).toEqual({ agent: 'claude' })
    expect(view.agentFiles.map((a) => [a.id, a.from, a.builtIn, a.own])).toEqual([
      ['coordinator', 'ted', true, undefined],
      ['planner', 'ted', true, undefined],
    ])
    expect(view.agentFiles[0]).toMatchObject({
      name: 'Coordinator',
      powers: ['ask', 'manage_tasks', 'manage_automations', 'manage_agents'],
      inherited: { layer: 'ted', settings: { name: 'Coordinator' } },
    })
  })

  test('Edit in Library copies the default with based_on, and Save writes straight to the Library', async () => {
    const client = await start()
    const before = await client.view()
    const review = before.stages.find((s) => s.id === 'review')?.defaultText ?? ''
    const edited = `${review}\n## Also\n\nCheck the changelog.\n`
    const changes: LibraryChanges = {
      stages: { design: { gate: false } },
      stageFiles: { review: edited },
    }

    const preview = await client.preview(changes)
    expect(preview.valid).toBe(true)
    expect(preview.files.map((f) => f.path)).toEqual(['workflow.yaml', 'stages/review.md'])

    const after = await client.save(changes, before.version)
    expect(await libraryFile('stages/review.md')).toBe(edited)
    expect(parse((await libraryFile('workflow.yaml')) ?? '')).toEqual({
      version: 1,
      stages: { design: { gate: false }, review: { based_on: blobHash(review) } },
    })
    expect(after.stages.find((s) => s.id === 'review')).toMatchObject({
      from: 'library',
      libraryFile: edited,
      basedOn: blobHash(review),
    })
    expect(after.stages.find((s) => s.id === 'design')).toMatchObject({ gate: false })

    const coordinator = after.agentFiles.find((a) => a.id === 'coordinator')
    const instructions = coordinator?.inherited?.instructions ?? ''
    const agentChanges: LibraryChanges = {
      agentFiles: [
        {
          id: 'coordinator',
          settings: { name: 'Coordinator', powers: ['ask', 'manage_tasks'], model: 'opus' },
          instructions: `${instructions}\nKeep answers short.\n`,
        },
        {
          id: 'release-notes',
          settings: { name: 'Release notes', agent: 'claude', powers: ['ask', 'read_code'] },
          instructions: '# Release notes\n\nWrite the notes.\n',
        },
      ],
    }
    expect((await client.preview(agentChanges)).files.map((f) => f.path)).toEqual([
      'agents.yaml',
      'agents/coordinator.md',
      'agents/release-notes.md',
    ])
    const withAgents = await client.save(agentChanges, after.version)
    expect(parse((await libraryFile('agents.yaml')) ?? '')).toEqual({
      coordinator: {
        name: 'Coordinator',
        model: 'opus',
        powers: ['ask', 'manage_tasks'],
        based_on: blobHash(instructions),
      },
      'release-notes': { name: 'Release notes', agent: 'claude', powers: ['ask', 'read_code'] },
    })
    expect(await libraryFile('agents/release-notes.md')).toBe(
      '# Release notes\n\nWrite the notes.\n',
    )
    expect(withAgents.agentFiles.map((a) => [a.id, a.from])).toEqual([
      ['coordinator', 'library'],
      ['planner', 'ted'],
      ['release-notes', 'library'],
    ])
    expect(withAgents.agentFiles[0]?.own).toMatchObject({ basedOn: blobHash(instructions) })

    const factory = await client.ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
    await waitUntil(
      async () => (await client.call('GET', `/factories/${factory.id}/settings`)).status === 200,
      'the clone',
    )
    const settings = await client.ok<FactorySettingsView>(
      'GET',
      `/factories/${factory.id}/settings`,
    )
    expect(settings.stages.find((s) => s.id === 'review')).toMatchObject({
      from: 'library',
      inherited: { layer: 'library', text: edited },
    })
    expect(settings.stages.find((s) => s.id === 'design')).toMatchObject({ gate: false })
    expect(settings.agentFiles.find((a) => a.id === 'release-notes')).toMatchObject({
      from: 'library',
      powers: ['ask', 'read_code'],
      inherited: { layer: 'library' },
    })
    expect(settings.agentFiles.find((a) => a.id === 'release-notes')?.own).toBeUndefined()

    const removed = await client.save(
      { agentFiles: [{ id: 'release-notes', settings: null, instructions: null }] },
      withAgents.version,
    )
    expect(await libraryFile('agents/release-notes.md')).toBeUndefined()
    expect(removed.agentFiles.map((a) => a.id)).toEqual(['coordinator', 'planner'])

    const designGate = async () =>
      (
        await client.ok<FactorySettingsView>('GET', `/factories/${factory.id}/settings`)
      ).stages.find((s) => s.id === 'design')?.gate
    await client.save({ stages: { design: { gate: true } } }, removed.version)
    expect(await designGate()).toBe(true)
    const written = await libraryFile('workflow.yaml')
    expect(written).toContain('gate: true')
    await writeFile(
      path.join(libraryDir(), 'workflow.yaml'),
      (written ?? '').replace('gate: true', 'gate: false'),
    )
    expect(await designGate()).toBe(false)
  })

  test('Reset to default deletes the Library copy and its based_on', async () => {
    const client = await start()
    const first = await client.view()
    const work = first.stages.find((s) => s.id === 'work')?.defaultText ?? ''
    const saved = await client.save({ stageFiles: { work: `${work}\nMore.\n` } }, first.version)
    expect(await libraryFile('stages/work.md')).toBeDefined()

    const reset = await client.save({ stageFiles: { work: null } }, saved.version)
    expect(await libraryFile('stages/work.md')).toBeUndefined()
    expect(await libraryFile('workflow.yaml')).toBe('version: 1\n')
    expect(reset.stages.find((s) => s.id === 'work')).toMatchObject({ from: 'ted' })
    expect(reset.stages.find((s) => s.id === 'work')?.basedOn).toBeUndefined()

    const custom = [
      'version: 1',
      'order: [intake, work, design-qa, validate, review, merge]',
      'stages:',
      '  design-qa:',
      '    name: Design QA # by hand',
      '',
    ].join('\n')
    await mkdir(path.join(libraryDir(), 'stages'), { recursive: true })
    await writeFile(path.join(libraryDir(), 'stages', 'design-qa.md'), '# QA\n')
    await writeFile(path.join(libraryDir(), 'workflow.yaml'), custom)
    const withCustom = await client.view()
    expect(withCustom.stages.map((s) => s.id)).toEqual([
      'backlog',
      'intake',
      'clarify',
      'design',
      'work',
      'design-qa',
      'validate',
      'review',
      'merge',
      'cleanup',
      'done',
    ])
    const qa = withCustom.stages.find((s) => s.id === 'design-qa')
    expect(qa).toMatchObject({ name: 'Design QA', custom: true, libraryFile: '# QA\n' })
    expect(qa?.defaultText).toBeUndefined()

    const saved2 = await client.save(
      {
        stages: { 'design-qa': { gate: true, maxBack: 2 }, cleanup: { enabled: true } },
        stageFiles: { 'design-qa': '# QA\n\nCompare with Figma.\n' },
      },
      withCustom.version,
    )
    const yaml = (await libraryFile('workflow.yaml')) ?? ''
    expect(yaml).toContain('order: [intake, work, design-qa, validate, review, merge]')
    expect(yaml).toContain('    name: Design QA # by hand')
    expect(parse(yaml).stages).toEqual({
      'design-qa': { name: 'Design QA', gate: true, max_back: 2 },
      cleanup: { enabled: true },
    })
    expect(await libraryFile('stages/design-qa.md')).toBe('# QA\n\nCompare with Figma.\n')
    expect(saved2.stages.find((s) => s.id === 'cleanup')).toMatchObject({ enabled: true })
  })

  test('a save that would leave an invalid Library writes nothing', async () => {
    const client = await start()
    const view = await client.view()
    const preview = await client.preview({ stageFiles: { design: '  \n' } })
    expect(preview.valid).toBe(false)
    expect(preview.problems[0]).toMatchObject({ file: 'stages/design.md', severity: 'error' })

    const res = await client.call('POST', '/library/save', {
      changes: { stageFiles: { design: '  \n' } },
      version: view.version,
    })
    expect(res.status).toBe(400)
    const nameless = await client.call('POST', '/library/save', {
      changes: {
        agentFiles: [{ id: 'helper', settings: { powers: ['ask'] }, instructions: 'Hi' }],
      },
      version: view.version,
    })
    expect(nameless.status).toBe(400)
    expect(JSON.stringify(nameless.body)).toContain('needs a `name`')
    expect(await readdir(libraryDir()).catch(() => [])).toEqual([])

    const outside = path.join(scratch, 'outside')
    await mkdir(outside)
    await writeFile(path.join(outside, 'helper.md'), 'not Ted’s')
    await mkdir(libraryDir(), { recursive: true })
    await symlink(outside, path.join(libraryDir(), 'agents'))
    const linked = await client.view()
    for (const changes of [
      { agentFiles: [{ id: 'notes', settings: { name: 'Notes' }, instructions: '# Notes' }] },
      { agentFiles: [{ id: 'helper', settings: null, instructions: null }] },
    ]) {
      const refused = await client.call('POST', '/library/save', {
        changes,
        version: linked.version,
      })
      expect(refused.status).toBe(400)
    }
    expect(await readdir(outside)).toEqual(['helper.md'])
    expect(await readFile(path.join(outside, 'helper.md'), 'utf8')).toBe('not Ted’s')
  })

  test('a save after the Library changed on disk is refused', async () => {
    const client = await start()
    const view = await client.view()
    await mkdir(libraryDir(), { recursive: true })
    await writeFile(path.join(libraryDir(), 'workflow.yaml'), 'version: 1\nlead: codex\n')
    const res = await client.call('POST', '/library/save', {
      changes: { stages: { design: { gate: false } } },
      version: view.version,
    })
    expect(res.status).toBe(409)
    expect(await libraryFile('workflow.yaml')).toBe('version: 1\nlead: codex\n')
  })

  test('an edit made outside Ted is picked up after validation, and an invalid one shows the notice', async () => {
    const client = await start()
    await client.view()
    const info = await readDaemonInfo(home)
    if (!info) throw new Error('no daemon.json')
    const events: DaemonEvent[] = []
    const subscription = await appClient(info, daemon?.appToken).subscribe((e) => events.push(e))
    try {
      await mkdir(path.join(libraryDir(), 'stages'), { recursive: true })
      await writeFile(
        path.join(libraryDir(), 'workflow.yaml'),
        'version: 1\nstages:\n  merge:\n    enabled: false\n',
      )
      await waitUntil(
        async () => events.some((e) => e.type === 'library-changed') || undefined,
        'library-changed',
      )
      const valid = await client.view()
      expect(valid.stages.find((s) => s.id === 'merge')).toMatchObject({ enabled: false })
      expect(valid.invalid).toBeUndefined()

      events.length = 0
      await writeFile(path.join(libraryDir(), 'workflow.yaml'), 'version: 1\nstages:\n  merge: [\n')
      await waitUntil(
        async () => events.some((e) => e.type === 'library-changed') || undefined,
        'library-changed',
      )
      const broken = await client.view()
      expect(events.filter((e) => e.type === 'library-changed')).toEqual([
        { type: 'library-changed', version: broken.version },
      ])
      expect(broken.invalid).toMatchObject({ file: 'workflow.yaml', line: expect.any(Number) })
      expect(broken.invalid?.lastValid?.version).toMatch(/^[0-9a-f]{7}$/)
      expect(broken.stages.find((s) => s.id === 'merge')).toMatchObject({ enabled: false })

      events.length = 0
      const fixed = await client.save({ stages: { merge: { enabled: true } } }, broken.version)
      expect(fixed.invalid).toBeUndefined()
      expect(await libraryFile('workflow.yaml')).toBe(
        'version: 1\nstages:\n  merge:\n    enabled: true\n',
      )
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(events.filter((e) => e.type === 'library-changed')).toEqual([
        { type: 'library-changed', version: fixed.version },
      ])
    } finally {
      subscription.close()
    }
  })

  test('an outside edit the watcher never reports is still picked up', async () => {
    const client = await start({
      libraryWatch: {
        watchDirectory: () => ({ on: () => undefined, close: () => undefined }),
        recheckMs: 20,
      },
    })
    await client.view()
    const info = await readDaemonInfo(home)
    if (!info) throw new Error('no daemon.json')
    const events: DaemonEvent[] = []
    const subscription = await appClient(info, daemon?.appToken).subscribe((e) => events.push(e))
    try {
      await mkdir(libraryDir(), { recursive: true })
      await writeFile(
        path.join(libraryDir(), 'workflow.yaml'),
        'version: 1\nstages:\n  merge:\n    enabled: false\n',
      )
      await waitUntil(
        async () => events.some((e) => e.type === 'library-changed') || undefined,
        'library-changed',
      )
      const view = await client.view()
      expect(view.stages.find((s) => s.id === 'merge')).toMatchObject({ enabled: false })
      expect(events.filter((e) => e.type === 'library-changed')).toEqual([
        { type: 'library-changed', version: view.version },
      ])
    } finally {
      subscription.close()
    }
  })

  test('external edits refresh an inherited Workflow after the Library watcher fails', async () => {
    const watcher = new EventEmitter()
    let watcherClosed = false
    const client = await start({
      libraryWatch: {
        watchDirectory: () => ({
          on: (event, listener) => watcher.on(event, listener),
          close: () => {
            watcherClosed = true
          },
        }),
        pollMs: 20,
      },
    })
    const factory = await client.ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'LW' })
    const route = `/factories/${factory.id}/settings`
    await waitUntil(async () => (await client.call('GET', route)).status === 200, 'the clone')
    const design = async () =>
      (await client.ok<FactorySettingsView>('GET', route)).stages.find((s) => s.id === 'design')
    expect(await design()).toMatchObject({ from: 'ted' })
    const info = await readDaemonInfo(home)
    if (!info) throw new Error('no daemon.json')
    const events: DaemonEvent[] = []
    const subscription = await appClient(info, daemon?.appToken).subscribe((e) => events.push(e))
    try {
      watcher.emit(
        'error',
        Object.assign(new Error('too many open files, watch'), { code: 'EMFILE' }),
      )
      expect(watcherClosed).toBe(true)
      await mkdir(path.join(libraryDir(), 'stages'), { recursive: true })
      const stage = path.join(libraryDir(), 'stages', 'design.md')
      for (const text of ['# First external edit\n', '# Second external edit\n']) {
        events.length = 0
        const pending = path.join(home, 'pending-design.md')
        await writeFile(pending, text)
        await rename(pending, stage)
        await waitUntil(
          async () => events.some((e) => e.type === 'library-changed') || undefined,
          'library-changed',
        )
        expect(await design()).toMatchObject({ from: 'library', inherited: { text } })
      }
    } finally {
      subscription.close()
    }
  })

  test('agent defaults write to the Library’s workflow.yaml and show the Library tag', async () => {
    const client = await start()
    const view = await client.view()
    const saved = await client.save(
      { agents: { reviewer: { agent: 'codex', model: 'gpt-5.5-codex', effort: 'high' } } },
      view.version,
    )
    expect(await libraryFile('workflow.yaml')).toBe(
      'version: 1\nreviewer: {agent: codex, model: gpt-5.5-codex, effort: high}\n',
    )
    expect(saved.agents.find((a) => a.role === 'reviewer')).toMatchObject({
      from: 'library',
      own: { agent: 'codex', model: 'gpt-5.5-codex', effort: 'high' },
    })

    const task = await client.ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
    await waitUntil(
      async () => (await client.call('GET', `/factories/${task.id}/settings`)).status === 200,
      'the clone',
    )
    const factory = await client.ok<FactorySettingsView>('GET', `/factories/${task.id}/settings`)
    expect(factory.agents.find((a) => a.role === 'reviewer')).toMatchObject({
      inheritedFrom: 'library',
      inherited: { agent: 'codex', model: 'gpt-5.5-codex', effort: 'high' },
    })

    const reset = await client.save({ agents: { reviewer: null } }, saved.version)
    expect(await libraryFile('workflow.yaml')).toBe('version: 1\n')
    expect(reset.agents.find((a) => a.role === 'reviewer')).toMatchObject({ from: 'ted' })
  })

  test('the Reviewer’s default follows the Library’s Task Lead', async () => {
    const client = await start({ codex: true })
    expect((await client.view()).agents.find((a) => a.role === 'reviewer')?.default).toEqual({
      agent: 'codex',
    })
    const view = await client.view()
    const saved = await client.save({ agents: { lead: { agent: 'codex' } } }, view.version)
    expect(saved.agents.find((a) => a.role === 'reviewer')).toMatchObject({
      from: 'ted',
      default: { agent: 'claude' },
    })
  })

  test('only the Ted app can change the Library', async () => {
    const client = await start()
    const view = await client.view()
    const cli = api(daemon?.port ?? 0, await tokenFor(home))
    const refused = { status: 403, body: { error: 'only the Ted app can do this' } }
    expect(
      await cli.call('POST', '/library/save', { changes: { stages: {} }, version: view.version }),
    ).toEqual(refused)
    expect(await cli.call('POST', '/library/preview', {})).toEqual(refused)
  })
})

describe('restart idle Runs onto new agent versions', () => {
  const setStub = (state: Record<string, unknown>) =>
    writeFile(path.join(home, 'stub-claude.json'), JSON.stringify(state))
  const starts = async () =>
    (
      await readFile(
        path.join(home, 'worktrees', 'NB-1', 'widgets', 'stub-starts.jsonl'),
        'utf8',
      ).catch(() => '')
    )
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as { argv: string[] })

  async function idleTask() {
    const client = await start({ healthCheck: true })
    await client.ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
    const task = await client.ok<Task>('POST', '/tasks', {
      title: JSON.stringify({ steps: [{ endTurn: true }] }),
      factory: 'NB',
      start: true,
    })
    const run = await waitUntil(async () => {
      const current = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === task.id)
      if (!current?.leadRunId) return undefined
      const found = (await client.getRun(current.leadRunId)).run
      return found.state === 'idle' ? found : undefined
    }, 'an idle Task Lead Run')
    return { client, run }
  }

  test('an idle Run resumes its session after a CLI update', async () => {
    await setStub({ version: '2.1.319' })
    const { client, run } = await idleTask()
    expect(await starts()).toHaveLength(1)

    await setStub({ version: '2.1.320' })
    await client.ok('POST', '/agents/health/check')
    const all = await waitUntil(async () => {
      const found = await starts()
      return found.length === 2 ? found : undefined
    }, 'the Run to restart')
    const argv = all[1]?.argv ?? []
    expect(argv[argv.indexOf('--resume') + 1]).toBe(run.sessionId)
    expect((await client.getRun(run.id)).run.state).not.toBe('finished')
  })

  test('with the setting off, a CLI update leaves idle Runs alone', async () => {
    await setStub({ version: '2.1.319' })
    const { client } = await idleTask()
    await client.ok('PATCH', '/settings', { restartIdleRuns: false })

    await setStub({ version: '2.1.320' })
    await client.ok('POST', '/agents/health/check')
    await new Promise((resolve) => setTimeout(resolve, 1000))
    expect(await starts()).toHaveLength(1)
  })
})

test('the Validate round settings save to the Library and turn off again', async () => {
  const client = await start()
  const before = await client.view()
  const validate = (view: typeof before) => view.stages.find((s) => s.id === 'validate')
  expect(validate(before)).toMatchObject({ p1OnlyFrom: 2, subAgents: false })
  const on = await client.save(
    {
      stages: {
        validate: { p1OnlyFrom: 3, subAgents: true },
        work: { leadClosesFailures: false },
      },
    },
    before.version,
  )
  expect(validate(on)).toMatchObject({ p1OnlyFrom: 3, subAgents: true, maxBack: 8 })
  expect(before.stages.find((s) => s.id === 'work')).toMatchObject({ leadClosesFailures: true })
  expect(on.stages.find((s) => s.id === 'work')).toMatchObject({ leadClosesFailures: false })
  const yaml = await libraryFile('workflow.yaml')
  expect(yaml).toContain('p1_only_from: 3')
  expect(yaml).toContain('sub_agents: true')
  const off = await client.save(
    { stages: { validate: { p1OnlyFrom: false, subAgents: false } } },
    on.version,
  )
  expect(validate(off)).toMatchObject({ p1OnlyFrom: false, subAgents: false })
  expect(await libraryFile('workflow.yaml')).toContain('p1_only_from: false')
})

test('Stage effort saves and removing it restores inheritance without losing other Stage settings', async () => {
  const client = await start()
  const before = await client.view()
  const after = await client.save(
    { stages: { work: { effort: 'high', maxBack: 2 } } },
    before.version,
  )
  expect(after.stages.find((s) => s.id === 'work')).toMatchObject({ effort: 'high', maxBack: 2 })
  const reset = await client.save({ stages: { work: { effort: null } } }, after.version)
  expect(reset.stages.find((s) => s.id === 'work')).toMatchObject({ effort: null, maxBack: 2 })
  expect(await libraryFile('workflow.yaml')).not.toContain('effort:')
  for (const stages of [{ work: { effort: 'huge' } }, { done: { effort: 'high' } }]) {
    expect((await client.call('POST', '/library/preview', { stages })).status).toBe(400)
  }
})
