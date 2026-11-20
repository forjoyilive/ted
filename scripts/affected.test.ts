import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { sandboxReasons } from '../packages/daemon/test/support/ted-sandbox.ts'
import {
  affectedTests,
  appSmokeTests,
  changedFrom,
  chooseTests,
  cleanCommit,
  commitExists,
  electronSandbox,
  importGraph,
  knownFiles,
  leftOutText,
  mergePasses,
  type Pick,
  parsePasses,
  passesText,
  readRepo,
  references,
  resolveReference,
  runsEverything,
  selectionText,
  skipPassed,
  skippedText,
  sourceAreas,
  testArea,
  typecheckOnlyReason,
  words,
} from './affected.ts'

const packages = {
  '@ted/protocol': {
    dir: 'packages/protocol',
    exports: { '.': './src/index.ts', './time': './src/time.ts' },
  },
}

const sources = new Map([
  [
    'vitest.config.ts',
    `import { x } from "./scripts/machine-load.ts"
     const setup = here('./packages/daemon/test/support/setup.ts')
     const gh = here('./packages/daemon/test/fixtures/stub-gh.ts')`,
  ],
  ['scripts/check.ts', `import { y } from "./check-history.ts"`],
  ['scripts/check-history.ts', ''],
  ['scripts/machine-load.ts', ''],
  ['packages/daemon/test/support/setup.ts', ''],
  ['packages/daemon/test/fixtures/stub-gh.ts', ''],
  ['packages/daemon/test/fixtures/stub-app.ts', ''],
  ['packages/protocol/src/index.ts', `export * from "./time.ts"`],
  ['packages/protocol/src/time.ts', ''],
  ['packages/protocol/test/time.test.ts', `import { presets } from "../src/time.ts"`],
  ['packages/daemon/src/redact.ts', ''],
  ['packages/daemon/src/queue.ts', `import { presets } from "@ted/protocol/time"`],
  ['packages/daemon/src/server.ts', `import "./queue.ts"\nimport "./redact.ts"`],
  ['packages/daemon/test/helpers.ts', `import { start } from "../src/server.ts"`],
  ['packages/daemon/test/redact.test.ts', `import { redactSecrets } from "../src/redact.ts"`],
  ['packages/daemon/test/queue.test.ts', `import { startDaemon } from "./helpers.ts"`],
  [
    'packages/daemon/test/apps.test.ts',
    `const stub = fileURLToPath(new URL('./fixtures/stub-app.ts', import.meta.url))`,
  ],
  ['packages/app/src/main.ts', ''],
  ['packages/app/src/updates.ts', ''],
  ['packages/app/src/renderer/App.tsx', `import { Inbox } from "./views/Inbox.tsx"`],
  [
    'packages/app/src/renderer/views/Inbox.tsx',
    `import styles from "./Inbox.module.css"\nimport { group } from "../inbox.ts"`,
  ],
  ['packages/app/src/renderer/inbox.ts', ''],
  ['packages/app/src/renderer/components/FactoryMenu.tsx', ''],
  ['packages/app/src/renderer/components/Sidebar.tsx', ''],
  ['packages/app/src/renderer/settings/AgentsPage.tsx', ''],
  ['packages/app/src/renderer/views/FactorySettings.tsx', ''],
  ['packages/app/test/first-window.ts', ''],
  ['packages/app/test/inbox.test.ts', `import { group } from "../src/renderer/inbox.ts"`],
  [
    'packages/app/test/requests-component.test.tsx',
    `import { Inbox } from "../src/renderer/views/Inbox.tsx"`,
  ],
  ['packages/app/test/app.test.ts', `import { firstWindow } from "./first-window.ts"`],
  ['packages/app/test/app-inbox.test.ts', `import { firstWindow } from "./first-window.ts"`],
  ['packages/app/test/app-settings.test.ts', `import { firstWindow } from "./first-window.ts"`],
  ['packages/app/test/app-task.test.ts', `import { firstWindow } from "./first-window.ts"`],
  ['packages/app/test/app-sidebars.test.ts', `import { firstWindow } from "./first-window.ts"`],
  [
    'packages/app/test/app-factory-settings.test.ts',
    `import { firstWindow } from "./first-window.ts"`,
  ],
  ['packages/app/test/updates-app.test.ts', `import { firstWindow } from "./first-window.ts"`],
])

const files = new Set([...sources.keys(), 'packages/app/src/renderer/views/Inbox.module.css'])
const graph = importGraph(sources, files, packages)
const tests = [...sources.keys()].filter((file) => /\.test\.tsx?$/.test(file))
const electron = new Set(
  tests.filter((file) => sources.get(file)?.includes('first-window.ts') === true),
)

