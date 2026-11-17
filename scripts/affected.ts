import { execFileSync } from 'node:child_process'
import { globSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { isObject, isString, parseJson } from '../packages/protocol/src/parse.ts'
import { electronFiles, testFilePatterns } from './test-files.ts'

export { electronSandbox } from './test-files.ts'

export type Graph = ReadonlyMap<string, readonly string[]>

export type Packages = Readonly<
  Record<string, { dir: string; exports: Readonly<Record<string, string>> }>
>

export function references(source: string): string[] {
  return [...source.matchAll(/['"`]((?:\.\.?\/|@ted\/)[^'"`\s$]+)['"`]/g)].map(
    (match) => match[1] ?? '',
  )
}

export function resolveReference(
  from: string,
  reference: string,
  files: ReadonlySet<string>,
  packages: Packages,
): string | undefined {
  const clean = reference.replace(/[?#].*$/, '')
  let target: string
  if (clean.startsWith('@ted/')) {
    const [scope, name, ...rest] = clean.split('/')
    const found = packages[`${scope}/${name}`]
    const entry = found?.exports[rest.length > 0 ? `./${rest.join('/')}` : '.']
    if (!found || !entry) return undefined
    target = path.posix.join(found.dir, entry)
  } else {
    target = path.posix.join(path.posix.dirname(from), clean)
  }
  return files.has(target) ? target : undefined
}

export function importGraph(
  sources: ReadonlyMap<string, string>,
  files: ReadonlySet<string>,
  packages: Packages,
): Graph {
  const graph = new Map<string, string[]>()
  for (const [file, source] of sources) {
    const found = new Set<string>()
    for (const reference of references(source)) {
      const target = resolveReference(file, reference, files, packages)
      if (target && target !== file) found.add(target)
    }
    graph.set(file, [...found].sort())
  }
  return graph
}

function reach(graph: Graph, roots: readonly string[]): Set<string> {
  const seen = new Set<string>(roots)
  const queue = [...roots]
  for (const file of queue) {
    for (const next of graph.get(file) ?? []) {
      if (seen.has(next)) continue
      seen.add(next)
      queue.push(next)
    }
  }
  return seen
}

export const runnerRoots = ['vitest.config.ts', 'scripts/check.ts']

const installFiles =
  /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|packages\/[^/]+\/package\.json)$/

export function runsEverything(changed: readonly string[], graph: Graph): string | undefined {
  const runner = reach(graph, runnerRoots)
  for (const file of [...changed].sort()) {
    if (installFiles.test(file)) return `${file} changed, which decides what is installed`
    if (runnerRoots.includes(file)) return `${file} changed, which is part of the test runner`
    if (runner.has(file)) return `${file} changed, which the test runner loads`
  }
  return undefined
}

const appSource = 'packages/app/src/'
const appTestDir = 'packages/app/test/'

export const appSmokeTests = [
  'packages/app/test/app.test.ts',
  'packages/app/test/app-settings.test.ts',
  'packages/app/test/app-task.test.ts',
]

const appShell = new Set([
  'packages/app/src/main.ts',
  'packages/app/src/entry.ts',
  'packages/app/src/preload.cjs',
  'packages/app/src/renderer/index.html',
  'packages/app/src/renderer/main.tsx',
  'packages/app/src/renderer/Root.tsx',
  'packages/app/src/renderer/App.tsx',
  'packages/app/src/renderer/components/Sidebar.tsx',
])

const plainFolders = new Set(['renderer', 'components', 'views', 'styles'])

export function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '')
    .map((word) => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word))
}

export function testArea(test: string): string[] {
  const name = path.posix.basename(test).replace(/\.test\.tsx?$/, '')
  return words(name.replace(/^app-(?=.)/, '').replace(/-(ui|app)$/, ''))
}

export function sourceAreas(file: string): string[][] {
  if (!file.startsWith(appSource)) return []
  const parts = file.slice(appSource.length).split('/')
  const stem = (parts.pop() ?? '').replace(/\.module\.css$/, '').replace(/\.[^.]+$/, '')
  return [words(stem), ...parts.filter((part) => !plainFolders.has(part)).map(words)].filter(
    (area) => area.length > 0,
  )
}

function startsWith(long: readonly string[], short: readonly string[]): boolean {
  return short.length <= long.length && short.every((word, index) => word === long[index])
}

function sameArea(test: readonly string[], source: readonly string[]): boolean {
  return test.length > 0 && (startsWith(source, test) || startsWith(test, source))
}

export interface Pick {
  file: string
  kind: 'changed' | 'imports' | 'through' | 'app'
  why: string
}

const kindOrder: Pick['kind'][] = ['changed', 'app', 'imports', 'through']

export interface Selection {
  all?: string
  picks: Pick[]
}

export function affectedTests(input: {
  changed: readonly string[]
  graph: Graph
  tests: readonly string[]
  electron: ReadonlySet<string>
}): Selection {
  const tests = new Set(input.tests)
  const changed = [...new Set(input.changed)].sort()
  const picks = new Map<string, Pick>()
  const pick = (file: string, kind: Pick['kind'], why: string) => {
    if (!tests.has(file)) return
    const had = picks.get(file)?.kind
    if (had === undefined || kindOrder.indexOf(kind) < kindOrder.indexOf(had))
      picks.set(file, { file, kind, why })
  }

  for (const file of changed) pick(file, 'changed', 'changed')

  const importers = new Map<string, string[]>()
  for (const [file, targets] of input.graph) {
    for (const target of targets) {
      const list = importers.get(target) ?? []
      list.push(file)
      importers.set(target, list)
    }
  }
  for (const source of changed) {
    const seen = new Set([source])
    const queue = [source]
    for (const file of queue) {
      for (const importer of importers.get(file) ?? []) {
        if (seen.has(importer)) continue
        seen.add(importer)
        queue.push(importer)
        if (file === source) pick(importer, 'imports', `imports ${source}`)
        else pick(importer, 'through', `imports ${source} through ${file}`)
      }
    }
  }

  const appTests = input.tests
    .filter((test) => test.startsWith(appTestDir) && input.electron.has(test))
    .sort()
  for (const source of changed) {
    if (!source.startsWith(appSource)) continue
    const areas = sourceAreas(source)
    let matched = false
    for (const test of appTests) {
      const area = areas.find((candidate) => sameArea(testArea(test), candidate))
      if (!area) continue
      matched = true
      pick(test, 'app', `app area “${area.join(' ')}” (${source})`)
    }
    if (matched && !appShell.has(source)) continue
    const reason = appShell.has(source)
      ? `app smoke set: ${source} is part of every screen`
      : `app smoke set: no app test is named after ${source}`
    for (const test of appSmokeTests) pick(test, 'app', reason)
  }

  const all = runsEverything(changed, input.graph)
  return {
    ...(all !== undefined && { all }),
    picks: [...picks.values()].sort((a, b) => (a.file < b.file ? -1 : 1)),
  }
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

const lines = (text: string) => text.split('\n').filter((line) => line !== '')

export function defaultBranch(root: string): string {
  try {
    return git(root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD').trim()
  } catch {
    return 'origin/main'
  }
}

export function changedSince(root: string, base: string): string[] {
  const from = git(root, 'merge-base', 'HEAD', base).trim()
  return [
    ...new Set([
      ...lines(git(root, 'diff', '--name-only', '--no-renames', '--no-ext-diff', from, 'HEAD')),
      ...lines(git(root, 'diff', '--name-only', '--no-renames', '--no-ext-diff', 'HEAD')),
      ...lines(git(root, 'ls-files', '--others', '--exclude-standard')),
    ]),
  ].sort()
}

const scanned = /\.(ts|tsx|cjs|mjs|js)$/

export function knownFiles(listed: readonly string[], changed: readonly string[]): Set<string> {
  return new Set([...listed, ...changed])
}

export function readRepo(
  root: string,
  changed: readonly string[] = [],
): {
  graph: Graph
  tests: string[]
  electron: Set<string>
} {
  const listed = lines(git(root, 'ls-files', '--cached', '--others', '--exclude-standard'))
  const sources = new Map<string, string>()
  const files = knownFiles(listed, changed)
  for (const file of listed) {
    if (!scanned.test(file)) continue
    try {
      sources.set(file, readFileSync(path.join(root, file), 'utf8'))
    } catch {}
  }
  const packages: Record<string, { dir: string; exports: Record<string, string> }> = {}
  for (const file of listed) {
    if (!/^packages\/[^/]+\/package\.json$/.test(file)) continue
    try {
      const value: unknown = JSON.parse(readFileSync(path.join(root, file), 'utf8'))
      if (typeof value !== 'object' || value === null) continue
      const { name, exports } = value as { name?: unknown; exports?: unknown }
      if (typeof name !== 'string') continue
      packages[name] = {
        dir: path.posix.dirname(file),
        exports: Object.fromEntries(
          Object.entries(typeof exports === 'object' && exports !== null ? exports : {}).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        ),
      }
    } catch {}
  }
  const tests = globSync(testFilePatterns, { cwd: root })
    .map((file) => file.split(path.sep).join('/'))
    .sort()
  const electron = new Set(electronFiles(tests, (file) => path.join(root, file)))
  return { graph: importGraph(sources, files, packages), tests, electron }
}

export interface Chosen {
  run: Pick[]
  full: number
  left: number
}

export function chooseTests(selection: Selection, testCount: number): Chosen {
  const full = selection.all !== undefined ? testCount : selection.picks.length
  const run = selection.picks.filter((pick) => pick.kind === 'changed' || pick.kind === 'app')
  return { run, full, left: full - run.length }
}

const files = (count: number) => `${count} file${count === 1 ? '' : 's'}`

export function selectionText(
  selection: Selection,
  chosen: Chosen,
  base: string,
  electron: ReadonlySet<string>,
): string {
  const width = Math.max(0, ...chosen.run.map((pick) => pick.file.length))
  const rows = chosen.run.map(
    (pick) =>
      `  ${electron.has(pick.file) ? 'electron' : 'node    '}  ${pick.file.padEnd(width)}  ${pick.why}`,
  )
  if (chosen.full === 0) return `Affected tests since ${base}: none.`
  if (chosen.left === 0)
    return [`Affected tests since ${base}: ${files(chosen.full)}`, ...rows].join('\n')
  const what =
    selection.all !== undefined
      ? `every test (${files(chosen.full)}), because ${selection.all}`
      : files(chosen.full)
  return [
    `Affected tests since ${base}: ${what}. This run takes ${files(chosen.run.length)}: the changed test files and the Electron app tests for the changed app source. The scheduled full check covers the other ${chosen.left}.`,
    ...rows,
  ].join('\n')
}

export function leftOutText(
  run: readonly Pick[],
  electron: ReadonlySet<string>,
  sandbox: string,
): string | undefined {
  const skipped = run.filter((pick) => electron.has(pick.file))
  if (skipped.length === 0) return undefined
  return [
    `${sandbox} can’t start Electron, so the Affected tests Check left the Electron app tests out.`,
    'Run these outside the sandbox, at most 3 files per command: pnpm vitest run <files>',
    ...skipped.map((pick) => `  ${pick.file}  ${pick.why}`),
  ].join('\n')
}

export type Passes = ReadonlyMap<string, string>

const commitPattern = /^[0-9a-f]{40}$/

export function parsePasses(text: string): Passes {
  const value = parseJson(text)
  if (!isObject(value) || value.version !== 1 || !isObject(value.passes)) return new Map()
  const passes = new Map<string, string>()
  for (const [file, commit] of Object.entries(value.passes)) {
    if (isString(commit) && commitPattern.test(commit)) passes.set(file, commit)
  }
  return passes
}

export function passesText(passes: Passes): string {
  const sorted = [...passes].sort(([a], [b]) => (a < b ? -1 : 1))
  return `${JSON.stringify({ version: 1, passes: Object.fromEntries(sorted) }, null, 2)}\n`
}

export function mergePasses(
  passes: Passes,
  run: { commit: string; ran: readonly string[]; passed: ReadonlySet<string> },
): Passes {
  const merged = new Map(passes)
  for (const file of run.ran) {
    if (run.passed.has(file)) merged.set(file, run.commit)
    else merged.delete(file)
  }
  return merged
}

export interface Skipped {
  file: string
  commit: string
}

export interface Kept {
  run: Pick[]
  skipped: Skipped[]
}

export function skipPassed(
  run: readonly Pick[],
  passes: Passes,
  rerunFor: (commit: string) => ReadonlySet<string> | undefined,
): Kept {
  const reruns = new Map<string, ReadonlySet<string> | undefined>()
  const kept: Pick[] = []
  const skipped: Skipped[] = []
  for (const pick of run) {
    const commit = passes.get(pick.file)
    if (commit === undefined) {
      kept.push(pick)
      continue
    }
    if (!reruns.has(commit)) reruns.set(commit, rerunFor(commit))
    const rerun = reruns.get(commit)
    if (rerun === undefined || rerun.has(pick.file)) kept.push(pick)
    else skipped.push({ file: pick.file, commit })
  }
  return { run: kept, skipped }
}

export function skippedText(skipped: readonly Skipped[], record: string): string | undefined {
  if (skipped.length === 0) return undefined
  const byCommit = new Map<string, string[]>()
  for (const { file, commit } of skipped)
    byCommit.set(commit, [...(byCommit.get(commit) ?? []), file])
  return [
    `Skipped ${files(skipped.length)} that passed before, because nothing since picks them again:`,
    ...[...byCommit].flatMap(([commit, list]) => [
      `  passed on ${commit.slice(0, 9)}:`,
      ...list.map((file) => `    ${file}`),
    ]),
    `To run them anyway: pnpm check --affected --no-skip, or delete ${record}.`,
  ].join('\n')
}

export function commitExists(root: string, commit: string): boolean {
  if (!commitPattern.test(commit)) return false
  try {
    git(root, 'cat-file', '-e', `${commit}^{commit}`)
    return true
  } catch {
    return false
  }
}

export function changedFrom(root: string, commit: string): string[] {
  return [
    ...new Set([
      ...lines(git(root, 'diff', '--name-only', '--no-renames', '--no-ext-diff', commit)),
      ...lines(git(root, 'ls-files', '--others', '--exclude-standard')),
    ]),
  ].sort()
}

export function cleanCommit(root: string): string | undefined {
  if (git(root, 'status', '--porcelain', '--untracked-files=all').trim() !== '') return undefined
  return git(root, 'rev-parse', 'HEAD').trim()
}
