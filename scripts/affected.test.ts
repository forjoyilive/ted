import path from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  affectedTests,
  appSmokeTests,
  electronSandbox,
  importGraph,
  leftOutText,
  readRepo,
  references,
  resolveReference,
  runsEverything,
  selectionText,
  sourceAreas,
  testArea,
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
      ['packages/app/test/requests-component.test.tsx', 'imports'],
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

describe('what the command prints', () => {
  test('each file with its project and reason', () => {
    expect(
      selectionText(select('packages/app/src/renderer/inbox.ts'), 'origin/main', electron),
    ).toBe(`Affected tests since origin/main: 3 files
  electron  packages/app/test/app-inbox.test.ts            app area “inbox” (packages/app/src/renderer/inbox.ts)
  node      packages/app/test/inbox.test.ts                imports packages/app/src/renderer/inbox.ts
  node      packages/app/test/requests-component.test.tsx  imports packages/app/src/renderer/inbox.ts through packages/app/src/renderer/views/Inbox.tsx`)
  })

  test('nothing affected, and everything affected', () => {
    expect(selectionText(select('README.md'), 'origin/main', electron)).toBe(
      'Affected tests since origin/main: none.',
    )
    expect(selectionText(select('vitest.config.ts'), 'origin/main', electron)).toBe(
      'Affected tests since origin/main: every test, because vitest.config.ts changed, which is part of the test runner.',
    )
    expect(
      selectionText(
        select('package.json', 'packages/app/test/app.test.ts'),
        'origin/main',
        electron,
      ),
    ).toBe(`Affected tests since origin/main: every test, because package.json changed, which decides what is installed.
The change itself picks:
  electron  packages/app/test/app.test.ts  changed`)
  })
})

describe('what a sandboxed run leaves out', () => {
  const text = (...changed: string[]) => leftOutText(select(...changed), electron, 'TED’s sandbox')

  test('nothing when no Electron test was selected', () => {
    expect(text('packages/daemon/src/redact.ts')).toBeUndefined()
  })

  test('the Electron tests picked by name are listed to run by hand', () => {
    expect(
      text('packages/app/src/renderer/inbox.ts'),
    ).toBe(`TED’s sandbox can’t start Electron, so the Affected tests Check left the Electron app tests out.
Run these outside the sandbox, at most 3 files per command: pnpm vitest run <files>
  packages/app/test/app-inbox.test.ts  app area “inbox” (packages/app/src/renderer/inbox.ts)`)
  })

  test('Electron tests that only import changed code are counted, not listed', () => {
    expect(
      text('packages/app/test/first-window.ts'),
    ).toBe(`TED’s sandbox can’t start Electron, so the Affected tests Check left the Electron app tests out.
None of them was changed or is named after a changed file, so none needs a run by hand.
Also left out: ${electron.size} Electron test files that only import changed code.`)
  })

  test('a run of every test says the rest were left out too', () => {
    expect(text('package.json', 'packages/app/test/app.test.ts')?.split('\n').slice(1)).toEqual([
      'Run these outside the sandbox, at most 3 files per command: pnpm vitest run <files>',
      '  packages/app/test/app.test.ts  changed',
      'Also left out: every other Electron test file.',
    ])
  })
})

test('Electron can’t start in Codex’s sandbox, or in TED’s on macOS', () => {
  expect(electronSandbox({}, 'darwin')).toBeUndefined()
  expect(electronSandbox({ TED_SANDBOX: '1' }, 'darwin')).toBe('TED’s sandbox')
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