function select(...changed: string[]) {
  return affectedTests({ changed, graph, tests, electron })
}

function picked(...changed: string[]): Record<string, string> {
  return Object.fromEntries(select(...changed).picks.map((pick) => [pick.file, pick.why]))
}

describe('the import graph', () => {
  test('reads relative paths and @ted packages from imports and path strings', () => {
    expect(
      references(
        `import a from "./a.ts"\nimport "../b.tsx"\nawait import(\`./c.ts\`)\nnew URL('./fixtures/d.ts', import.meta.url)\nimport { e } from '@ted/protocol/time'\nimport fs from 'node:fs'\nconst f = \`./\${name}.ts\``,
      ),
    ).toEqual(['./a.ts', '../b.tsx', './c.ts', './fixtures/d.ts', '@ted/protocol/time'])
  })

  test('resolves a reference only to a file in the repo', () => {
    const from = 'packages/daemon/src/queue.ts'
    expect(resolveReference(from, './redact.ts', files, packages)).toBe(
      'packages/daemon/src/redact.ts',
    )
    expect(resolveReference(from, '@ted/protocol', files, packages)).toBe(
      'packages/protocol/src/index.ts',
    )
    expect(resolveReference(from, '@ted/protocol/time', files, packages)).toBe(
      'packages/protocol/src/time.ts',
    )
    expect(resolveReference(from, '@ted/protocol/missing', files, packages)).toBeUndefined()
    expect(resolveReference(from, './gone.ts', files, packages)).toBeUndefined()
    expect(resolveReference(from, '../../../../outside.ts', files, packages)).toBeUndefined()
    expect(
      resolveReference('vitest.config.ts', './scripts/machine-load.ts?raw', files, packages),
    ).toBe('scripts/machine-load.ts')
  })

  test('links a file to what it imports and to the files it names by path', () => {
    expect(graph.get('packages/daemon/src/server.ts')).toEqual([
      'packages/daemon/src/queue.ts',
      'packages/daemon/src/redact.ts',
    ])
    expect(graph.get('packages/daemon/test/apps.test.ts')).toEqual([
      'packages/daemon/test/fixtures/stub-app.ts',
    ])
    expect(graph.get('packages/app/src/renderer/views/Inbox.tsx')).toContain(
      'packages/app/src/renderer/views/Inbox.module.css',
    )
  })
})

