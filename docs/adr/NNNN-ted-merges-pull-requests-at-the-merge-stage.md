# TED merges pull requests at the Merge Stage, and “merged” means every pull request merged

The daemon merges a Task’s pull requests itself (spec 9.9, ADR 0007). When a Task enters Merge with the Merge Gate off, or the human approves the Merge Gate, the Tasks module starts one merge watcher for that Task, and again for every Task at Merge when the daemon starts. The Task Lead’s Run stays open but gets no work: `ted outcome advance` at Merge is refused, and the idle nudge leaves it alone while TED is merging.

**The signed-off commit.** The human approves a specific commit per repo. When a Gate before Merge is approved, TED waits for the Task’s pull request queue and records each ready pull request’s last pushed commit as its signed-off commit (`v1.PullRequestSignedOff`); a repo whose push failed at sign-off, or whose pull request is still a draft, gets an explicit none. Every push, failed push, pull request opened and move out of Merge clears it, so an old approval never carries into a later Merge visit. With no Gate before Merge, TED pushes and marks the pull requests ready at Merge entry and records that commit instead. After an approval TED never pushes at Merge. Every check, auto-merge and merge uses the signed-off commit (`--match-head-commit`). A pull request with no signed-off commit, still a draft, or whose head differs from it (other than the rebase below) sends the Task back to Validate for a new sign-off.

**One cycle.** The watcher waits for the Task’s pull request queue (ADR 0048), then reads every open pull request of the Task in one batched GraphQL query: state, draft, head commit, mergeability, review decision, auto-merge, the head commit’s checks with which are required, and the repo’s allowed merge methods and auto-merge setting. `nextStep` in `packages/daemon/src/tasks/merge.ts` turns each into one step, and the Tasks module acts on it:

- **Merged on GitHub** (auto-merge, or the human): recorded, branch deleted.
- **Head isn’t the signed-off commit**: back to Validate, unless it is exactly the head GitHub returned for the rebase TED asked for.
- **Conflicts** with the base: back to Work.
- **Behind** a moved base (the base requires an up-to-date branch): TED asks GitHub to rebase the branch (`updatePullRequestBranch`, `REBASE`, with the expected head). GitHub refuses on conflicts, which sends the Task back to Work. TED adopts only the head the mutation returned, and only if it is a pure rebase: the fetched branch is that commit, the base’s tip is its ancestor, and its tree is exactly the tree `git merge-tree --write-tree --merge-base <old merge-base> <base tip> <signed-off commit>` produces, so whitespace and file modes count. The replay runs in a temporary bare repo that borrows the clone’s objects, so no merge driver from the clone’s config runs; a replay with conflicts counts as not pure. Anything else goes back to Validate. Then TED moves the worktree’s branch to it, makes it the signed-off commit, records `v1.TaskBranchRebased`, reruns the Checks through `runChecks` (trigger `merge`, first failure stops; a failure sends the Task back to Work), waits for CI again and merges. No new sign-off.
- **CI failed**: the required checks, or every check when none is required. Back to Work with the failing check names.
- **Waiting**: a required review shows Waiting for GitHub review; pending or missing checks on a repo that has CI (from the push, ADR 0048) show Waiting for CI; `gh` signed out or missing shows Waiting for GitHub sign-in. When GitHub reports the pull request blocked and the repo allows auto-merge, TED turns it on once per head with `gh pr merge --auto --match-head-commit`, so GitHub enforces required reviews and checks.
- **Ready**: mergeable (clean, unstable or has-hooks) and CI passed, or the repo has no CI. TED merges only when every open pull request of the Task is ready, with `gh pr merge --<method> --match-head-commit <pushed commit>`, then deletes the branch with the REST API unless the repo deletes merged branches itself.

The merge method is the repo’s `merge_method`, squash by default; when GitHub doesn’t allow it, TED uses the first allowed one of squash, merge, rebase and the thread line says so. When no pull request is left open, the watcher moves the Task to Done, which stops the Task Lead’s Run, runs `teardown`, removes the worktrees and wakes blocked Tasks (ADR 0035). A Task with no pull request at all goes straight from Merge to Done.

Each send-back from Merge counts against Merge’s `max_back`; over it, TED posts its usual question and the watcher waits while any request on the Task is open. The watcher also waits while the Task is Stopped or its Checks are running, and polls every 30 seconds (`mergePollMs` in `startDaemon` for tests).

**Merged.** A Task counts as merged for its blockers (`TedStore.isMerged`) when it is in Done and every pull request it opened is merged. A Task that never opened one counts as merged when it reaches Done.

**Request changes** at the Review Gate (or the Merge Gate) no longer keeps the Task in the Stage: the Task Lead must send it back to Work or Design with `ted outcome back`, and `advance` is refused until it does. The fix passes Validate again and returns with a new sign-off.

**Git safety.** Fetching the rebased head is network-facing, so `fetchBranch` in `git.ts` works like `pushBranch`: a new bare repo in a temporary folder, with `GIT_OBJECT_DIRECTORY` pointing at the clone’s objects, hooks and `ext::` off, the Factory’s stored clone URL, and the user’s own credentials, so the clone’s and worktree’s git config never apply. Moving the worktree’s branch (`git reset --keep`) writes files, so it turns off hooks, `core.fsmonitor`, submodule recursion and every `filter.<name>` the repo config defines (clean, smudge and process set empty), because an agent can set a filter command and select it from `.gitattributes`. It refuses when the worktree has commits that weren’t signed off.
Events: `v1.PullRequestWaitChanged`, `v1.PullRequestAutoMergeEnabled`, `v1.PullRequestMerged` and `v1.TaskBranchRebased`, materialized into the `pullRequests` table and carried on `TaskPullRequest` as `state: 'merged'`, `merged`, `autoMerge` and `waiting`.

## Considered Options

- **Rebasing in the worktree with `git rebase`, then pushing.** Rejected: a local rebase runs merge drivers and filters from config the agent can write, outside the agent’s sandbox. GitHub’s rebase needs only a fetch, which can run outside that config.
- **Always turning on auto-merge.** Rejected: auto-merge waits only for required checks, and the spec waits for every check when none is required. TED turns it on only when GitHub blocks the merge.
- **Polling through KRI-133’s GitHub watcher.** That ticket doesn’t exist yet; its batched poller can replace the per-Task query later.

## Consequences

- With Merge off (`stages.merge.enabled: false`), approving Review still moves the Task to Done with its pull request open, and Tasks it blocks stay blocked until something sees the merge (KRI-131).
- The CI-stuck question, the short re-sign-off card, Partly merged and merge order across repos come with KRI-131 and KRI-132. A merge queue is treated as merged once `gh pr merge` succeeds.
- If the daemon restarts between asking GitHub to rebase and seeing the new head, the new head looks like a change after sign-off and the Task goes back to Validate.
