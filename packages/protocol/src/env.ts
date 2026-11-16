import { type Edition, edition } from './edition.ts'

export const tedEnvironment: Readonly<Record<string, string | false>> = {
  TED_APP_EXECUTABLE: 'Installed app executable used by the CLI to open TED.',
  TED_APP_TOKEN: false,
  TED_AUTOMATION: 'Automation context for CLI task creation.',
  TED_BROWSER_PROFILE: 'Profile folder the daemon gives an Automation Run’s headless browser.',
  TED_CHECK_CPUS:
    'Logical cores TED tells a Check command it may use, so a Check leaves room for Runs.',
  TED_CLAUDE_BIN: false,
  TED_CODEX_BIN: false,
  TED_ANTIGRAVITY_BIN: false,
  TED_REAL_ANTIGRAVITY_BIN: false,
  TED_DEMO: false,
  TED_DEMO_STARTED: false,
  TED_DERIVED_DATA: 'Task Xcode DerivedData folder supplied to Apps, Checks and worktree commands.',
  TED_STUB_GH: false,
  TED_STUB_XCRUN: false,
  TED_STUB_ANDROID: false,
  TED_EDITOR_APP_DIRS: false,
  TED_ELECTRON_ARGS:
    'Switches TED gives an Electron App to pass to Electron: its debugging port, and when sandboxed --no-sandbox.',
  TED_ELECTRON_BIN: false,
  TED_ELECTRON_HIDDEN:
    'Tells an Electron App a Run started it, so it opens no visible window, tray icon or notification.',
  TED_EXECUTION_CRASH_AT: false,
  TED_EXECUTION_HOME:
    'Isolated execution-worker storage, separate from independent TED homes and credentials.',
  TED_EXIT_WITH_PID: false,
  TED_FACTORY: 'Factory context supplied to Planning and Automation Runs.',
  TED_FIX_LOG: false,
  TED_FREE_BYTES_FILE: false,
  TED_GH_BIN: false,
  TED_HIDDEN_WINDOW: false,
  TED_HOME: 'Shared home for the app, daemon, hosts and CLI; also a supported home override.',
  TED_IDLE_EXIT_MS: false,
  TED_INHERITED_FDS: 'Linux app-to-daemon descriptor cleanup with descriptor identity checks.',
  TED_KEYRING_MODULE: false,
  TED_LINEAR_API: false,
  TED_ASANA_API: false,
  TED_ASANA_CALLBACK_PORT: false,
  TED_LOGIN_ITEM_LOG: false,
  TED_LOGIN_ITEM_STATUS: false,
  TED_LOGIN_SHELL: false,
  TED_LOAD_FILE: false,
  TED_MEMORY_FILE: false,
  TED_LAB_RUN: false,
  TED_LOW_PRIORITY: false,
  TED_NOTIFY_LOG: false,
  TED_NOTIFY_STATUS: false,
  TED_NUDGE_AFTER_MS: false,
  TED_ONLINE_FILE: false,
  TED_OPEN_BIN: false,
  TED_EMULATOR_BIN: false,
  TED_ADB_BIN: false,
  TED_AVDMANAGER_BIN: false,
  TED_PLAN: 'Planning Run context for CLI requests.',
  TED_REMOTE_EXECUTION: false,
  TED_RESTART_DELAYS_MS: false,
  TED_RUN: 'Run context for CLI requests and steering boundaries.',
  TED_RUN_CAPABILITY:
    'Run authentication, or an invocation-bound reporting-only credential for Check commands.',
  TED_RUN_TOKEN: 'Legacy Run capability name retained for older running hosts.',
  TED_SANDBOX:
    'Marks commands run in TED’s OS sandbox, so the development app and its tests skip Electron there and the tests use a pass-through sandbox and their own cache folder.',
  TED_SANDBOX_BIN: false,
  TED_SANDBOX_ELECTRON:
    'Marks an Electron App run in TED’s OS sandbox with the exception Electron needs, so the development app starts there.',
  TED_SIMULATOR_UDID: 'Task simulator context supplied to App and Run commands.',
  TED_EMULATOR_SERIAL: 'Task Android emulator context supplied to App commands.',
  TED_SKIP_FIRST_LAUNCH: false,
  TED_STALL_AFTER_MS: false,
  TED_HOLD_REQUESTS_MS: false,
  TED_STAY_AWAKE: false,
  TED_SWIFTPM_CACHE:
    'Task Swift package cache folder supplied to Apps, Checks and worktree commands.',
  TED_TASK: 'Task context for Run commands and worktree commands.',
  TED_TEST_FILE: false,
  TED_TEST_RUN: false,
  TED_TIME_MACHINE: false,
  TED_UNATTENDED_EXIT_MS: false,
  TED_UPDATE_FEED: false,
  TED_UPDATE_LOG: false,
  TED_XCRUN_BIN: false,
  TED_IDB_BIN: false,
}

export function tedEnv(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  which: Edition = edition,
): string | undefined {
  return which === 'dev' || retained(name) ? env[name] : undefined
}

export function filterTedEnv(env: NodeJS.ProcessEnv, which: Edition = edition): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name]) => which === 'dev' || !name.toUpperCase().startsWith('TED_') || retained(name),
    ),
  )
}

export function outsideTedEnv(name: string, env: NodeJS.ProcessEnv): string | undefined {
  return name.toUpperCase().startsWith('TED_') ? undefined : env[name]
}

function retained(name: string): boolean {
  return (
    (Object.hasOwn(tedEnvironment, name) && typeof tedEnvironment[name] === 'string') ||
    /^TED_APP_[A-Z0-9_]+_(PORT|URL)$/.test(name)
  )
}

export const remoteExecutionOff = 'Remote execution is turned off in this version of TED.'

export function remoteExecutionOn(
  env: NodeJS.ProcessEnv = process.env,
  which: Edition = edition,
): boolean {
  return tedEnv('TED_REMOTE_EXECUTION', env, which) === 'on'
}
