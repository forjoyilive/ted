import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type {
  DriftCounts,
  Factory,
  FactorySettingsChanges,
  FactorySettingsView,
  InboxItem,
  LibraryChanges,
  LibraryView,
  SaveSettingsResult,
  Task,
} from '@ted/protocol'
import { settingsInput } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { defaultsDir } from '../src/workflow/layers.ts'
import {
  api,
  basedOnLine,
  commitToOrigin,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  tokenFor,
  waitUntil,
} from './helpers.ts'

const run = promisify(execFile)

let home: string
let cleanup: () => Promise<void>
let scratch: string
let origin: string
let ghState: string
let daemon: RunningDaemon | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await realpath(await mkdtemp(path.join(tmpdir(), 'ted-drift-')))
  origin = await makeOriginRepo(scratch)
  ghState = path.join(scratch, 'gh.json')
  process.env.TED_STUB_GH = ghState
  process.env.TED_STUB_GH_LOG = path.join(scratch, 'gh.jsonl')
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  delete process.env.TED_STUB_GH
  delete process.env.TED_STUB_GH_LOG
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

function blobHash(text: string): string {
  return createHash('sha1')
    .update(`blob ${Buffer.byteLength(text)}\0`)
    .update(text)
    .digest('hex')
    .slice(0, 7)
}

const libraryDir = () => path.join(home, 'library')
const libraryFile = (file: string) =>
  readFile(path.join(libraryDir(), file), 'utf8').catch(() => undefined)

async function writeLibrary(files: Record<string, string>): Promise<void> {
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(libraryDir(), name)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, text)
  }
}

async function originFile(file: string): Promise<string | undefined> {
  return run('git', ['show', `main:${file}`], { cwd: origin }).then(
    ({ stdout }) => stdout,
    () => undefined,
  )
}

const libraryV1 = '# Review\n\n- Check the diff against the Design brief.\n- Write How to try it.\n'
const libraryV2 =
  '# Review\n\n- Check the diff against the Design brief and the Decisions.\n- Attach the Validate evidence.\n- Write How to try it.\n'