describe('which tests a change affects', () => {
  test('a changed test file runs, and a deleted one doesn’t', () => {
    expect(
      picked('packages/protocol/test/time.test.ts', 'packages/daemon/test/gone.test.ts'),
    ).toEqual({
      'packages/protocol/test/time.test.ts': 'changed',
    })
  })

  test('a changed module runs every test that imports it, directly or through other files', () => {
    expect(picked('packages/daemon/src/redact.ts')).toEqual({
      'packages/daemon/test/redact.test.ts': 'imports packages/daemon/src/redact.ts',
      'packages/daemon/test/queue.test.ts':
        'imports packages/daemon/src/redact.ts through packages/daemon/test/helpers.ts',
    })
    expect(picked('packages/protocol/src/time.ts')).toEqual({
      'packages/protocol/test/time.test.ts': 'imports packages/protocol/src/time.ts',
      'packages/daemon/test/queue.test.ts':
        'imports packages/protocol/src/time.ts through packages/daemon/test/helpers.ts',
    })
  })

  test('a test that imports one changed file directly counts as direct, whatever else reaches it', () => {
    expect(select('packages/daemon/src/queue.ts', 'packages/daemon/test/helpers.ts').picks).toEqual(
      [
        {
          file: 'packages/daemon/test/queue.test.ts',
          kind: 'imports',
          why: 'imports packages/daemon/test/helpers.ts',
        },
      ],
    )
  })

  test('an Electron test named after changed app source keeps that reason when changed code also reaches it through imports', () => {
    const both = select('packages/app/test/first-window.ts', 'packages/app/src/renderer/inbox.ts')
    const inbox = both.picks.find((pick) => pick.file === 'packages/app/test/app-inbox.test.ts')
    expect(inbox).toEqual({
      file: 'packages/app/test/app-inbox.test.ts',
      kind: 'app',
      why: 'app area “inbox” (packages/app/src/renderer/inbox.ts)',
    })
    const chosen = chooseTests(both, tests, electron)
    expect(chosen.run.map((pick) => pick.file)).toContain('packages/app/test/app-inbox.test.ts')
    expect(leftOutText(chosen.run, electron, 'Ted’s sandbox')).toContain(
      '  packages/app/test/app-inbox.test.ts  app area “inbox”',
    )
    expect(
      select('packages/app/test/first-window.ts', 'packages/app/test/app-inbox.test.ts').picks.find(
        (pick) => pick.file === 'packages/app/test/app-inbox.test.ts',
      )?.kind,
    ).toBe('changed')
  })

  test('a deleted module or fixture runs the tests that still name it, and a deleted test file never runs', () => {
    const gone = [
      'packages/daemon/test/fixtures/stub-app.ts',
      'packages/daemon/src/redact.ts',
      'packages/daemon/test/apps.test.ts',
    ]
    const kept = new Map([...sources].filter(([file]) => !gone.includes(file)))
    const left = [...kept.keys()]
    expect(knownFiles(left, gone).has('packages/daemon/test/fixtures/stub-app.ts')).toBe(true)
    const pickedWith = (known: ReadonlySet<string>) =>
      affectedTests({
        changed: gone,
        graph: importGraph(kept, known, packages),
        tests: tests.filter((file) => !gone.includes(file)),
        electron,
      }).picks.map((pick) => [pick.file, pick.why])
    expect(pickedWith(new Set(left))).toEqual([])
    expect(pickedWith(knownFiles(left, gone))).toEqual([
      [
        'packages/daemon/test/queue.test.ts',
        'imports packages/daemon/src/redact.ts through packages/daemon/test/helpers.ts',
      ],
      ['packages/daemon/test/redact.test.ts', 'imports packages/daemon/src/redact.ts'],
    ])
    const fixture = importGraph(sources, knownFiles(left, gone), packages)
    expect(
      affectedTests({
        changed: ['packages/daemon/test/fixtures/stub-app.ts'],
        graph: fixture,
        tests,
        electron,
      }).picks.map((pick) => pick.file),
    ).toEqual(['packages/daemon/test/apps.test.ts'])
  })

  test('a changed helper or fixture runs the tests that import or name it', () => {
    expect(picked('packages/daemon/test/helpers.ts')).toEqual({
      'packages/daemon/test/queue.test.ts': 'imports packages/daemon/test/helpers.ts',
    })
    expect(picked('packages/daemon/test/fixtures/stub-app.ts')).toEqual({
      'packages/daemon/test/apps.test.ts': 'imports packages/daemon/test/fixtures/stub-app.ts',
    })
    expect(Object.keys(picked('packages/app/test/first-window.ts'))).toEqual([...electron].sort())
  })

  test('a stylesheet runs the tests of the component that imports it', () => {
    expect(picked('packages/app/src/renderer/views/Inbox.module.css')).toMatchObject({
      'packages/app/test/requests-component.test.tsx':
        'imports packages/app/src/renderer/views/Inbox.module.css through packages/app/src/renderer/views/Inbox.tsx',
      'packages/app/test/app-inbox.test.ts':
        'app area “inbox” (packages/app/src/renderer/views/Inbox.module.css)',
    })
  })

  test('an app source file runs the Electron app tests named after it or its folder', () => {
    expect(picked('packages/app/src/renderer/inbox.ts')).toEqual({
      'packages/app/test/inbox.test.ts': 'imports packages/app/src/renderer/inbox.ts',
      'packages/app/test/requests-component.test.tsx':
        'imports packages/app/src/renderer/inbox.ts through packages/app/src/renderer/views/Inbox.tsx',
      'packages/app/test/app-inbox.test.ts':
        'app area “inbox” (packages/app/src/renderer/inbox.ts)',
    })
    expect(picked('packages/app/src/renderer/settings/AgentsPage.tsx')).toEqual({
      'packages/app/test/app-settings.test.ts':
        'app area “setting” (packages/app/src/renderer/settings/AgentsPage.tsx)',
    })
    expect(picked('packages/app/src/renderer/views/FactorySettings.tsx')).toEqual({
      'packages/app/test/app-factory-settings.test.ts':
        'app area “factory setting” (packages/app/src/renderer/views/FactorySettings.tsx)',
    })
    expect(picked('packages/app/src/updates.ts')).toEqual({
      'packages/app/test/updates-app.test.ts': 'app area “update” (packages/app/src/updates.ts)',
    })
  })

  test('an app source file no Electron test is named after runs the app smoke set', () => {
    const why =
      'app smoke set: no app test is named after packages/app/src/renderer/components/FactoryMenu.tsx'
    expect(picked('packages/app/src/renderer/components/FactoryMenu.tsx')).toEqual(
      Object.fromEntries(appSmokeTests.map((file) => [file, why])),
    )
  })

  test('a file that is part of every screen runs the smoke set as well as its own tests', () => {
    expect(picked('packages/app/src/renderer/components/Sidebar.tsx')).toEqual({
      'packages/app/test/app-sidebars.test.ts':
        'app area “sidebar” (packages/app/src/renderer/components/Sidebar.tsx)',
      ...Object.fromEntries(
        appSmokeTests.map((file) => [
          file,
          'app smoke set: packages/app/src/renderer/components/Sidebar.tsx is part of every screen',
        ]),
      ),
    })
    expect(Object.keys(picked('packages/app/src/main.ts'))).toEqual(appSmokeTests.toSorted())
  })

  test('a change outside the app’s source picks no Electron test by name', () => {
    expect(picked('packages/daemon/src/inbox.ts', 'docs/inbox.md', 'README.md')).toEqual({})
  })

  test('the reason kinds separate the import graph from the change itself', () => {
    expect(
      select('packages/app/src/renderer/inbox.ts', 'packages/app/test/inbox.test.ts').picks.map(
        (pick) => [pick.file, pick.kind],
      ),
    ).toEqual([
      ['packages/app/test/app-inbox.test.ts', 'app'],
      ['packages/app/test/inbox.test.ts', 'changed'],
      ['packages/app/test/requests-component.test.tsx', 'through'],
    ])
  })
})

