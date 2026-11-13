# A Task moves to the latest base at its first Work entry

A Task’s branch is cut from `origin/<base>` when its worktree is made at Task start (`create` in `tasks/local-lifecycle.ts`). Nothing moved it afterwards, so a Task that waited at a Clarify or Design Gate, or was held before Work by preparation, started Work on the code as it was hours or days earlier. The base-conflict check (ADR 0110) only finds that out when Work is finished.

**The first time a Task enters Work, TED moves each worktree to the tip of its base branch when that is a fast-forward.** `adoptLatestBase` in `tasks/tasks.ts` does it, called from `move` before the Stage changes, when the destination is Work and the Task has no earlier Work entry (`firstWorkEntry` in `tasks/latest-base.ts`). A send-back to Work and every later entry leave the branch alone. A Task whose first Stage is Work doesn’t go through `move`; its worktree was cut moments earlier.

For each repo that isn’t removed and has no pull request, with the base and URL `pullRequestTargets` gives (so a setup Task and a Task that changes `.ted/` use the right branch):

1. `execution.local` and `worktreeFileScope` run first, as for the base-conflict check.
2. `fetchBranch` reads the tip from the Factory’s stored URL, in a scratch repo. Nothing is fetched inside the worktree.
3. `HEAD` equal to the tip: nothing to do. `HEAD` not an ancestor of the tip (`isAncestor`): the branch has commits of its own and stays where it is.
4. The clone’s `origin/<base>` must contain the tip. The Changes view, `touchesSettings` and the failure context all diff against the merge-base of `HEAD` and that ref; if the branch moved past it, every commit the base gained would count as the Task’s change. When the ref is behind, TED fetches the clone once (60 seconds at most) and looks again; still behind, the repo stays where it is.
5. `moveBranchTo` moves the branch with `git reset --keep`, hooks and filters off. It refuses when a local change would be overwritten, and then the repo stays where it is.

`baseStep` in `tasks/latest-base.ts` is the decision in steps 3 and 4.

**It never stops the move.** Every failure (fetch, a refused reset, the store) is caught and logged through `console.error` with `redactSecrets`, and the Task enters Work on the commit it had.

**The Task Lead is told.** It may have read the old files in Clarify or Design. When a repo moved, `latestBaseNote` adds one paragraph to the Work entry message: which branch moved to the latest base, that files may differ from what was read earlier, and to run the dependency install again if dependencies changed. Repo and base names go through `oneLine` and `redactSecrets`; no file name is listed. If no Task Lead Run is live to take the message, the note waits in memory and goes into the next Task Lead prompt (`leadContext`).

**It is recorded.** Each repo that moved is one `v1.BaseBranchAdopted` event (Task, repo, base, the commit it left and the commit it moved to), written by `store.baseAdopted`. The thread shows “TED moved <repo> to the latest <base>”.

**A Task held before Work moves when it really starts.** Preparation ends at `holdBeforeWork`, which records the Work entry and stops the Task Lead; the Task can then wait a long time. `move` returns at the hold before it reaches `adoptLatestBase`, and `launchQueued` calls it instead when the Task is in Work and `store.heldBeforeWork` says no Task Lead Run has started since the hold. The note goes into the fresh Run’s prompt.

## Considered Options

- **Rebase or merge when the branch has its own commits.** Rejected: that can conflict, and a Stage before Work that commits (a prototype in Design) made those commits against the old base on purpose. The hand-off check (ADR 0110) already tells the Task Lead to merge when it matters.
- **Update at every Work entry.** Rejected: after a send-back the branch has the Task’s commits and a reviewer has scoped its next round to a recorded commit (ADR 0107).
- **Cut the worktree later, at Work.** Rejected: Clarify and Design read the code and may write to the worktree.
- **Run `setup` again after the move.** Not done: `setup` can be slow and most moves change no dependency. The Task Lead is told to reinstall when dependencies changed.
- **Update at the preparation hold.** Rejected: the wait between the hold and the start is the long one.

## Consequences

- The move costs one fetch per repo at the first Work entry, two when the clone is behind, each limited to 60 seconds.
- A note that is waiting in memory for the next Task Lead prompt is lost if the daemon restarts first. The thread line stays.
- Dependencies installed by `setup` can be older than the new base until the Task Lead reinstalls them.
- A sub-agent worktree made in an earlier Stage is not moved.
