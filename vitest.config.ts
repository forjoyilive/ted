import { globSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { heldLockEnv, smallRunFiles } from './packages/daemon/test/support/suite-lock.ts'
import { busy, busyLine, loadPerCore, scaledWorkers } from './scripts/machine-load.ts'
import {
  electronFiles,
  electronSandbox,
  launchesElectron,
  testFilePatterns,
} from './scripts/test-files.ts'

export { launchesElectron }

const here = (file: string) => fileURLToPath(new URL(file, import.meta.url))

const testFiles = testFilePatterns

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

function electronTestFiles(): string[] {
  return electronFiles(globSync(testFiles, { cwd: here('.') }), here)
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

const tedSandbox = process.env.TED_SANDBOX === '1'

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
    TED_IDB_BIN: here('./packages/daemon/test/fixtures/stub-idb.ts'),
    TED_EMULATOR_BIN: here('./packages/daemon/test/fixtures/stub-emulator.ts'),
    TED_ADB_BIN: here('./packages/daemon/test/fixtures/stub-adb.ts'),
    TED_AVDMANAGER_BIN: here('./packages/daemon/test/fixtures/stub-avdmanager.ts'),
    TED_LOGIN_SHELL: 'off',
    TED_FREE_BYTES_FILE: here('./packages/daemon/test/fixtures/free-bytes.txt'),
    TED_LOAD_FILE: here('./packages/daemon/test/fixtures/load.txt'),
    TED_MEMORY_FILE: here('./packages/daemon/test/fixtures/memory.json'),
    TED_ONLINE_FILE: here('./packages/daemon/test/fixtures/online.txt'),
    TED_KEYRING_MODULE: here('./packages/daemon/test/fixtures/stub-keyring.ts'),
    TED_LINEAR_API: 'http://127.0.0.1:9/graphql',
    TED_STAY_AWAKE: 'off',
    TED_SENTRY_DSN: 'http://test@127.0.0.1:9/1',
    TED_LOW_PRIORITY: 'off',
    TED_SKIP_FIRST_LAUNCH: '1',
    TED_TIME_MACHINE: 'off',
    TED_APP_TOKEN: 'test-app-token',
    TED_EDITOR_APP_DIRS: '',
    TED_TEST_FAILURES_FILE: 'off',
    TED_TEST_LOAD: 'off',
    TED_HOLD_REQUESTS_MS: '0',
    TED_REMOTE_EXECUTION: 'on',
    ...(tedSandbox && {
      TED_SANDBOX_BIN: here('./packages/daemon/test/fixtures/pass-through-sandbox.sh'),
    }),
  },
}

const sandboxName = electronSandbox()
const inSandbox = sandboxName !== undefined
if (sandboxName === 'Ted’s sandbox') {
  console.warn('TED_SANDBOX_SKIPPED: the Electron app tests')
}
if (sandboxName) {
  console.warn(
    `Skipping the Electron app tests: ${sandboxName} stops Electron registering with the window server, so every launch aborts. Run them outside the sandbox.`,
  )
}

export function tedTestConfig(include: string[]) {
  const exclude = inSandbox ? electronFiles(globSync(include), (file) => path.resolve(file)) : []
  return defineConfig({
    oxc: { jsx: { runtime: 'automatic' } },
    test: {
      ...testOptions,
      include,
      exclude,
      globalSetup: [
        ...testOptions.globalSetup,
        ...(!inSandbox && electronFiles(globSync(include), (file) => path.resolve(file)).length > 0
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
    passWithNoTests: inSandbox,
    projects: [
      {
        extends: true,
        test: {
          name: 'electron',
          sequence: { groupOrder: 0 },
          include: inSandbox ? [] : electron,
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