describe('changes that run every test', () => {
  test.each([
    ['vitest.config.ts', 'is part of the test runner'],
    ['scripts/check.ts', 'is part of the test runner'],
    ['scripts/check-history.ts', 'which the test runner loads'],
    ['scripts/machine-load.ts', 'which the test runner loads'],
    ['packages/daemon/test/support/setup.ts', 'which the test runner loads'],
    ['packages/daemon/test/fixtures/stub-gh.ts', 'which the test runner loads'],
    ['package.json', 'decides what is installed'],
    ['pnpm-lock.yaml', 'decides what is installed'],
    ['packages/app/package.json', 'decides what is installed'],
  ])('%s', (file, reason) => {
    expect(runsEverything(['README.md', file], graph)).toContain(`${file} changed`)
    expect(runsEverything([file], graph)).toContain(reason)
    expect(select(file).all).toContain(file)
  })

  test('other changes don’t', () => {
    expect(
      runsEverything(
        [
          'packages/daemon/test/helpers.ts',
          'packages/daemon/test/fixtures/stub-app.ts',
          'packages/daemon/src/redact.ts',
          'packages/app/src/main.ts',
          'docs/package.json',
        ],
        graph,
      ),
    ).toBeUndefined()
    expect(select('packages/daemon/src/redact.ts').all).toBeUndefined()
  })
})

describe('app areas', () => {
  test('names split into lower-case words without a plural s', () => {
    expect(words('FactorySettings')).toEqual(['factory', 'setting'])
    expect(words('inbox-grouping')).toEqual(['inbox', 'grouping'])
    expect(words('GitHubSetupForm')).toEqual(['git', 'hub', 'setup', 'form'])
    expect(words('apps')).toEqual(['app'])
    expect(words('ted')).toEqual(['ted'])
  })

  test('a test’s area is its name without app-, -ui and -app', () => {
    expect(testArea('packages/app/test/app-settings.test.ts')).toEqual(['setting'])
    expect(testArea('packages/app/test/app.test.ts')).toEqual(['app'])
    expect(testArea('packages/app/test/plans-ui.test.ts')).toEqual(['plan'])
    expect(testArea('packages/app/test/updates-app.test.ts')).toEqual(['update'])
    expect(testArea('packages/app/test/task-shell.test.ts')).toEqual(['task', 'shell'])
  })

  test('a source file’s areas are its name and its folders', () => {
    expect(sourceAreas('packages/app/src/renderer/settings/AgentsPage.tsx')).toEqual([
      ['agent', 'page'],
      ['setting'],
    ])
    expect(sourceAreas('packages/app/src/renderer/views/Inbox.module.css')).toEqual([['inbox']])
    expect(sourceAreas('packages/app/src/preload.cjs')).toEqual([['preload']])
    expect(sourceAreas('packages/daemon/src/inbox.ts')).toEqual([])
  })
})

