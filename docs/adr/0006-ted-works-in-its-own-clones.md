# TED works in its own clones, not the user’s

TED keeps its own clone of each GitHub repo a Factory uses, under `~/.ted/repos/<owner>/<repo>/`, and makes every Task worktree from that clone, under `~/.ted/worktrees/<TASK-ID>/<repo>/`. It never adds branches or worktrees to the user’s own clone. When the human adds a Factory from a local folder, TED stores that folder per machine only as the source of files copied into new worktrees, such as `.env`. We chose this so TED’s branches and worktrees never appear in the user’s repo, TED doesn’t need lasting access to protected folders, and the user’s own git commands can’t break a running Task.

## Considered Options

- **Worktrees made from the user’s clone**, as agent-orchestrator does. Uses less disk and makes `.env` links natural. Rejected: it fills the user’s repo with TED’s branches and worktrees, needs ongoing access to protected folders on macOS, and breaks when the user rebases, prunes or deletes branches in that clone.

## Consequences

- About twice the disk use for each repo, which TED’s disk rules have to count.
- A changed `.env` in the user’s folder only reaches worktrees created after the change, because files are copied, not linked.
- No local path ever goes in `workflow.yaml`; the local folder lives in TED’s store on each machine.
