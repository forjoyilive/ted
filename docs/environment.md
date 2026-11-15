# TED environment inputs

Runtime reads of `TED_*` inputs use `tedEnv` in `packages/protocol/src/env.ts`. That module’s `tedEnvironment` inventory marks test-only inputs with `false`, and retained release inputs with the reason they are needed. The compiled `edition` decides which policy applies; an environment variable cannot select the edition.

TED Dev accepts every hook, including unknown names. Release accepts only explicitly retained inputs and the generated `TED_APP_<NAME>_PORT`/`URL` context. Unknown names default to ignored. `filterTedEnv` applies the same policy to captured login-shell environments and environments forwarded to TED processes, preserving ordinary variables such as `PATH`. The source guard in `packages/protocol/test/env.test.ts` checks for direct environment reads outside the policy, including computed reads.

## Release inputs

The authoritative reasons for individual inputs are beside their entries in `tedEnvironment`. They cover the shared home, Task/Run/Planning/Automation/Factory context, Run capability authentication (including the older token name), the installed app executable, simulator context, the `TED_SANDBOX` marker on commands run in TED’s OS sandbox and `TED_SANDBOX_ELECTRON` on an Electron App run there, the switches and hidden-window marker TED gives an Electron App (`TED_ELECTRON_ARGS`, `TED_ELECTRON_HIDDEN`), the profile folder the daemon gives an Automation Run’s headless browser (`TED_BROWSER_PROFILE`), and Linux inherited-descriptor cleanup. Generated App port and URL names carry each Task’s actual running App addresses to its commands; they are process context, rather than overrides of TED’s services.

`TED_HOME` remains a supported home override. `TED_APP_EXECUTABLE` remains the path the installed CLI uses to open the app. These inputs are intentionally retained, so this policy does not make all launch-time environment inputs trusted. Existing capability checks and descriptor identity checks still apply.

## Dev-only inputs

| Inputs | Purpose in development and tests |
| --- | --- |
| `TED_REAL_ANTIGRAVITY_BIN` | Optional native CLI for the offline tool-free compatibility test. The test uses a local model fixture, never a Google key. |
| `TED_CLAUDE_BIN`, `TED_CODEX_BIN`, `TED_ANTIGRAVITY_BIN`, `TED_GH_BIN` | Select agent and GitHub stubs or alternate development binaries. Release discovers the normal commands on the daemon’s login-shell `PATH`. |
| `TED_XCRUN_BIN`, `TED_IDB_BIN`, `TED_OPEN_BIN`, `TED_SANDBOX_BIN` | Substitute simulator, simulator input, launcher and sandbox programs. Release finds `idb` through the login-shell `PATH`. |
| `TED_EMULATOR_BIN`, `TED_ADB_BIN`, `TED_AVDMANAGER_BIN` | Substitute the Android SDK’s `emulator`, `adb` and `avdmanager`. Release finds them in the SDK named by `ANDROID_HOME` or `ANDROID_SDK_ROOT`, or the standard SDK folder. |
| `TED_KEYRING_MODULE` | Import a keyring implementation for tests. |
| `TED_ASANA_API`, `TED_ASANA_CALLBACK_PORT` | Redirect Asana token/API requests to a loopback stub and isolate its temporary callback port. Ignored in release. |
| `TED_LINEAR_API` | Redirect Linear requests to a stub. |
| `TED_UPDATE_FEED`, `TED_UPDATE_LOG` | Use a loopback update server and record update installation. |
| `TED_APP_TOKEN` | Supply a known app key in tests. Release generates its app key in memory and passes it to the daemon on stdin. |
| `TED_HIDDEN_WINDOW`, `TED_SKIP_FIRST_LAUNCH` | Hide the test app and bypass first-launch setup. |
| `TED_EXIT_WITH_PID`, `TED_TEST_RUN`, `TED_TEST_FILE` | Track and clean up test processes. |
| `TED_STALL_AFTER_MS`, `TED_NUDGE_AFTER_MS`, `TED_IDLE_EXIT_MS`, `TED_UNATTENDED_EXIT_MS`, `TED_RESTART_DELAYS_MS`, `TED_HOLD_REQUESTS_MS` | Shorten timing for tests. |
| `TED_FREE_BYTES_FILE`, `TED_ONLINE_FILE` | Simulate disk space and connectivity. |
| `TED_FIX_LOG` | Record terminal fix commands instead of opening a terminal. |
| `TED_LOGIN_ITEM_LOG`, `TED_LOGIN_ITEM_STATUS` | Simulate login items. |
| `TED_NOTIFY_LOG`, `TED_NOTIFY_STATUS` | Record or disable notifications and badges. |
| `TED_LOGIN_SHELL`, `TED_STAY_AWAKE`, `TED_TIME_MACHINE` | Disable login-shell loading, sleep prevention or backup exclusions during tests. |
| `TED_EDITOR_APP_DIRS` | Substitute the folders searched for editor bundles. |
| `TED_ELECTRON_BIN` | The Electron executable a daemon running on plain Node starts as an Automation Run’s headless browser. Under Electron the daemon uses its own executable. |
| `TED_DEMO`, `TED_DEMO_STARTED`, `TED_STUB_GH`, `TED_STUB_XCRUN`, `TED_STUB_ANDROID` | Prepare the isolated Dev demo and select its local fixture state; ignored in release. |