describe('how much of the affected set a run takes', () => {
  const pick = (kind: Pick['kind'], index: number, prefix: string = kind): Pick => ({
    file: `${prefix}-${index}.test.ts`,
    kind,
    why: kind,
  })
  const many = (kind: Pick['kind'], count: number, prefix?: string) =>
    Array.from({ length: count }, (_, index) => pick(kind, index, prefix))
  const kinds = (picks: readonly Pick[]) =>
    Object.fromEntries(
      ['changed', 'imports', 'through', 'app'].map((kind) => [
        kind,
        picks.filter((found) => found.kind === kind).length,
      ]),
    )

  test('a run takes the changed test files, the direct importers and the app tests, however many they are', () => {
    const picks = [
      ...many('changed', 70),
      ...many('imports', 300),
      ...many('through', 30),
      ...many('app', 5),
    ]
    const chosen = chooseTests({ picks }, [], new Set())
    expect(chosen.full).toBe(405)
    expect(kinds(chosen.run)).toEqual({ changed: 70, imports: 300, through: 0, app: 5 })
    expect(kinds(chosen.left)).toEqual({ changed: 0, imports: 0, through: 30, app: 0 })
  })

  test('an Electron test that only imports a changed file is left out', () => {
    const picks = [...many('imports', 2, 'node'), ...many('imports', 1, 'electron')]
    const chosen = chooseTests({ picks }, [], new Set(['electron-0.test.ts']))
    expect(chosen.run.map((found) => found.file)).toEqual(['node-0.test.ts', 'node-1.test.ts'])
    expect(chosen.left.map((found) => found.file)).toEqual(['electron-0.test.ts'])
  })

  test('a change to the test runner runs what the change itself picks', () => {
    const picks = [pick('changed', 0), pick('imports', 0), pick('through', 0)]
    const all = ['changed-0.test.ts', 'imports-0.test.ts', 'other.test.ts', 'through-0.test.ts']
    expect(chooseTests({ all: 'package.json changed', picks }, all, new Set())).toEqual({
      run: [pick('changed', 0), pick('imports', 0)],
      left: [pick('through', 0)],
      unpicked: ['other.test.ts'],
      full: 4,
    })
  })
})

describe('a break in a test the change didn’t touch fails the change’s own check', () => {
  test('changed source runs the unchanged test files that import it', () => {
    const daemon = select('packages/daemon/src/redact.ts')
    expect(chooseTests(daemon, tests, electron).run.map((found) => found.file)).toEqual([
      'packages/daemon/test/redact.test.ts',
    ])
    const app = select('packages/app/src/renderer/inbox.ts')
    expect(chooseTests(app, tests, electron).run.map((found) => found.file)).toEqual([
      'packages/app/test/app-inbox.test.ts',
      'packages/app/test/inbox.test.ts',
    ])
  })
})

describe('changes Typecheck covers', () => {
  test('a file that only re-exports, or only declares types, picks no tests by itself', () => {
    const barrel = `// The package's entry\nexport * from "./time.ts"\nexport { a, type B } from "./a.ts";\nexport type { C } from "./c.ts"\nexport * as d from "./d.ts"\nexport interface E { f: string }`
    expect(typecheckOnlyReason('src/index.ts', undefined, barrel)).toBe(
      'only re-exports other files',
    )
    expect(typecheckOnlyReason('src/types.ts', undefined, 'export type A = { b: string }')).toBe(
      'declares only types',
    )
  })

  test('a change that leaves the code the same once types are stripped picks no tests by itself', () => {
    const before = 'export function f(a: string) {\n  return a\n}'
    const after =
      'export function f(a: string | number): string {\n  return a as string\n}\nexport type G = number'
    expect(typecheckOnlyReason('src/f.ts', before, after)).toBe('changes only types')
    expect(
      typecheckOnlyReason('src/f.ts', before, 'export function f(a: string) {\n  return a + 1\n}'),
    ).toBeUndefined()
  })

  test('a change inside a string, even to its spaces, counts as code', () => {
    expect(
      typecheckOnlyReason(
        'src/f.ts',
        'export const url = "https://old"',
        'export const url = "https://new"',
      ),
    ).toBeUndefined()
    expect(
      typecheckOnlyReason('src/f.ts', 'export const s = `a  b`', 'export const s = `a b`'),
    ).toBeUndefined()
    expect(
      typecheckOnlyReason('src/f.ts', "export const s = 'a // b'", "export const s = 'a // c'"),
    ).toBeUndefined()
  })

  test('code, a new file with code, TSX, a deleted file and syntax the stripper can’t read all count as code', () => {
    expect(typecheckOnlyReason('src/f.ts', undefined, 'export const a = 1')).toBeUndefined()
    expect(
      typecheckOnlyReason('src/f.ts', undefined, 'import { a } from "./a.ts"\nexport { a }'),
    ).toBeUndefined()
    expect(typecheckOnlyReason('src/F.tsx', undefined, 'export * from "./a.ts"')).toBeUndefined()
    expect(typecheckOnlyReason('src/f.ts', 'export const a = 1', undefined)).toBeUndefined()
    expect(typecheckOnlyReason('src/f.ts', 'const = ;', 'const = ;')).toBeUndefined()
  })

  test('the selection walks no importers from a file Typecheck covers, and names it', () => {
    const typecheckOnly = new Map([
      ['packages/protocol/src/index.ts', 'only re-exports other files'],
    ])
    const selection = affectedTests({
      changed: ['packages/protocol/src/index.ts', 'packages/daemon/src/redact.ts'],
      graph,
      tests,
      electron,
      typecheckOnly,
    })
    expect(selection.picks.map((found) => found.file)).toEqual([
      'packages/daemon/test/queue.test.ts',
      'packages/daemon/test/redact.test.ts',
    ])
    expect(selection.typecheckOnly).toEqual(typecheckOnly)
  })
})

