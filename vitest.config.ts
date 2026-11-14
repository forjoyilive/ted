import { globSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { heldLockEnv, smallRunFiles } from './packages/daemon/test/support/suite-lock.ts'
import { busy, busyLine, loadPerCore, scaledWorkers } from './scripts/machine-load.ts'

const here = (file: string) => fileURLToPath(new URL(file, import.meta.url))

const testFiles = ['packages/*/test/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts']

const flagsWithValues = new Set([
  '-t',
  '--testNamePattern',
  '--reporter',
  '--project',
  '--maxWorkers',
  '--outputFile',
  '--outputFile.json',
  '--config',
  '--root',
  '--dir',
])

// A run of 10 or more files takes the whole machine (suite-lock.ts), so it gets 6 workers;
// smaller runs share it two at a time and get 3 each. A busy machine gets fewer.
export function workersFor(
  args: readonly string[],
  files: readonly string[],
  load?: number,
): number {
  const filters: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? ''
    if (flagsWithValues.has(arg)) index++
    else if (!arg.startsWith('-') && arg !== 'run') filters.push(arg)
  }
  const matched =
    filters.length === 0
      ? files.length
      : files.filter((file) => filters.some((filter) => file.includes(filter))).length
  return scaledWorkers(matched >= smallRunFiles ? 6 : 3, load)
}

export function launchesElectron(file: string, seen = new Set<string>()): boolean {
  if (seen.has(file)) return false
  seen.add(file)
  const source = readFileSync(file, 'utf8')
  if (/\b_electron\b|\bresolveElectron\s*\(\s*\)/.test(source)) return true
  return [...source.matchAll(/from '(\.\.?\/[^']+\.tsx?)'/g)].some((match) =>
    launchesElectron(path.resolve(path.dirname(file), match[1] ?? ''), seen),
  )
}

function electronTestFiles(): string[] {
  return globSync(testFiles, { cwd: here('.') }).filter((file) => launchesElectron(here(file)))
}

const electronSetup = here('./packages/app/test/support/electron-setup.ts')

const load = loadPerCore()
const allFiles = globSync(testFiles, { cwd: here('.') })
const workers = workersFor(process.argv.slice(2), allFiles, load)
const electronWorkers = scaledWorkers(3, load)
const idleWorkers = workersFor(process.argv.slice(2), allFiles)

// pnpm check sets the lock variable and passes its own --maxWorkers, and says this itself.
if (busy(load) && !process.env[heldLockEnv] && workers < idleWorkers) {
  console.warn(busyLine(load, `${workers} worker${workers === 1 ? '' : 's'}`, `${idleWorkers}`))
}

const testOptions = {
  testTimeout: 30_000,
  expect: { poll: { timeout: 10_000 } },
  maxWorkers: workers,
  globalSetup: [here('./packages/daemon/test/support/global-setup.ts')],
  setupFiles: [
    here('./packages/daemon/test/support/setup.ts'),
    here('./packages/app/test/support/dom-setup.ts'),
  ],
  env: {
    TED_GH_BIN: here('./packages/daemon/test/fixtures/stub-gh.ts'),
    TED_CLAUDE_BIN: here('./packages/daemon/test/fixtures/stub-claude.ts'),
    TED_CODEX_BIN: here('./packages/daemon/test/fixtures/stub-codex.ts'),
    TED_ANTIGRAVITY_BIN: here('./packages/daemon/test/fixtures/no-antigravity-here'),
    TED_XCRUN_BIN: here('./packages/daemon/test/fixtures/stub-xcrun.ts'),
    TED_OPEN_BIN: here('./packages/daemon/test/fixtures/stub-xcrun.ts'),
    TED_LOGIN_SHELL: 'off',
    TED_FREE_BYTES_FILE: here('./packages/daemon/test/fixtures/free-bytes.txt'),
    TED_LOAD_FILE: here('./packages/daemon/test/fixtures/load.txt'),
    TED_ONLINE_FILE: here('./packages/daemon/test/fixtures/online.txt'),
    TED_KEYRING_MODULE: here('./packages/daemon/test/fixtures/stub-keyring.ts'),
    TED_LINEAR_API: 'http://127.0.0.1:9/graphql',
    TED_STAY_AWAKE: 'off',
    TED_LOW_PRIORITY: 'off',
    TED_SKIP_FIRST_LAUNCH: '1',
    TED_TIME_MACHINE: 'off',
    TED_APP_TOKEN: 'test-app-token',
    TED_EDITOR_APP_DIRS: '',
    TED_TEST_FAILURES_FILE: 'off',
    TED_TEST_LOAD: 'off',
    TED_HOLD_REQUESTS_MS: '0',
    TED_REMOTE_EXECUTION: 'on',
  },
}

const codexSandbox = process.env.CODEX_SANDBOX !== undefined
if (codexSandbox) {
  console.warn(
    'Skipping the Electron app tests: Codex’s sandbox stops Electron registering with the window server, so every launch aborts. Run them outside the sandbox.',
  )
}

export function tedTestConfig(include: string[]) {
  const exclude = codexSandbox
    ? globSync(include).filter((file) => launchesElectron(path.resolve(file)))
    : []
  return defineConfig({
    oxc: { jsx: { runtime: 'automatic' } },
    test: {
      ...testOptions,
      include,
      exclude,
      globalSetup: [
        ...testOptions.globalSetup,
        ...(!codexSandbox && globSync(include).some((file) => launchesElectron(path.resolve(file)))
          ? [electronSetup]
          : []),
      ],
    },
  })
}

const electron = electronTestFiles()

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    ...testOptions,
    projects: [
      {
        extends: true,
        test: {
          name: 'electron',
          sequence: { groupOrder: 0 },
          include: codexSandbox ? [] : electron,
          maxWorkers: electronWorkers,
          retry: 1,
          globalSetup: [...testOptions.globalSetup, electronSetup],
        },
      },
      {
        extends: true,
        test: {
          name: 'node',
          sequence: { groupOrder: 1 },
          include: testFiles,
          exclude: electron,
        },
      },
    ],
  },
})
