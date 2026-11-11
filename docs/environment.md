# TED environment inputs

Runtime reads of `TED_*` inputs use `tedEnv` in `packages/protocol/src/env.ts`. That module’s `tedEnvironment` inventory marks test-only inputs with `false`, and retained release inputs with the reason they are needed. The compiled `edition` decides which policy applies; an environment variable cannot select the edition.

TED Dev accepts every hook, including unknown names. Release accepts only explicitly retained inputs and the generated `TED_APP_<NAME>_PORT`/`URL` context. Unknown names default to ignored. `filterTedEnv` applies the same policy to captured login-shell environments and environments forwarded to TED processes, preserving ordinary variables such as `PATH`. The source guard in `packages/protocol/test/env.test.ts` checks for direct environment reads outside the policy, including computed reads.

## Release inputs

The authoritative reasons for individual inputs are beside their entries in `tedEnvironment`. They cover the shared home, Task/Run/Planning/Automation/Factory context, Run capability authentication (including the older token name), the installed app executable, simulator context, and Linux inherited-descriptor cleanup. Generated App port and URL names carry each Task’s actual running App addresses to its commands; they are process context, rather than overrides of TED’s services.

`TED_HOME` remains a supported home override. `TED_APP_EXECUTABLE` remains the path the installed CLI uses to open the app. These inputs are intentionally retained, so this policy does not make all launch-time environment inputs trusted. Existing capability checks and descriptor identity checks still apply.

## Dev-only inputs

| Inputs | Purpose in development and tests |
| --- | --- |
| `TED_REAL_ANTIGRAVITY_BIN` | Optional native CLI for the offline tool-free compatibility test. The test uses a local model fixture, never a Google key. |
| `TED_CLAUDE_BIN`, `TED_CODEX_BIN`, `TED_ANTIGRAVITY_BIN`, `TED_GH_BIN` | Select agent and GitHub stubs or alternate development binaries. Release discovers the normal commands on the daemon’s login-shell `PATH`. |
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
| `TED_DEMO`, `TED_DEMO_STARTED`, `TED_STUB_GH`, `TED_STUB_XCRUN` | Prepare the isolated Dev demo and select its local fixture state; ignored in release. |

Internal output names such as `TED_COMMAND_SCRIPT` (a generated script marker) and `__TED_LOGIN_ENV__` (a shell-output delimiter) are not environment inputs. Test fixtures can have their own `TED_STUB_*` inputs outside runtime `packages/*/src`.

The regression tests exercise both editions, including starting a release-edition daemon with a keyring module that writes an import marker and throws. The release starts without executing it; the Dev control executes it. No test accesses OS credentials or a real integration service.