describe('what the command prints', () => {
  const text = (changed: string[], list = false) => {
    const selection = select(...changed)
    return selectionText(
      selection,
      chooseTests(selection, tests, electron),
      'origin/main',
      electron,
      list,
    )
  }

  test('each file with its project and reason', () => {
    expect(
      text(['packages/app/test/inbox.test.ts', 'packages/app/test/app-inbox.test.ts']),
    ).toBe(`Affected tests since origin/main: 2 files
  electron  packages/app/test/app-inbox.test.ts  changed
  node      packages/app/test/inbox.test.ts      changed`)
  })

  test('nothing affected', () => {
    expect(text(['README.md'])).toBe('Affected tests since origin/main: none.')
  })

  test('test files that reach changed code only through other files are counted, and --list names them', () => {
    expect(text(['packages/daemon/src/redact.ts'])).toBe(
      `Affected tests since origin/main: 2 files. This run takes 1 file: the changed test files, the test files that import a changed file, and the Electron app tests for the changed app source.
  node      packages/daemon/test/redact.test.ts  imports packages/daemon/src/redact.ts
The scheduled full check runs the rest:
  1 file that reaches a changed file only through other files
pnpm check --affected --list names each file.`,
    )
    expect(text(['packages/daemon/src/redact.ts'], true)).toContain(
      `  1 file that reaches a changed file only through other files
    packages/daemon/test/queue.test.ts  imports packages/daemon/src/redact.ts through packages/daemon/test/helpers.ts`,
    )
  })

  test('Electron tests that only import changed code are counted with the reason they don’t run', () => {
    expect(text(['packages/app/test/first-window.ts'], true)).toContain(
      `  7 Electron app tests that import a changed file: an Electron test runs only when it changed or is named after changed app source
    packages/app/test/app-factory-settings.test.ts  imports packages/app/test/first-window.ts`,
    )
  })

  test('a change to the test runner names every test and runs what the change itself picks', () => {
    expect(
      text(['package.json', 'packages/app/test/app.test.ts']),
    ).toBe(`Affected tests since origin/main: every test (${tests.length} files), because package.json changed, which decides what is installed. This run takes 1 file: the changed test files, the test files that import a changed file, and the Electron app tests for the changed app source.
  electron  packages/app/test/app.test.ts  changed
The scheduled full check runs the rest:
  every other test file (${tests.length - 1}), because package.json changed, which decides what is installed
pnpm check --affected --list names each file.`)
    expect(text(['package.json', 'packages/app/test/app.test.ts'], true)).toContain(
      `  every other test file (${tests.length - 1}), because package.json changed, which decides what is installed
    packages/app/test/app-factory-settings.test.ts
    packages/app/test/app-inbox.test.ts`,
    )
  })

  test('a file Typecheck covers is named with its reason', () => {
    const selection = affectedTests({
      changed: ['packages/protocol/src/index.ts'],
      graph,
      tests,
      electron,
      typecheckOnly: new Map([['packages/protocol/src/index.ts', 'only re-exports other files']]),
    })
    expect(
      selectionText(selection, chooseTests(selection, tests, electron), 'origin/main', electron),
    ).toBe(`Affected tests since origin/main: none.
Picks no tests by itself, because Typecheck covers it:
  packages/protocol/src/index.ts  only re-exports other files`)
  })
})

