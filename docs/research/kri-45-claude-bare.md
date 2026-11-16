# KRI-45: Claude Code bare mode and subscription compatibility

Checked **2026-11-10**. Installed CLI: **2.1.322 (Claude Code)**, confirmed with `claude --version`.

**Finding:** current Anthropic documentation still describes bare mode as a future default for `-p`. No announcement of that switch was found in the official changelog through 2.1.322. This supports retaining Ted’s current non-bare launch; it does **not** constitute a live subscription smoke test.

## Documented facts

- `-p` / `--print` selects non-interactive output. `--bare` is a separate option in the [CLI reference](https://code.claude.com/docs/en/cli-reference) (rolling documentation, read on the date above).
- The [programmatic-use guide, bare-mode section](https://code.claude.com/docs/en/headless#start-faster-with-bare-mode) says ordinary `claude -p` loads customizations as interactive sessions do; bare mode skips discovery. It explicitly says bare mode does not use subscription login or read OAuth credentials/keychain. For Anthropic authentication it requires `ANTHROPIC_API_KEY` or `apiKeyHelper` supplied through `--settings`. It says bare mode will become the `-p` default in a future release, without naming a version. Hooks remain disabled even when explicitly supplied in settings.
- The [environment-variable reference](https://code.claude.com/docs/en/env-vars) documents `CLAUDE_CODE_SIMPLE=1` as equivalent to `--bare`, including exclusion of OAuth and keychain credentials. Omitting the flag alone therefore does not exclude bare mode. `CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT` is a different variable; its shorter prompt retains normal tools, hooks and discovery.
- The [authentication reference](https://code.claude.com/docs/en/authentication#authentication-precedence) documents subscription OAuth from `/login` as the normal subscription credential. Higher-priority credentials can supersede it; in `-p`, an available `ANTHROPIC_API_KEY` is always used. Its separate [token section](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token) says bare mode also ignores `CLAUDE_CODE_OAUTH_TOKEN`. These are authentication facts, not a broader terms assessment.

## Version context from Anthropic’s changelog

| Release | Relevant evidence |
| --- | --- |
| [2.1.81](https://github.com/anthropics/claude-code/releases/tag/v2.1.81) | Introduced `--bare` for scripted `-p` calls, explicitly excluding OAuth/keychain authentication. |
| [2.1.286](https://github.com/anthropics/claude-code/releases/tag/v2.1.286) | Tightened bare mode: command-line MCP servers only, no system reminders or background tasks. |
| [2.1.288](https://github.com/anthropics/claude-code/releases/tag/v2.1.288) | Fixed `/login` starting a sign-in that bare mode would never read and potentially overwriting saved login. |
| [2.1.322](https://github.com/anthropics/claude-code/releases/tag/v2.1.322) | November 10 release note concerns Vertex fast mode; no bare-default switch announced. |

The [version-tagged changelog](https://raw.githubusercontent.com/anthropics/claude-code/v2.1.322/CHANGELOG.md) and [rolling main changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) were checked for bare/default changes. Changelog silence alone cannot prove runtime behavior. Rolling docs can change independently of the installed binary.

## Local verification and Ted implications

Only `claude --version` and `claude --help` were executed. Installed help lists `--bare` separately, identifies `CLAUDE_CODE_SIMPLE=1`, and describes Anthropic auth as `ANTHROPIC_API_KEY` or `apiKeyHelper` via `--settings`, excluding OAuth/keychain. No prompt was sent, credentials inspected, login changed, or billed inference run. Help text establishes the advertised interface, not successful subscription authentication.

Static inspection of [the Claude launcher](../../packages/daemon/src/agents/claude.ts) shows `-p` with streaming input/output and no `--bare`. The launcher also installs hooks, which bare mode would disable. [ADR 0004](../adr/0004-drive-official-agent-clis-under-the-users-login.md) and [spec 7.11](../spec/ted-v1-spec.md) require preserving subscription login and opting out if bare becomes the default.

**Inference:** no evidence currently requires a launcher flag change because of a new default. Neither the inspected docs nor installed help exposes a documented `--no-bare`; do not invent an opt-out or assume `CLAUDE_CODE_SIMPLE=0` will override a future default.

**Configuration caveat:** `claudeEnvironment` uses [the credential filter](../../packages/daemon/src/agents/agent.ts), which preserves an ordinary inherited `CLAUDE_CODE_SIMPLE=1`. That can activate bare mode today independently of a default change. Settings can also supply environment values, so omitting the flag alone is not proof of compatibility. This research did not inspect the machine’s environment/settings; changing how Ted handles user configuration is outside this update-time documentation change.

## Repeatable update-time checklist

1. Record date, candidate `claude --version`, and `claude --help`; inspect help without supplying a prompt. Keep evidence free of credentials.
2. Read Anthropic’s release notes from the last checked version through the candidate, searching for `bare`, `print`, `-p`, `SIMPLE`, OAuth, keychain, and authentication. Save version-specific URLs; re-read the linked CLI, headless, environment and authentication docs.
3. Check Ted’s actual launch arguments, subscription environment construction and hook requirements. Ensure neither the flag nor its environment equivalent activates bare mode. Preserve vendor-managed login; do not copy tokens or add API keys as a workaround.
4. If bare becomes implicit, establish the officially supported opt-out and its version boundary before changing the launcher. If none is documented, treat subscription compatibility as unresolved rather than guessing a flag.
5. Verify any launcher change with a targeted stub test of arguments/environment; a stub cannot establish upstream authentication behavior. For a live release check, use an isolated Ted Dev home in this worktree (`node_modules/.cache/ted-home`) and a disposable Factory with Subscription billing. Start a minimal Claude Task using the candidate binary, confirm Ted reports Subscription and the Run can complete a turn, then resume it and check that turn too. Check that Ted receives the expected hook events and permission requests. Record the CLI version, non-secret auth classification and outcomes; never record credentials. A sign-in check alone is insufficient because it does not exercise `-p`. This live check is **not run** for this documentation change.

No runtime changes or broader terms review were needed for this finding.
