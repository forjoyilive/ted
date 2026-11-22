import { type Edition, edition, identity } from './edition.ts'

// No Node modules here: env.ts imports this file, and the renderer bundles env.ts through other
// protocol modules. Ted ships for macOS and Linux, so paths join with “/”.
const withoutTrailingSlash = (folder: string) => folder.replace(/(.)\/+$/, '$1')

export function sampleHome(which: Edition = edition, env: NodeJS.ProcessEnv = process.env): string {
  return `${withoutTrailingSlash(env.HOME ?? '')}/${identity(which).sampleFolder}`
}

export function isSampleHome(
  home: string,
  which: Edition = edition,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(env.HOME) && withoutTrailingSlash(home) === sampleHome(which, env)
}

const daemonFixture = (url: URL) => decodeURIComponent(url.pathname)

// The sample data runs on the same stand-ins as the tests. Packaging ships exactly these
// fixtures (`sampleFixtures` in packages/app/scripts/stage.ts), so each path is a literal
// that staging rewrites to the built file.
export function sampleFixtures() {
  return {
    shell: daemonFixture(new URL('../../daemon/test/fixtures/stub-shell.sh', import.meta.url)),
    xcrun: daemonFixture(new URL('../../daemon/test/fixtures/stub-xcrun.ts', import.meta.url)),
    idb: daemonFixture(new URL('../../daemon/test/fixtures/stub-idb.ts', import.meta.url)),
    keyring: daemonFixture(new URL('../../daemon/test/fixtures/stub-keyring.ts', import.meta.url)),
    freeBytes: daemonFixture(new URL('../../daemon/test/fixtures/free-bytes.txt', import.meta.url)),
    online: daemonFixture(new URL('../../daemon/test/fixtures/online.txt', import.meta.url)),
    load: daemonFixture(new URL('../../daemon/test/fixtures/load.txt', import.meta.url)),
    memory: daemonFixture(new URL('../../daemon/test/fixtures/memory.json', import.meta.url)),
  }
}

export type SampleInput = keyof ReturnType<typeof sampleInputs>

// The Ted inputs that turn a home into the sample data: stand-in agents, GitHub, keyring and
// simulator, and no login shell, notifications, login item or sleep prevention. Ted Dev’s demo
// sets them in its environment; the release computes them from the sample home itself and never
// reads them from the environment (`tedEnv` in env.ts).
export function sampleInputs(home: string) {
  const fixtures = sampleFixtures()
  const resolved = withoutTrailingSlash(home)
  const at = (...parts: string[]) => [resolved, ...parts].join('/')
  return {
    TED_DEMO: '1',
    TED_CLAUDE_BIN: at('bin', 'stub-claude'),
    TED_CODEX_BIN: at('bin', 'stub-codex'),
    TED_GH_BIN: at('bin', 'stub-gh'),
    TED_XCRUN_BIN: at('bin', 'stub-xcrun'),
    TED_OPEN_BIN: at('bin', 'stub-xcrun'),
    TED_IDB_BIN: at('bin', 'stub-idb'),
    TED_STUB_XCRUN: at('xcrun.json'),
    TED_KEYRING_MODULE: fixtures.keyring,
    TED_LINEAR_API: 'http://127.0.0.1:9/graphql',
    TED_STUB_GH: at('gh.json'),
    TED_LOGIN_SHELL: 'off',
    TED_FREE_BYTES_FILE: fixtures.freeBytes,
    TED_ONLINE_FILE: fixtures.online,
    TED_LOAD_FILE: fixtures.load,
    TED_MEMORY_FILE: fixtures.memory,
    TED_LOW_PRIORITY: 'off',
    TED_STAY_AWAKE: 'off',
    TED_TIME_MACHINE: 'off',
    TED_SKIP_FIRST_LAUNCH: '1',
    TED_LOGIN_ITEM_LOG: at('login-item.log'),
    TED_NOTIFY_LOG: at('notifications.jsonl'),
    TED_NOTIFY_STATUS: 'off',
    TED_FIX_LOG: at('fix.log'),
    TED_NUDGE_AFTER_MS: String(7 * 24 * 60 * 60_000),
    TED_STALL_AFTER_MS: String(7 * 24 * 60 * 60_000),
  }
}
