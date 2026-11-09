# The Changes section reads each worktree through a scratch git directory and a fresh index

Task details lists a Task’s changes, and the middle pane shows each file’s diff (spec §9.5). The diff is the Task branch against its merge-base with the repo’s base branch, uncommitted work included, so TED has to read the agent’s working tree. Running `git diff` or `git status` inside the worktree would honour the clone’s `.git/config` and the worktree’s index, both of which the agent can write: `core.fsmonitor`, `diff.external`, filter drivers and textconv run commands, and a hand-edited index (an `assume-unchanged` entry, or stat data that matches a file the agent changed) can hide committed work from the human.

## Decision

`workingChanges` in `packages/daemon/src/git.ts` reads HEAD and `origin/<base_branch>` from the worktree, then does everything else in a temporary bare git directory whose `objects/info/alternates` points at the clone’s objects:

- `read-tree HEAD` into a fresh index in the scratch folder, then `git add --all` with `GIT_WORK_TREE` set to the worktree. The agent’s index is never read, so every file is hashed from disk.
- `write-tree` gives one tree for HEAD plus uncommitted work. The file list is `diff --numstat` from the merge-base to that tree; a file is uncommitted when it differs between HEAD and that tree.
- Every git call passes `core.fsmonitor=false`, `core.hooksPath=/dev/null`, `diff.external=` and `--literal-pathspecs`, and diffs pass `--no-ext-diff --no-textconv --no-renames`. The scratch directory has no config of its own, so the clone’s config never applies.

The daemon reads the changes on every request; it keeps no cache. The app reloads them when the Task changes, when one of its Runs writes output (after 1.5 s of quiet) and when the window gets focus.

## Consequences

- Each read hashes every file in the worktree, which costs about as much as a `git status` with no index. Fine for the repos TED targets; a cache keyed on HEAD and file stats can come later if it isn’t.
- Untracked files that `.gitignore` doesn’t cover show up, as they would in `git status`. Ignore rules come from the worktree’s `.gitignore` files and the user’s global git config, not the clone’s `.git/info/exclude`.
- Line comments (KRI-136) anchor on the `head` and `mergeBase` each `FileDiff` carries, and on old and new line numbers.