describe('what a sandboxed run leaves out', () => {
  const text = (...changed: string[]) => {
    const selection = select(...changed)
    return leftOutText(chooseTests(selection, tests, electron).run, electron, 'Ted’s sandbox')
  }

  test('nothing when no Electron test runs', () => {
    expect(text('packages/daemon/src/redact.ts')).toBeUndefined()
  })

  test('the Electron tests that changed or were picked by name are listed to run by hand', () => {
    expect(
      text('packages/app/src/renderer/inbox.ts', 'packages/app/test/app.test.ts'),
    ).toBe(`Ted’s sandbox can’t start Electron, so the Affected tests Check left the Electron app tests out.
Run these outside the sandbox, at most 3 files per command: pnpm vitest run <files>
  packages/app/test/app-inbox.test.ts  app area “inbox” (packages/app/src/renderer/inbox.ts)
  packages/app/test/app.test.ts  changed`)
  })

  test('Electron tests that only import changed code aren’t in the run, so nothing is left out', () => {
    expect(text('packages/app/test/first-window.ts')).toBeUndefined()
  })

  test('files whose tests Ted’s sandbox skipped are listed with their reasons, Electron or not', () => {
    const skipped = new Map([
      ['packages/daemon/test/sandbox.test.ts', ['a second sandbox can’t start']],
      ['packages/cli/test/demo.test.ts', ['Ted home', 'processes']],
    ])
    expect(
      leftOutText([], electron, undefined, skipped),
    ).toBe(`Ted’s sandbox made some tests skip themselves, so the Affected tests Check left these files out.
Run these outside the sandbox, at most 3 files per command: pnpm vitest run <files>
  packages/cli/test/demo.test.ts  skipped: Ted home; processes
  packages/daemon/test/sandbox.test.ts  skipped: a second sandbox can’t start`)
    const selection = select('packages/app/test/app.test.ts')
    expect(
      leftOutText(chooseTests(selection, tests, electron).run, electron, 'Ted’s sandbox', skipped),
    ).toBe(`Ted’s sandbox can’t start Electron, so the Affected tests Check left the Electron app tests out.
Ted’s sandbox made some tests skip themselves, so the Affected tests Check left these files out.
Run these outside the sandbox, at most 3 files per command: pnpm vitest run <files>
  packages/app/test/app.test.ts  changed
  packages/cli/test/demo.test.ts  skipped: Ted home; processes
  packages/daemon/test/sandbox.test.ts  skipped: a second sandbox can’t start`)
  })

  test('files skipped because Ted’s temp folder is in a Ted home get a command with TMPDIR outside it', () => {
    const skipped = new Map([
      ['scripts/execution-lab.test.ts', [sandboxReasons.tedHome, sandboxReasons.processes]],
      ['packages/daemon/test/sandbox.test.ts', [sandboxReasons.secondSandbox]],
      ['packages/cli/test/demo.test.ts', [sandboxReasons.tedHome]],
    ])
    expect(leftOutText([], electron, undefined, skipped)).toBe(
      [
        'Ted’s sandbox made some tests skip themselves, so the Affected tests Check left these files out.',
        'Run these outside the sandbox, at most 3 files per command: pnpm vitest run <files>',
        `  packages/daemon/test/sandbox.test.ts  skipped: ${sandboxReasons.secondSandbox}`,
        'A Run’s TMPDIR is under ~/.ted even outside the sandbox, so run these outside the sandbox with a temp folder outside ~/.ted, at most 3 files per command: TMPDIR="$(mktemp -d /tmp/ted-vitest.XXXXXX)" pnpm vitest run <files>',
        `  packages/cli/test/demo.test.ts  skipped: ${sandboxReasons.tedHome}`,
        `  scripts/execution-lab.test.ts  skipped: ${sandboxReasons.tedHome}; ${sandboxReasons.processes}`,
      ].join('\n'),
    )
    expect(
      leftOutText(
        [],
        electron,
        undefined,
        new Map([['packages/cli/test/demo.test.ts', [sandboxReasons.tedHome]]]),
      ),
    ).not.toContain('\nRun these outside the sandbox')
  })
})

test('Electron can’t start in Codex’s sandbox, or in Ted’s on macOS', () => {
  expect(electronSandbox({}, 'darwin')).toBeUndefined()
  expect(electronSandbox({ TED_SANDBOX: '1' }, 'darwin')).toBe('Ted’s sandbox')
  expect(electronSandbox({ TED_SANDBOX: '1' }, 'linux')).toBeUndefined()
  expect(electronSandbox({ CODEX_SANDBOX: 'seatbelt' }, 'linux')).toBe('Codex’s sandbox')
})

test('this repo: the smoke set exists, the setup files run everything, and a sidebar change reaches the settings test', () => {
  const repo = readRepo(path.resolve(import.meta.dirname, '..'))
  for (const file of appSmokeTests) expect(repo.electron).toContain(file)
  expect(runsEverything(['packages/daemon/test/support/setup.ts'], repo.graph)).toBeDefined()
  expect(runsEverything(['packages/daemon/test/fixtures/stub-claude.ts'], repo.graph)).toBeDefined()
  const sidebar = affectedTests({
    changed: ['packages/app/src/renderer/components/Sidebar.tsx'],
    ...repo,
  })
  expect(sidebar.all).toBeUndefined()
  expect(sidebar.picks.map((pick) => pick.file)).toEqual(
    expect.arrayContaining([
      'packages/app/test/app-settings.test.ts',
      'packages/app/test/app-sidebars.test.ts',
    ]),
  )
  const merge = affectedTests({ changed: ['packages/daemon/test/merge-harness.ts'], ...repo })
  expect(merge.picks.length).toBeGreaterThan(0)
  expect(merge.picks.every((pick) => pick.file.startsWith('packages/daemon/test/'))).toBe(true)
})

