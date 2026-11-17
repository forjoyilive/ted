# Under Auto, Codex reviews its own approval requests

Under `auto`, Codex runs in `workspace-write` with `approval_policy="on-request"` (ADR 0047). A Task’s worktree keeps its git metadata in the clone, at `TED_HOME/repos/…/.git/worktrees/<name>`, outside the sandbox. So every `git add` and `git commit` asks for approval.

Until 0.1.11 this was hidden on a machine whose `~/.codex/config.toml` had `approvals_reviewer = "auto_review"`: Codex’s own reviewer approved the request and Ted never saw it (ADR 0018). 0.1.11 gave Codex Runs their own home, `TED_HOME/codex`, so the personal file stopped applying. Every commit then needed the human, and Tasks stopped at the end of Work with their changes uncommitted.

Ted now passes `approvals_reviewer="auto_review"` itself for `auto`. Codex’s reviewer decides each request for access outside the sandbox. This matches Claude Code under `auto`, where its auto mode decides without asking. A request the reviewer passes on to the client still becomes a `permission` Comment, and Ted still refuses one it can’t show in full.

`bypass` is unchanged: no sandbox and no approvals. A Run with no tools (`textOnly`) is unchanged: read-only, approvals never.

## Considered Options

- **Make the clone’s `.git` a writable root of the sandbox.** Commits would need no approval at all, but the agent could then rewrite the clone’s config, hooks and other Tasks’ refs with no check.
- **Ask the human for every commit.** That is ADR 0047 as written. It stops every Codex Task at least once per Work visit for a decision that is always yes.
- **Read the human’s `~/.codex/config.toml`.** It would bring their MCP servers, plugins and hooks into Ted’s Runs, which the separate home exists to avoid.

## Consequences

- What Codex may do outside the sandbox under `auto` is decided by Codex’s reviewer, not by the human. A human who wants to see every request has no setting for it yet.
- Not checked: what a Codex version without the reviewer does with the key. It was seen working with the key in `config.toml` on the Codex installed on 2026-11-11.
- Hosts already running keep their settings until the agent restarts.
