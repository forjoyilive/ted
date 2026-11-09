# Codex runs as `codex app-server`, driven from the host by a driver in `agents/`

Codex is the second agent kind behind the interface in ADR 0014. Its Runs start the user’s installed `codex` binary as:

```
codex app-server -c sandbox_mode="workspace-write" -c approval_policy="on-request"
  -c sandbox_workspace_write.network_access=true
  -c shell_environment_policy.inherit="all"
  -c shell_environment_policy.ignore_default_excludes=true
```

- **A driver in the host.** `app-server` speaks JSON-RPC over stdio, and the thread ID only arrives in a response, so a single first input line isn’t enough. An agent module may name a driver file in `agents/`; the Run manager writes its path to the new optional `driver` field of `launch.json` (ADR 0013), and the host imports it and passes it each stdout line. `agents/codex-driver.ts` sends `initialize`, `initialized`, `thread/start` (or `thread/resume`) and `turn/start` with the prompt, and answers every request Codex sends. The host still logs every stdout line unchanged, and still interprets nothing itself.
- **Approval requests are declined at once** (`decline` for commands and file changes, an error for anything TED doesn’t know) until spec 7.8 routes them to TED. This matches `claude -p`, which denies a prompt when nothing answers it. Without an answer the Run would wait forever.
- **State comes from app-server events**, not hooks: `turn/started` and `thread/status/changed` to `active` mean working; `active` with `waitingOnApproval` or `waitingOnUserInput`, or a request from Codex, means waiting; `turn/completed` and status `idle` mean idle. Finished still comes from the host’s `exit` record.
- **The session ID is Codex’s thread ID.** Codex picks it, so a Codex Run starts with no session ID and the daemon records it from `thread/started` with the new event `v1.RunSessionIdentified`. `Run.sessionId` is now optional. Resume (spec 7.3) passes the ID back: `thread/resume` for Codex, `--resume` for Claude Code, with the same per-Run flags.
- **Per-Run flags only.** Everything is a `-c` override on the command line; TED never writes to `~/.codex`. Network access in the sandbox is on so that `ted` reaches the daemon on loopback, as it does for Claude Code. The environment policy keeps every variable, so Codex’s default filter of names containing `TOKEN` or `KEY` doesn’t drop the Run token. Under `auto`, `ted` runs inside the sandbox without an approval request; TED adds no exec-policy rule for it, because an `allow` rule would run it outside the sandbox.
- `CODEX_API_KEY` is removed from the agent’s environment (ADR 0004). Codex reads it, not `OPENAI_API_KEY`, for its own login. `OPENAI_API_KEY` is removed too: Codex’s default filter would have kept it out of the shells it runs, and the environment policy above turns that filter off.
- **Default Task Lead:** Claude Code if its binary is installed, else Codex (spec 4.5). “Installed” means the binary is an executable file, found on `PATH` or at the path given. `workflow.yaml`’s `lead` overrides this once it is read.

Checked on codex-cli 0.160.0 on 2026-11-08 with a real Run: `ted task list` from inside Codex’s sandbox reached the daemon, the thread ID was recorded, and the Run went working, then idle.

## Considered Options

- **`codex exec --json`.** Headless and simpler, but one process per turn, so a long Task Lead Run can’t stay open between turns, and the spec names app-server.
- **A bridge process between the host and Codex.** Keeps the host unchanged, but adds a process, and Codex is orphaned if the bridge is killed with `SIGKILL`.
- **Leave approval requests unanswered.** The Run would show as waiting and never move until spec 7.8.

## Consequences

- With Codex’s sandbox, `.git` is read-only, so `git commit` asks for approval and is declined until spec 7.8 routes requests to TED. A user’s own `approvals_reviewer = "auto_review"` in `~/.codex/config.toml` still applies.
- The app-server protocol is marked experimental. A Codex update that renames these methods breaks Codex Runs, and the stub in the tests won’t catch it.
- Every other variable in the daemon’s environment, such as `GH_TOKEN` (spec 2.3), reaches the shells Codex runs, as it does Claude Code’s Bash tool. An allowlist (`include_only`) would break builds that need the user’s own variables. Passing only TED’s variables through a different channel is a possible later change.
- Codex’s Conversation lines are raw JSON-RPC messages, including responses to the driver’s requests.
- The `ted mcp` server isn’t passed yet because it doesn’t exist; it will be another `-c mcp_servers.ted…` override.
