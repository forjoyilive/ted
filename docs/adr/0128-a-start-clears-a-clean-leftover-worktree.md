# A start clears a clean leftover worktree and stops for one that holds work

A Task’s worktree is made by `git worktree add` before `v1.TaskStarted` records it (ADR 0016, ADR 0025). Two things could leave the folder on disk with no record: the daemon dying between the two steps, and `git worktree add` exiting non-zero after it had made the worktree (a failing `post-checkout` hook does this). Every later start then failed with “already exists”, put the Task back in Backlog, and left one more numbered branch in the clone, because git makes the branch before it checks the path.

**A failed start undoes what it made.** `create` in `tasks/local-lifecycle.ts` notes, before `git worktree add`, whether the branch and a worktree at the path already exist. When the add fails it removes a worktree that is registered at the path now and wasn’t before, and deletes the branch only if it didn’t exist before, with `git update-ref -d refs/heads/<branch> <tip>`, which does nothing unless the branch still points at the base commit it was made from. `launchQueued` rolls back every worktree it made when recording the start fails, not only when a later worktree fails.

**A start looks at the path first.** Before the branch name is picked, `clear` in `tasks/local-lifecycle.ts` checks `TED_HOME/worktrees/<TASK-ID>/<name>`:

- Nothing there, or an empty plain folder: the start goes on.
- A link or a file: the start stops. TED never follows or removes it.
- A plain folder that is a worktree of this repo’s clone at exactly that path, with nothing uncommitted and a `HEAD` with no commits beyond `origin/<base>`: TED removes it with `git worktree remove --force` and deletes its branch with the same guarded `update-ref`, then starts fresh. Nothing is lost: the only files that go are ones git ignores, which copy and `setup` make again.
- The same, when a removed worktree is being made again (unarchive, a changed Repos field) and the leftover is on the Task’s recorded branch: TED removes the worktree and keeps the branch, commits included.
- A worktree with uncommitted files, with commits beyond the base on any other branch, one that is locked or one TED can’t read, and any other folder with something in it: the start stops and nothing is deleted.

“A worktree of this clone at that path” means both directions agree: `git worktree list --porcelain -z` in the clone lists the path (compared by real path), and the folder’s `.git` is a regular file whose `gitdir:` resolves to a folder directly inside the clone’s `.git/worktrees`. Uncommitted files are read with `workingChanges`, the scratch-index reader (ADR 0079), never `git status` in the worktree. Every folder is checked as a plain folder inside `TED_HOME/worktrees` first, as for any other worktree step.

**The human is told.** A start that fails still puts the Task back in Backlog, and now also posts one TED note in the Task’s thread with the reason (redacted, one line, not repeated while it is the newest Comment). For a folder in the way the reason names the folder, what is in it and what to do: move or delete it, then start again. When TED removes a leftover it says so in a note too.

`git worktree add` for a new Task now runs `git worktree prune` first, as the restore path already did, so a leftover folder the human deleted by hand doesn’t block the start either.

## Considered Options

- **Adopt the leftover as the Task’s worktree.** Rejected: a worktree from a start that was killed may be half checked out, has an old base, and has no copy or `setup` record, so the Task would start from a state TED can’t describe. Removing a clean one and starting fresh gives the same result as a first start.
- **Remove a leftover that has work in it, or move it aside.** Rejected: TED has no record of who put the work there. It is the human’s to keep or delete.
- **Delete the numbered branches earlier failed starts left in the clone.** Not done here. They hold no commits of their own and block nothing; new starts no longer add to them.
- **A banner or a FAILED ask for a folder in the way.** Rejected: nothing is running and the Task is in Backlog, which is where a Task that couldn’t start already goes (ADR 0016). The thread note and the answer to the start request carry the reason.

## Consequences

- A home that already has such leftovers recovers on the next start when they are clean, without manual steps.
- A daemon killed while `git worktree add` is still checking files out can leave a locked or half-written worktree. That one counts as holding work, so the human has to delete the folder.
