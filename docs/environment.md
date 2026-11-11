# TED environment inputs

Runtime reads of `TED_*` inputs use `tedEnv` in `packages/protocol/src/env.ts`. That module’s `tedEnvironment` inventory marks test-only inputs with `false`, and retained release inputs with the reason they are needed. The compiled `edition` decides which policy applies; an environment variable cannot select the edition.

TED Dev accepts every hook, including unknown names. Release accepts only explicitly retained inputs and the generated `TED_APP_<NAME>_PORT`/`URL` context. Unknown names default to ignored. `filterTedEnv` applies the same policy to captured login-shell environments and environments forwarded to TED processes, preserving ordinary variables such as `PATH`. The source guard in `packages/protocol/test/env.test.ts` checks for direct environment reads outside the policy, including computed reads.

## Release inputs

The authoritative reasons for individual inputs are beside their entries in `tedEnvironment`. They cover the shared home, Task/Run/Planning/Automation/Factory context, Run capability authentication (including the older token name), the installed app executable, simulator context, and Linux inherited-descriptor cleanup. Generated App port and URL names carry each Task’s actual running App addresses to its commands; they are process context, rather than overrides of TED’s services.

`TED_HOME` remains a supported home override. `TED_APP_EXECUTABLE` remains the path the installed CLI uses to open the app. These inputs are intentionally retained, so this policy does not make all launch-time environment inputs trusted. Existing capability checks and descriptor identity checks still apply.

## Dev-only inputs

| Inputs | Purpose in development and tests |
| --- | --- |
| `TED_CLAUDE_BIN`, `TED_CODEX_BIN`, `TED_GH_BIN` | Select agent and GitHub stubs or alternate development binaries. Release discovers the normal commands on the daemon’s login-shell `PATH`. |
| `TED_XCRUN_BIN`, `TED_OPEN_BIN`, `TED_SANDBOX_BIN` | Substitute simulator, launcher and sandbox programs. |
| `TED_KEYRING_MODULE` | Import a keyring implementation for tests. |
| `TED_LINEAR_API` | Redirect Linear requests to a stub. |
| `TED_UPDATE_FEED`, `TED_UPDATE_LOG` | Use a loopback update server and record update installation. |
| `TED_APP_TOKEN` | Supply a known app key in tests. Release generates its app key in memory and passes it to the daemon on stdin. |
| `TED_HIDDEN_WINDOW`, `TED_SKIP_FIRST_LAUNCH` | Hide the test app and bypass first-launch setup. |
| `TED_EXIT_WITH_PID`, `TED_TEST_RUN`, `TED_TEST_FILE` | Track and clean up test processes. |
| `TED_STALL_AFTER_MS`, `TED_NUDGE_AFTER_MS`, `TED_IDLE_EXIT_MS`, `TED_RESTART_DELAYS_MS` | Shorten timing for tests. |
| `TED_FREE_BYTES_FILE`, `TED_ONLINE_FILE` | Simulate disk space and connectivity. |
| `TED_FIX_LOG` | Record terminal fix commands instead of opening a terminal. |
| `TED_LOGIN_ITEM_LOG`, `TED_LOGIN_ITEM_STATUS` | Simulate login items. |
| `TED_NOTIFY_LOG`, `TED_NOTIFY_STATUS` | Record or disable notifications and badges. |
| `TED_LOGIN_SHELL`, `TED_STAY_AWAKE`, `TED_TIME_MACHINE` | Disable login-shell loading, sleep prevention or backup exclusions during tests. |
| `TED_EDITOR_APP_DIRS` | Substitute the folders searched for editor bundles. |

Internal output names such as `TED_COMMAND_SCRIPT` (a generated script marker) and `__TED_LOGIN_ENV__` (a shell-output delimiter) are not environment inputs. Test fixtures can have their own `TED_STUB_*` inputs outside runtime `packages/*/src`.

The regression tests exercise both editions, including starting a release-edition daemon with a keyring module that writes an import marker and throws. The release starts without executing it; the Dev control executes it. No test accesses OS credentials or a real integration service.

## Codex storage and sign-in

New Codex sessions use `TED_HOME/codex` for `CODEX_HOME` and `CODEX_SQLITE_HOME`. TED also overrides Codex’s `sqlite_home` for those launches, so an inherited database location does not put their history back in the personal Codex index. TED Dev and release use their own homes. The daemon’s agent health and subscription-usage checks use the same Codex home as new sessions.

Use **Sign in** under App Settings → Agents to sign in with the existing paid ChatGPT account. This is another local login, not a new account or subscription, and does not require API billing. TED does not copy personal credentials or global Codex configuration, skills or plugins into this folder. Repository instructions and configuration still follow Codex’s normal discovery rules.

Each new Run records its storage choice in `runs/<id>/codex-home`. Before its first turn, the Codex driver also records the thread ID under `codex/ted-sessions/`, so another Run resuming that session finds the same home. These files contain no credentials. Runs and sessions without these records keep using their original configured or default Codex home; their existing conversations are not moved or cleaned up. An already running host keeps its environment until its normal replacement.

This separates local session storage from personal history. ChatGPT’s discovery behavior is external to TED and must be checked with the installed ChatGPT version; local storage tests alone do not establish what appears in Recents.
