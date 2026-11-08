# Build TED standalone instead of forking or wrapping agent-orchestrator

agent-orchestrator already runs coding agents in worktrees and watches their pull requests, but its model is one session per card with fixed computed columns, and it has no Tasks, Stages or Comments. We build TED as its own TypeScript daemon and Electron app, port logic from agent-orchestrator where it helps (agent launch flags, PTY handling, worktree setup, sending CI failures and review comments back to agents), and copy React UI code under Apache-2.0, keeping its NOTICE and marking changed files.

## Considered Options

- **Fork it.** Means taking on its Go daemon instead of the chosen TypeScript one, and adding Tasks, Stages, Comments and several Runs per Task across its schema, API and UI while upstream moves about 150 commits a week. Rejected.
- **Run its `ao` daemon alongside TED.** Means two daemons with two stores and two ideas of a session, telemetry on by default, one worktree per session where a Task Lead needs sub-agents on one Task, and no control over Runs staying open while they wait for the human. Rejected.

## Consequences

- TED does not get agent-orchestrator’s fixes or new adapters for free. v1 supports Claude Code and Codex; other agents are ported when needed.
