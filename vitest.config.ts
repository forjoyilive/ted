import { globSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const here = (file: string) => fileURLToPath(new URL(file, import.meta.url))

const testFiles = ['packages/*/test/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts']

export function launchesElectron(file: string, seen = new Set<string>()): boolean {
  if (seen.has(file)) return false
  seen.add(file)
  const source = readFileSync(file, 'utf8')
  if (/\b_electron\b/.test(source)) return true
  return [...source.matchAll(/from '(\.\.?\/[^']+\.tsx?)'/g)].some((match) =>
    launchesElectron(path.resolve(path.dirname(file), match[1] ?? ''), seen),
  )
}

function electronTestFiles(): string[] {
  return globSync(testFiles, { cwd: here('.') }).filter((file) => launchesElectron(here(file)))
}

const testOptions = {
  testTimeout: 30_000,
  maxWorkers: 6,
  globalSetup: [here('./packages/daemon/test/support/global-setup.ts')],
  setupFiles: [
    here('./packages/daemon/test/support/setup.ts'),
    here('./packages/app/test/support/dom-setup.ts'),
  ],
  env: {
    TED_GH_BIN: here('./packages/daemon/test/fixtures/stub-gh.ts'),
    TED_XCRUN_BIN: here('./packages/daemon/test/fixtures/stub-xcrun.ts'),
    TED_OPEN_BIN: here('./packages/daemon/test/fixtures/stub-xcrun.ts'),
    TED_LOGIN_SHELL: 'off',
    TED_FREE_BYTES_FILE: here('./packages/daemon/test/fixtures/free-bytes.txt'),
    TED_LOAD_FILE: here('./packages/daemon/test/fixtures/load.txt'),
    TED_ONLINE_FILE: here('./packages/daemon/test/fixtures/online.txt'),
    TED_KEYRING_MODULE: here('./packages/daemon/test/fixtures/stub-keyring.ts'),
    TED_LINEAR_API: 'http://127.0.0.1:9/graphql',
    TED_STAY_AWAKE: 'off',
    TED_SKIP_FIRST_LAUNCH: '1',
    TED_TIME_MACHINE: 'off',
    TED_APP_TOKEN: 'test-app-token',
    TED_EDITOR_APP_DIRS: '',
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
    test: { ...testOptions, include, exclude },
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
        test: { name: 'electron', include: codexSandbox ? [] : electron, maxWorkers: 3, retry: 1 },
      },
      { extends: true, test: { name: 'node', include: testFiles, exclude: electron } },
    ],
  },
})
