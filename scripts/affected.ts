import { execFileSync } from 'node:child_process'
import { globSync, readFileSync } from 'node:fs'
import path from 'node:path'
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
  kind: 'changed' | 'imports' | 'app'
  why: string
}

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
    if (tests.has(file) && !picks.has(file)) picks.set(file, { file, kind, why })
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
        pick(
          importer,
          'imports',
          file === source ? `imports ${source}` : `imports ${source} through ${file}`,
        )
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

export function readRepo(root: string): {
  graph: Graph
  tests: string[]
  electron: Set<string>
} {
  const listed = lines(git(root, 'ls-files', '--cached', '--others', '--exclude-standard'))
  const sources = new Map<string, string>()
  const files = new Set<string>()
  for (const file of listed) {
    if (!scanned.test(file)) {
      files.add(file)
      continue
    }
    try {
      sources.set(file, readFileSync(path.join(root, file), 'utf8'))
      files.add(file)
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

export function selectionText(
  selection: Selection,
  base: string,
  electron: ReadonlySet<string>,
): string {
  const picked = selection.picks.length
  const width = Math.max(0, ...selection.picks.map((pick) => pick.file.length))
  const rows = selection.picks.map(
    (pick) =>
      `  ${electron.has(pick.file) ? 'electron' : 'node    '}  ${pick.file.padEnd(width)}  ${pick.why}`,
  )
  if (selection.all !== undefined)
    return [
      `Affected tests since ${base}: every test, because ${selection.all}.`,
      ...(picked > 0 ? ['The change itself picks:', ...rows] : []),
    ].join('\n')
  if (picked === 0) return `Affected tests since ${base}: none.`
  return [`Affected tests since ${base}: ${picked} file${picked === 1 ? '' : 's'}`, ...rows].join(
    '\n',
  )
}

export function leftOutText(
  selection: Selection,
  electron: ReadonlySet<string>,
  sandbox: string,
): string | undefined {
  const skipped = selection.picks.filter((pick) => electron.has(pick.file))
  if (skipped.length === 0 && selection.all === undefined) return undefined
  const named = skipped.filter((pick) => pick.kind !== 'imports')
  const others = skipped.length - named.length
  return [
    `${sandbox} can’t start Electron, so the Affected tests Check left the Electron app tests out.`,
    named.length > 0
      ? 'Run these outside the sandbox, at most 3 files per command: pnpm vitest run <files>'
      : 'None of them was changed or is named after a changed file, so none needs a run by hand.',
    ...named.map((pick) => `  ${pick.file}  ${pick.why}`),
    ...(selection.all !== undefined
      ? ['Also left out: every other Electron test file.']
      : others > 0
        ? [
            `Also left out: ${others} Electron test file${others === 1 ? '' : 's'} that only import${others === 1 ? 's' : ''} changed code.`,
          ]
        : []),
  ].join('\n')
}
