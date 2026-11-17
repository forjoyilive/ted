# Ted pushes Task branches and opens pull requests from the Tasks module

Agents only commit (ADR 0007). The daemon pushes each Task branch and opens its pull requests through one module, `packages/daemon/src/tasks/pull-requests.ts`. The Tasks module calls it at one point: when a Task enters Merge. Nothing is pushed and no pull request exists while the Task is in Work, Validate or Review (TED-542). Until TED-542, Ted pushed and opened a draft at Validate entry, pushed again when Validate passed, and pushed and marked the draft ready when the Review sign-off was posted.

- **Merge entry** records, per repo, the commit to publish (`v1.MergeCommitChosen`, ADR 0056): the commit the human approved at the Gate before Merge, or the worktree’s `HEAD` when there was no Gate. `publish` pushes that commit for each repo that has commits on top of `origin/<base_branch>`, never a later `HEAD`. A repo with no open pull request gets one from `gh pr create` without `--draft`, recorded as ready at once: the Task title as title, the brief’s Goal (or the description before a brief exists) and “Opened by Ted for NB-12” as body, with the Linear link when the Task came from Linear. A pull request still open as a draft from before TED-542 is pushed and marked ready with `gh pr ready`.
- **A pull request left open after a send-back from Merge** stays as it is. Ted pushes nothing to it until the Task enters Merge again.
- A multi-repo Task gets one pull request per repo with commits; once a second one opens, Ted edits every body to name the others. A repo without commits gets none.
- Archive closes the Task’s open pull requests with `gh pr close` when the request asks for it (`closePullRequests`); the branches stay.

The work runs in the background in a queue per Task, in the order it was asked for, so a slow push never blocks a Stage change and an archive’s close never overtakes an earlier push. Removing a Task’s worktrees waits for that queue. A failed push or `gh` call is recorded on the repo (`v1.TaskBranchPushFailed`) and logged through `redactSecrets`. The Task stays at Merge, and the merge watcher queues the publish again on each of its checks until the push and pull request succeed. If `gh pr create` fails because a pull request already exists for the branch, Ted finds it with `gh pr list` and records that one.

An agent can write to its worktree and to the clone’s git config, and Ted pushes outside the agent’s sandbox, so `git push`:

- reads only the commit and the location of the clone’s objects from the worktree, with hooks and `core.fsmonitor` off;
- pushes from a new bare repo in a temporary folder that borrows the clone’s objects through `objects/info/alternates`, so git reads the user’s system and global config and Ted’s own empty repo config, and never the clone’s or worktree’s config (remotes, `pushurl`, `url.*`, `http.*`, `credential.*`, `core.sshCommand`, hooks, includes);
- pushes the commit to `refs/heads/<branch>` at the Factory’s stored clone URL, never `origin`;
- turns off hooks (`core.hooksPath=/dev/null`, `--no-verify`) and the `ext::` transport;
- runs with the user’s own credentials, `GIT_TERMINAL_PROMPT=0` and the Check environment from `worktreeCommandEnv` (no `TED_` names or agent API keys);
- uses `--force-with-lease` against the commit it pushed last.

`gh` runs with `--repo`, `--head` and `--base` and outside the worktree, so it never reads the Task’s git config.

At each push Ted records whether the repo has CI (spec §9.9 rule 3), for the Merge Stage to use: files ending in `.yml` or `.yaml` under `.github/workflows` in the pushed commit; required status checks on the base branch, from branch protection or rulesets (`gh api repos/<repo>/branches/<base>` and `rules/branches/<base>`); or a status check rollup on any of the last 20 base commits, in one GraphQL query. A signal that can’t be read counts as absent.

Events: `v1.TaskBranchPushed` (commit, CI and which signals found it), `v1.TaskBranchPushFailed`, `v1.PullRequestOpened`, `v1.PullRequestMarkedReady` and `v1.PullRequestClosed`, materialized into the `pullRequests` table and carried on each `TaskRepo` as `pushed`, `pushFailed` and `pullRequest`. The Code section shows the pull request per repo, and the app opens its link through the main process, which reads the URL from the daemon and opens only a GitHub pull request URL.

## Consequences

- An in-process daemon (`startDaemon`) now falls back to `TED_GH_BIN` for `gh`, as `main.ts` does, so tests that walk a Task to Merge run the stub `gh` and never reach GitHub.
- The pull request body has no link that opens the Task in Ted, because Ted has no URL scheme yet.
