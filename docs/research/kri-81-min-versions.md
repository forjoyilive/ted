# Minimum supported versions of `claude`, `codex` and `gh` (KRI-81)

Answers gap NEW-5. For each CLI, the table lists every feature KRI-81 names, the first version that has it, and the source. A CLI’s minimum is the highest version in its table.

| CLI | Minimum | Feature that sets the floor |
|---|---|---|
| `claude` | **2.1.111** | `--permission-mode auto` without the hidden `--enable-auto-mode` flag |
| `codex` | **0.128.0** | `codex update` |
| `gh` | **2.81.0** | `gh auth status --json hosts` |

Researched 2026-11-08 against the installed `claude` 2.1.319, `codex` 0.160.0 and `gh` 2.89.0. Each of those has every feature below; I checked flags and subcommands with `--help`.

## How I checked

- **Claude Code:** the [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) first. When it doesn’t record a feature’s arrival, I downloaded the published npm packages (`npm pack @anthropic-ai/claude-code@<version>`) and searched each `cli.js` for the feature’s string, to find the first version that has it.
- **Codex:** the [GitHub releases](https://github.com/openai/codex/releases) (`rust-v*` tags, stable only). For app-server details that the notes don’t mention, I read `codex-rs/app-server-protocol/src` at each release tag in a clone of openai/codex.
- **gh:** the [GitHub releases](https://github.com/cli/cli/releases). For the one feature older than the release notes, I read the source at the oldest tag.

“First version” means the first stable published version. Some numbers were never published, so a feature that first appears in, say, 0.63.0 may have been merged in an unpublished 0.62.

## `claude`

| Feature | First version | Source |
|---|---|---|
| `--output-format stream-json` | 0.2.66 | CHANGELOG 0.2.66: “Print mode (-p) now supports streaming output via --output-format=stream-json” |
| `--resume` | 0.2.93 | CHANGELOG 0.2.93: “Resume conversations … with "claude --continue" and "claude --resume"” |
| `--mcp-config` | 0.2.75 | CHANGELOG 0.2.75: “Run one-off MCP servers with `claude --mcp-config <path-to-file>`” |
| `--settings` | 1.0.61 | CHANGELOG 1.0.61: “Added `--settings` flag to load settings from a JSON file” |
| `total_cost_usd` | 1.0.22 | CHANGELOG 1.0.22: “SDK: Renamed `total_cost` to `total_cost_usd`” |
| Hooks | 1.0.38 | CHANGELOG 1.0.38: “Released hooks”. The spec doesn’t name the hook events TED uses for working, idle and waiting, so the next two rows cover the likely ones. |
| `UserPromptSubmit` hook | 1.0.54 | CHANGELOG 1.0.54: “Added UserPromptSubmit hook” |
| `Notification` hook matchers (to tell idle from waiting on a permission prompt) | 2.0.37 | CHANGELOG 2.0.37: “Added matcher values for Notification hook events” |
| `claude update` | 2.0.67 or earlier (not pinned) | Oldest CHANGELOG mention is a 2.0.67 fix to `claude update`, so the command is older. Far below the floor, so I didn’t look further. |
| `claude auth status` with `authMethod` | 2.1.41 | CHANGELOG 2.1.41: “Added `claude auth login`, `claude auth status`, and `claude auth logout`”. The CHANGELOG doesn’t name `authMethod`, but the 2.1.41 npm `cli.js` already builds `{loggedIn, authMethod, apiProvider}` for `auth status`. |
| `rate_limit_event` with `resetsAt` | 2.1.45 | CHANGELOG 2.1.45: “Added `SDKRateLimitInfo` and `SDKRateLimitEvent` types … including utilization, reset times”. The `"rate_limit_event"` string is missing from the 2.1.41 npm package and present in 2.1.45. |
| `system/api_retry` | 2.1.77 (not in CHANGELOG) | The CHANGELOG doesn’t mention it. In npm `cli.js`, 2.1.76 has no `"api_retry"`. 2.1.77 has the message schema `{type:"system", subtype:"api_retry", attempt, max_retries, retry_delay_ms, error_status, error}`. |
| `rate_limits` (5-hour and weekly, with `resets_at`) | 2.1.80 | CHANGELOG 2.1.80: “Added `rate_limits` field to statusline scripts … (5-hour and 7-day windows with `used_percentage` and `resets_at`)”. The string is missing from the 2.1.69 npm package and present in 2.1.80. |
| `--permission-mode auto` | **2.1.111** | CHANGELOG 2.1.111: “Auto mode no longer requires `--enable-auto-mode`” and “Auto mode is now available for Max subscribers when using Opus 4.7”. The CHANGELOG has no entry for auto mode’s first release. In npm `cli.js`, `"auto"` first appears in the permission-mode list in 2.1.71, together with the hidden `--enable-auto-mode` flag (both absent in 2.1.70). |

**Floor: 2.1.111.** Before 2.1.111, `--permission-mode auto` only worked together with the hidden `--enable-auto-mode` opt-in flag. That flag never appeared in `--help` or the CHANGELOG, and TED shouldn’t depend on an undocumented flag. If TED did pass it, the floor would drop to 2.1.80, the next-highest feature (`rate_limits`).

## `codex`

| Feature | First version | Source |
|---|---|---|
| `codex login` | 0.2.0 or earlier (not pinned) | `Login(LoginCommand)` is a subcommand in `codex-rs/cli/src/main.rs` at [rust-v0.2.0](https://github.com/openai/codex/blob/rust-v0.2.0/codex-rs/cli/src/main.rs), the oldest Rust release |
| `-c key=value` | 0.2.0 or earlier (not pinned) | [`codex-rs/common/src/config_override.rs`](https://github.com/openai/codex/blob/rust-v0.2.0/codex-rs/common/src/config_override.rs) at rust-v0.2.0: “Support for `-c key=value` overrides” |
| `-s workspace-write` | 0.3.0 | `WorkspaceWrite` first appears in [`sandbox_mode_cli_arg.rs`](https://github.com/openai/codex/blob/rust-v0.3.0/codex-rs/common/src/sandbox_mode_cli_arg.rs) at rust-v0.3.0 |
| `-a on-request` | 0.15.0 | [rust-v0.15.0 release](https://github.com/openai/codex/releases/tag/rust-v0.15.0): “new `--ask-for-approval on-request` option” |
| `codex app-server` | 0.44.0 | [rust-v0.44.0 release](https://github.com/openai/codex/releases/tag/rust-v0.44.0): “#4471 fix: separate `codex mcp` into `codex mcp-server` and `codex app-server`” |
| `account/rateLimits/read` | 0.48.0 | Not in 0.47.0. Registered in [`app-server-protocol/src/protocol.rs`](https://github.com/openai/codex/blob/rust-v0.48.0/codex-rs/app-server-protocol/src/protocol.rs) at rust-v0.48.0. The release notes only mention the related `account/rateLimits/updated` notification and “new account method API stubs”. |
| `account/read` | 0.48.0, with `planType` from 0.56.0 | Registered at rust-v0.48.0 (same file). At [rust-v0.56.0](https://github.com/openai/codex/blob/rust-v0.56.0/codex-rs/app-server-protocol/src/protocol/v2.rs), the v2 `Account` type is `apiKey` or `chatgpt { email, planType }`. |
| `authMode` | 0.56.0 | `auth_mode: Option<AuthMode>` first appears in v2.rs at rust-v0.56.0. Note: `account/read` doesn’t return a field named `authMode`. It returns the account’s `type` (`apiKey`, `chatgpt`, and from later versions `amazonBedrock`). `authMode` is on the `account/updated` notification. |
| `thread/resume` | 0.56.0 | Not in 0.55.0. Registered in [`protocol/common.rs`](https://github.com/openai/codex/blob/rust-v0.56.0/codex-rs/app-server-protocol/src/protocol/common.rs) at rust-v0.56.0. Release 0.58.0 extended it (“thread/resume supports history, path, and overrides”). |
| `resetsAt` (rate-limit windows) | 0.56.0 | `resets_at` on the v2 rate-limit window first appears at rust-v0.56.0 |
| `usageLimitExceeded` | 0.63.0 | Not in 0.61.0 (0.62 was never published as a stable release). In `CodexErrorInfo` in [v2.rs at rust-v0.63.0](https://github.com/openai/codex/blob/rust-v0.63.0/codex-rs/app-server-protocol/src/protocol/v2.rs). |
| `willRetry` | 0.66.0 | Not in 0.65.0. `will_retry` on `ErrorNotification` in [v2.rs at rust-v0.66.0](https://github.com/openai/codex/blob/rust-v0.66.0/codex-rs/app-server-protocol/src/protocol/v2.rs) |
| `codex update` | **0.128.0** | [rust-v0.128.0 release](https://github.com/openai/codex/releases/tag/rust-v0.128.0): “#19933 Add `codex update` command”. `Subcommand::Update` is missing from `codex-rs/cli/src/main.rs` at rust-v0.125.0, the previous stable release. |

**Floor: 0.128.0.** Every app-server feature TED needs was already there by 0.66.0. `codex update` is what raises the floor. If TED used the brew or npm command for older Codex versions (as it already does when a CLI can’t update itself), the floor could drop to 0.66.0.

Two notes for whoever builds the Codex adapter:

- **`usageLimitExceeded` has no `resetsAt`**, not in 0.128.0 and not in the latest 0.167.0 (it is a bare `CodexErrorInfo` variant). The reset time comes from the rate-limit windows’ `resetsAt` (`account/rateLimits/read`, or the `account/rateLimits/updated` notification). §7.5’s “usageLimitExceeded with resetsAt” should be read that way.
- **Codex hooks** (§7.3) aren’t in KRI-81’s list. Codex added an experimental hooks engine with `SessionStart` and `Stop` in [rust-v0.114.0](https://github.com/openai/codex/releases/tag/rust-v0.114.0), below the floor, so they don’t change it.

## `gh`

| Feature | First version | Source |
|---|---|---|
| `gh pr create --draft` | 0.5.0 or earlier (not pinned) | `BoolP("draft", "d", …)` in [`command/pr_create.go`](https://github.com/cli/cli/blob/v0.5.0/command/pr_create.go) at v0.5.0, the oldest release on GitHub |
| `gh pr ready` | 0.9.0 | [v0.9.0 release](https://github.com/cli/cli/releases/tag/v0.9.0): “mark a draft pull request as ready for review with `gh pr ready`” |
| `gh api graphql` | 0.10.0 | [v0.10.0 release](https://github.com/cli/cli/releases/tag/v0.10.0): “`gh` now provides direct access to both the GitHub GraphQL and REST APIs”, with a `gh api graphql` example |
| `gh pr merge --auto` | 1.6.0 | [v1.6.0 release](https://github.com/cli/cli/releases/tag/v1.6.0): “`pr merge` now supports `--auto`” |
| `gh auth status --json hosts` | **2.81.0** | [v2.81.0 release](https://github.com/cli/cli/releases/tag/v2.81.0): “This release adds support for the `--json` flag in `gh auth status`” (PR #11544) |

**Floor: 2.81.0.** The spec said `--json` arrived “some time after 2.49”. It arrived in 2.81.0, released 2025-10-01.