Inside TED’s sandbox, `TED_SANDBOX=1` also changes this repo’s test tooling (ADR 0147): `vitest.config.ts` points `TED_SANDBOX_BIN` at `packages/daemon/test/fixtures/pass-through-sandbox.sh`, because a second sandbox can’t start inside the first, and on macOS prints `TED_SANDBOX_SKIPPED: the Electron app tests`, which a Scheduled Check shows in its result; `testCacheDir` in `packages/daemon/test/support/suite-lock.ts` keeps test locks, slots and the failure log in `$XDG_CACHE_HOME/ted`, which the sandbox points at the command’s own cache folder. A test the sandbox stops (one that needs a second sandbox, writes files TED refuses inside a TED home, or starts or inspects processes) calls `skipInsideTedSandbox` from `packages/daemon/test/support/ted-sandbox.ts` with the matching entry of `sandboxReasons`; it prints one `TED_SANDBOX_SKIPPED:` line per reason, and a Scheduled Check’s result shows at most five, so add a new reason only for a new kind of refusal.

Internal output names such as `TED_COMMAND_SCRIPT` (a generated script marker) and `__TED_LOGIN_ENV__` (a shell-output delimiter) are not environment inputs. Test fixtures can have their own `TED_STUB_*` inputs outside runtime `packages/*/src`.

The regression tests exercise both editions, including starting a release-edition daemon with a keyring module that writes an import marker and throws. The release starts without executing it; the Dev control executes it. No test accesses OS credentials or a real integration service.

## Codex storage and sign-in

New Codex sessions use `TED_HOME/codex` for `CODEX_HOME` and `CODEX_SQLITE_HOME`. TED also overrides Codex’s `sqlite_home` for those launches, so an inherited database location does not put their history back in the personal Codex index. TED Dev and release use their own homes. The daemon’s agent health and subscription-usage checks use the same Codex home as new sessions.

Use **Sign in** under App Settings → Agents to sign in with the existing paid ChatGPT account. This is another local login, not a new account or subscription, and does not require API billing. TED does not copy personal credentials or global Codex configuration, skills or plugins into this folder. Repository instructions and configuration still follow Codex’s normal discovery rules.

Each new Run records its storage choice in `runs/<id>/codex-home`. Before its first turn, the Codex driver also records the thread ID under `codex/ted-sessions/`, so another Run resuming that session finds the same home. These files contain no credentials. Runs and sessions without these records keep using their original configured or default Codex home; their existing conversations are not moved or cleaned up. An already running host keeps its environment until its normal replacement.

This separates local session storage from personal history. ChatGPT’s discovery behavior is external to TED and must be checked with the installed ChatGPT version; local storage tests alone do not establish what appears in Recents.

## Execution worker storage

Remote execution is shelved. `TED_REMOTE_EXECUTION=on` turns it back on in TED Dev: Settings → Machines, the worker window, `ted execution …`, the daemon’s execution listener and its pairing routes. Release ignores it, so a release build never offers remote execution. Without it the daemon opens no execution port, even with a saved endpoint, and keeps any saved pairing unused. Tests set it in `vitest.config.ts`; read it only through `remoteExecutionOn` in `packages/protocol/src/env.ts`.

`TED_EXECUTION_HOME` is a retained override for the isolated worker’s home. By default,
TED derives an adjacent execution home from its edition and optional `TED_HOME`:
`~/.ted-dev-execution` for TED Dev, `~/.ted-execution` for release, or
`<TED_HOME>-execution` for an explicit independent home. It never reuses that
installation’s `daemon.json`, keys, Factories or Run credentials. The worker receives
an explicit allowlist of basic runtime/tool-discovery inputs, its execution-home
path and process-cleanup markers; it does not inherit agent API keys, SSH agents or
TED’s app/file/Run credentials. `TED_LAB_RUN` is a Dev-only owned-lab cleanup marker.
`TED_EXECUTION_CRASH_AT` is test-only: it names one point in the command channel
where the controller or the worker kills itself, for crash tests. Release ignores it.
`SHELL` is retained to discover the user’s login-shell tool paths. The discovered
environment is filtered through the same worker allowlist before use, including
for local agent-version probes.