async function start(options: { workflow?: string; files?: Record<string, string> } = {}) {
  await writeFile(ghState, JSON.stringify({ merge: { origin, updateBase: true } }))
  if (options.workflow !== undefined || options.files !== undefined) {
    await commitToOrigin(scratch, {
      ...(options.workflow !== undefined && { '.ted/workflow.yaml': options.workflow }),
      ...options.files,
    })
  }
  daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
  const client = api(daemon.port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  const factory = await ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const settings = () => ok<FactorySettingsView>('GET', `/factories/${factory.id}/settings`)
  const save = async (changes: FactorySettingsChanges, version: string) => {
    await writeFile(ghState, JSON.stringify({ merge: { origin, updateBase: true } }))
    return ok<SaveSettingsResult>('POST', `/factories/${factory.id}/settings/save`, {
      changes,
      mode: 'merge',
      version,
    })
  }
  const library = () => ok<LibraryView>('GET', '/library')
  const saveLibrary = (changes: LibraryChanges, version: string) =>
    ok<LibraryView>('POST', '/library/save', { changes, version })
  const drift = () => ok<DriftCounts>('GET', '/drift')
  return { ...client, ok, factory, settings, save, library, saveLibrary, drift }
}

function unchanged(view: FactorySettingsView): FactorySettingsChanges {
  return { repos: view.repos.map((r) => structuredClone(settingsInput(r))) }
}

const reviewRow = (view: FactorySettingsView | LibraryView) =>
  view.stages.find((s) => s.id === 'review')

async function driftedFactory(
  override = `${libraryV1}- Also check the docs.\n`,
  repos: string[] = [],
) {
  await writeLibrary({ 'stages/review.md': libraryV1 })
  const client = await start({
    workflow: [
      'version: 1',
      ...repos,
      'order: [intake, work, review]',
      'stages:',
      `  review: { gate: false, based_on: ${blobHash(libraryV1)} }`,
      '',
    ].join('\n'),
    files: { '.ted/stages/review.md': override },
  })
  expect(reviewRow(await client.settings())?.drift).toBeUndefined()
  await writeLibrary({ 'stages/review.md': libraryV2 })
  const view = await waitUntil(async () => {
    const seen = await client.settings()
    return reviewRow(seen)?.drift ? seen : undefined
  }, 'the Review row to show drift')
  return { client, view }
}

describe('Drift in Factory settings', () => {
  test('changing an inherited Stage file flags the override based on the old hash', async () => {
    const { client, view } = await driftedFactory()
    const drift = reviewRow(view)?.drift
    expect(drift).toMatchObject({
      basedOn: blobHash(libraryV1),
      current: blobHash(libraryV2),
      layer: 'library',
      diffOf: 'inherited',
    })
    expect(drift?.diff).toContainEqual({
      kind: 'removed',
      text: '- Check the diff against the Design brief.',
    })
    expect(drift?.diff).toContainEqual({
      kind: 'added',
      text: '- Attach the Validate evidence.',
    })
    expect(view.stages.filter((s) => s.drift !== undefined).map((s) => s.id)).toEqual(['review'])
    expect(await client.drift()).toEqual({ factories: { [client.factory.id]: 1 }, library: 0 })
  })

  test('an override with no based_on, or one matching the inherited file, isn’t flagged', async () => {
    await writeLibrary({ 'stages/review.md': libraryV1 })
    const client = await start({
      workflow: `version: 1\nstages:\n  review: { based_on: ${blobHash(libraryV1)} }\n`,
      files: { '.ted/stages/review.md': 'Mine\n', '.ted/stages/design.md': 'Mine too\n' },
    })
    const view = await client.settings()
    expect(view.stages.some((s) => s.drift !== undefined)).toBe(false)
    expect(await client.drift()).toEqual({ factories: { [client.factory.id]: 0 }, library: 0 })
  })

  test('Keep mine updates based_on to the inherited file’s hash', async () => {
    const { client, view } = await driftedFactory()
    await client.save({ ...unchanged(view), keepStageFiles: ['review'] }, view.version)
    expect(await originFile('.ted/workflow.yaml')).toContain(`based_on: ${blobHash(libraryV2)}`)
    expect(await originFile('.ted/stages/review.md')).toBe(`${libraryV1}- Also check the docs.\n`)
    expect(reviewRow(await client.settings())?.drift).toBeUndefined()
    expect(await client.drift()).toEqual({ factories: { [client.factory.id]: 0 }, library: 0 })
  })

  test('Use inherited deletes the override and its based_on', async () => {
    const { client, view } = await driftedFactory()
    await client.save({ ...unchanged(view), stageFiles: { review: null } }, view.version)
    expect(await originFile('.ted/stages/review.md')).toBeUndefined()
    expect(await originFile('.ted/workflow.yaml')).not.toContain('based_on')
    const after = reviewRow(await client.settings())
    expect(after?.from).toBe('library')
    expect(after?.drift).toBeUndefined()
  })

  test('Merge with an agent creates a Task on the default branch with Intake filled in and the Review Gate forced on', async () => {
    const briefFile = path.join(scratch, 'brief.md')
    await writeFile(
      briefFile,
      [
        '## Goal',
        'Fold the inherited changes into review.md.',
        '## Decisions so far',
        '- Keep the Factory’s docs step.',
        '## Current state',
        'Merged.',
        '## Open questions',
        'None.',
        '## Next step',
        'Sign off.',
        '',
      ].join('\n\n'),
    )
    const steps = JSON.stringify({
      steps: [
        {
          everyMessage: [
            { run: ['ted', 'brief', 'write', '--file', briefFile] },
            { run: ['ted', 'outcome', 'advance'] },
            { endTurn: true },
          ],
        },
        { run: ['ted', 'brief', 'write', '--file', briefFile] },
        { run: ['ted', 'outcome', 'advance'] },
        { endTurn: true },
      ],
    })
    const override = `${libraryV1}${steps}\n`
    const { client } = await driftedFactory(override, [
      'repos:',
      '  - name: widgets',
      '    base_branch: develop',
    ])

    const task = await client.ok<Task>(
      'POST',
      `/factories/${client.factory.id}/stages/review/merge-inherited`,
    )
    expect(task).toMatchObject({
      title: 'Merge inherited changes into review.md',
      priority: 'none',
      clarifyDepth: 'none',
      chosenRepos: ['acme/widgets'],
    })
    expect(task.description).toContain(blobHash(libraryV2))
    expect(task.description).toContain('-- Check the diff against the Design brief.')
    expect(task.description).toContain('+- Attach the Validate evidence.')
    expect(task.description).toContain(override.trim())
    expect(task.description).toContain('skip')

    const review = await waitUntil(
      async () => {
        const [item] = await client.ok<InboxItem[]>('GET', '/inbox')
        return item?.task.id === task.id && item.task.stage === 'review' ? item : undefined
      },
      'the forced Review Gate',
      20_000,
    )
    expect(review.request).toMatchObject({ stage: 'review' })
    expect(review.request.gate).toBeDefined()
  })

  test('Merge with an agent is refused without drift, and only the TED app can ask for it', async () => {
    const client = await start()
    const refused = await client.call(
      'POST',
      `/factories/${client.factory.id}/stages/review/merge-inherited`,
    )
    expect(refused.status).toBe(409)
    const fileToken = api(daemon?.port ?? 0, await tokenFor(home))
    const res = await fileToken.call(
      'POST',
      `/factories/${client.factory.id}/stages/review/merge-inherited`,
    )
    expect(res.status).toBe(403)
  })
})

describe('Drift in the Library', () => {
  test('a Library copy based on an older default shows drift; Keep mine updates based_on', async () => {
    const review = await readFile(path.join(defaultsDir, 'stages', 'review.md'), 'utf8')
    await writeLibrary({
      'workflow.yaml': 'version: 1\nstages:\n  review:\n    based_on: abcdef0\n',
      'stages/review.md': 'My review steps\n',
    })
    const client = await start()
    const view = await client.library()
    const drift = reviewRow(view)?.drift
    expect(drift).toMatchObject({
      basedOn: 'abcdef0',
      current: blobHash(review),
      layer: 'ted',
      diffOf: 'yours',
      changedIn: '9.9.9',
    })
    expect(drift?.diff).toContainEqual({ kind: 'removed', text: 'My review steps' })
    expect((await client.drift()).library).toBe(1)

    await client.saveLibrary({ keepStageFiles: ['review'] }, view.version)
    expect(await libraryFile('workflow.yaml')).toContain(basedOnLine(blobHash(review)))
    expect(await libraryFile('stages/review.md')).toBe('My review steps\n')
    expect(reviewRow(await client.library())?.drift).toBeUndefined()
    await waitUntil(async () => (await client.drift()).library === 0, 'no Library drift')
  })

  test('Use default deletes the Library copy', async () => {
    await writeLibrary({
      'workflow.yaml': 'version: 1\nstages:\n  review:\n    based_on: abcdef0\n',
      'stages/review.md': 'My review steps\n',
    })
    const client = await start()
    const view = await client.library()
    await client.saveLibrary({ stageFiles: { review: null } }, view.version)
    expect(await libraryFile('stages/review.md')).toBeUndefined()
    expect(reviewRow(await client.library())?.drift).toBeUndefined()
  })
})
