# Codex runs as `codex app-server`, driven from the host by a driver in `agents/`

Codex is the second agent kind behind the interface in ADR 0014. Its Runs start the user’s installed `codex` binary as:

```
codex app-server -c sandbox_mode="workspace-write" -c approval_policy="on-request"
  -c sandbox_workspace_write.network_access=true
  -c shell_environment_policy.inherit="all"
  -c shell_environment_policy.ignore_default_excludes=true
  -c shell_environment_policy.exclude=["CODEX_API_KEY","OPENAI_API_KEY"]
```

- **A driver in the host.** `app-server` speaks JSON-RPC over stdio, and the thread ID only arrives in a response, so a single first input line isn’t enough. An agent module may name a driver file in `agents/`; the Run manager writes its path to the new optional `driver` field of `launch.json` (ADR 0013), and the host imports it and passes it each stdout line. `agents/codex-driver.ts` sends `initialize`, `initialized`, `thread/start` (or `thread/resume`) and `turn/start` with the prompt, and answers every request Codex sends. The host still logs every stdout line unchanged, and still interprets nothing itself.
- **Approval requests are declined at once** (`decline` for commands and file changes, an error for anything Ted doesn’t know) until spec 7.8 routes them to Ted. This matches `claude -p`, which denies a prompt when nothing answers it. Without an answer the Run would wait forever.
- **State comes from app-server events**, not hooks: `turn/started` and `thread/status/changed` to `active` mean working; `active` with `waitingOnApproval` or `waitingOnUserInput`, or a request from Codex, means waiting; `turn/completed` and status `idle` mean idle. Finished still comes from the host’s `exit` record.
- **The session ID is Codex’s thread ID.** Codex picks it, so a Codex Run starts with no session ID and the daemon records it from `thread/started` with the new event `v1.RunSessionIdentified`. `Run.sessionId` is now optional. Resume (spec 7.3) passes the ID back: `thread/resume` for Codex, `--resume` for Claude Code, with the same per-Run flags.
- **Per-Run flags only.** Everything is a `-c` override on the command line; Ted never writes to `~/.codex`. Network access in the sandbox is on so that `ted` reaches the daemon on loopback, as it does for Claude Code. The environment policy turns off Codex’s default filter of names containing `TOKEN` or `KEY`, which would also drop `GIT_CONFIG_KEY_<n>` and break git whenever `GIT_CONFIG_COUNT` is set. In its place Codex’s own process gets its environment from `withoutCredentials` in `agents/agent.ts`, the same check Claude Runs use (ADR 0057), so no other credential is there for its commands to inherit, even after `RunManager.restart` rewrites `launch.json`. Under API key billing the process keeps `CODEX_API_KEY` and `OPENAI_API_KEY`, and `exclude` keeps those two out of its commands. Under `auto`, `ted` runs inside the sandbox without an approval request; Ted adds no exec-policy rule for it, because an `allow` rule would run it outside the sandbox.
- `CODEX_API_KEY` is removed from the agent’s environment (ADR 0004). Codex reads it, not `OPENAI_API_KEY`, for its own login. `OPENAI_API_KEY` is removed too.
- **Default Task Lead:** Claude Code if its binary is installed, else Codex (spec 4.5). “Installed” means the binary is an executable file, found on `PATH` or at the path given. `workflow.yaml`’s `lead` overrides this once it is read.

Checked on codex-cli 0.160.0 on 2026-11-08 with a real Run: `ted task list` from inside Codex’s sandbox reached the daemon, the thread ID was recorded, and the Run went working, then idle.

## Considered Options

- **`codex exec --json`.** Headless and simpler, but one process per turn, so a long Task Lead Run can’t stay open between turns, and the spec names app-server.
- **A bridge process between the host and Codex.** Keeps the host unchanged, but adds a process, and Codex is orphaned if the bridge is killed with `SIGKILL`.
- **Leave approval requests unanswered.** The Run would show as waiting and never move until spec 7.8.

## Consequences

- With Codex’s sandbox, `.git` is read-only, so `git commit` asks for approval and is declined until spec 7.8 routes requests to Ted. A user’s own `approvals_reviewer = "auto_review"` in `~/.codex/config.toml` still applies. (Since 0.1.11 it doesn’t, and Ted passes the setting itself under `auto`: ADR 0121-codex-reviews-its-own-approvals-under-auto.)
- The app-server protocol is marked experimental. A Codex update that renames these methods breaks Codex Runs, and the stub in the tests won’t catch it.
- Every variable in the daemon’s environment that isn’t a credential reaches the shells Codex runs, as it does Claude Code’s Bash tool. An allowlist (`include_only`) would break builds that need the user’s own variables. The credential check also drops `SSH_AUTH_SOCK`, so commands Codex runs can’t use the user’s SSH agent, the same as Claude Runs.
- Codex’s Conversation lines are raw JSON-RPC messages, including responses to the driver’s requests.
- The `ted mcp` server isn’t passed yet because it doesn’t exist; it will be another `-c mcp_servers.ted…` override.