describe('a rerun skips files that passed before', () => {
  const a = 'a'.repeat(40)
  const b = 'b'.repeat(40)
  const pick = (file: string): Pick => ({ file, kind: 'changed', why: 'changed' })

  test('the record keeps each file’s own commit and ignores what it can’t read', () => {
    const passes = new Map([
      ['x.test.ts', a],
      ['y.test.ts', b],
    ])
    expect(parsePasses(passesText(passes))).toEqual(passes)
    expect(parsePasses('{')).toEqual(new Map())
    expect(parsePasses(JSON.stringify({ version: 2, passes: { 'x.test.ts': a } }))).toEqual(
      new Map(),
    )
    expect(
      parsePasses(
        JSON.stringify({ version: 1, passes: { 'x.test.ts': '--output=x', 'y.test.ts': b } }),
      ),
    ).toEqual(new Map([['y.test.ts', b]]))
  })

  test('a run adds what passed, drops what failed and keeps what it didn’t run', () => {
    const before = new Map([
      ['kept.test.ts', a],
      ['failed.test.ts', a],
    ])
    const merged = mergePasses(before, {
      commit: b,
      ran: ['failed.test.ts', 'new.test.ts'],
      passed: new Set(['new.test.ts']),
    })
    expect(merged).toEqual(
      new Map([
        ['kept.test.ts', a],
        ['new.test.ts', b],
      ]),
    )
  })

  test('a passed file runs again only when the changes since its commit pick it', () => {
    const asked: string[] = []
    const rerunFor = (commit: string) => {
      asked.push(commit)
      if (commit === b) return undefined
      return new Set(['changed-again.test.ts'])
    }
    const passes = new Map([
      ['untouched.test.ts', a],
      ['also-untouched.test.ts', a],
      ['changed-again.test.ts', a],
      ['lost-commit.test.ts', b],
    ])
    const run = [
      'untouched.test.ts',
      'also-untouched.test.ts',
      'changed-again.test.ts',
      'lost-commit.test.ts',
      'never-passed.test.ts',
    ].map(pick)
    const result = skipPassed(run, passes, rerunFor)
    expect(result.run.map((kept) => kept.file)).toEqual([
      'changed-again.test.ts',
      'lost-commit.test.ts',
      'never-passed.test.ts',
    ])
    expect(result.skipped).toEqual([
      { file: 'untouched.test.ts', commit: a },
      { file: 'also-untouched.test.ts', commit: a },
    ])
    expect(asked).toEqual([a, b])
  })

  test('the command names each skipped file, its commit and how to run it anyway', () => {
    expect(skippedText([], 'record.json')).toBeUndefined()
    expect(skippedText([{ file: 'x.test.ts', commit: a }], 'record.json')).toContain(
      'Skipped 1 file that passed before, because nothing since picks it again:',
    )
    expect(
      skippedText(
        [
          { file: 'x.test.ts', commit: a },
          { file: 'y.test.ts', commit: b },
          { file: 'z.test.ts', commit: a },
        ],
        'record.json',
      ),
    ).toBe(
      [
        'Skipped 3 files that passed before, because nothing since picks them again:',
        `  passed on ${a.slice(0, 9)}:`,
        '    x.test.ts',
        '    z.test.ts',
        `  passed on ${b.slice(0, 9)}:`,
        '    y.test.ts',
        'To run them anyway: pnpm check --affected --no-skip, or delete record.json.',
      ].join('\n'),
    )
  })

  test('git: a clean tree gives its commit, and changes since a commit include uncommitted and new files', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ted-affected-passes-'))
    try {
      const git = (...args: string[]) =>
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
          cwd: root,
          encoding: 'utf8',
        })
      git('init', '-q')
      writeFileSync(path.join(root, 'a.test.ts'), '1')
      writeFileSync(path.join(root, 'b.test.ts'), '1')
      git('add', '.')
      git('commit', '-qm', 'one')
      const first = cleanCommit(root)
      expect(first).toMatch(/^[0-9a-f]{40}$/)
      expect(commitExists(root, first ?? '')).toBe(true)
      expect(commitExists(root, 'c'.repeat(40))).toBe(false)
      expect(changedFrom(root, first ?? '')).toEqual([])
      writeFileSync(path.join(root, 'a.test.ts'), '2')
      git('commit', '-qam', 'two')
      writeFileSync(path.join(root, 'b.test.ts'), '2')
      writeFileSync(path.join(root, 'c.test.ts'), '1')
      expect(cleanCommit(root)).toBeUndefined()
      expect(changedFrom(root, first ?? '')).toEqual(['a.test.ts', 'b.test.ts', 'c.test.ts'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
