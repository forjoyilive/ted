# Ted pushes Task branches and opens draft pull requests from the Tasks module

_Changed by ADR 0187-the-checks-run-as-validates-first-step-and-every-return-to-work-counts: Ted pushes and opens pull requests only when a Task enters Merge, ready for review rather than draft. There is no push at Validate entry, at Validate passing or at the sign-off; a draft opened before the change is marked ready at Merge entry. A failed push is retried by the merge watcher, and Merge and `ted task done` wait until each repo with commits has a pull request. The push itself, its safeguards and the events are unchanged._

Agents only commit (ADR 0007). The daemon pushes each Task branch and opens its pull requests through one module, `packages/daemon/src/tasks/pull-requests.ts`, which the Tasks module calls at three points: when a Task enters Validate, when Validate passes, and when the Review sign-off is posted. A Task entering Merge without a sign-off also marks its pull requests ready.

- **Validate entry** pushes each repo that has commits on top of `origin/<base_branch>` and has no open pull request yet, then opens a draft with `gh pr create --draft`: the Task title as title, the brief’s Goal (or the description before a brief exists) and “Opened by Ted for NB-12” as body, with the Linear link when the Task came from Linear.
- **Validate passing** (the Task Lead’s `ted outcome advance` from Validate) pushes every repo with commits again and opens any pull request that is still missing.
- **Sign-off** pushes each draft’s repo once more, then runs `gh pr ready` on it. A draft whose push fails stays a draft, so a pull request is never marked ready without the reviewed commits.
- A multi-repo Task gets one pull request per repo with commits; once a second one opens, Ted edits every body to name the others. A repo without commits gets none.
- Archive closes the Task’s open pull requests with `gh pr close` when the request asks for it (`closePullRequests`); the branches stay.

The work runs in the background in a queue per Task, in the order it was asked for, so a slow push never blocks a Stage change, `gh pr ready` never runs before the pull request exists, and an archive’s close never overtakes an earlier push. Removing a Task’s worktrees waits for that queue. A failed push or `gh` call is recorded on the repo (`v1.TaskBranchPushFailed`), logged through `redactSecrets`, and tried again at the next Validate pass. If `gh pr create` fails because a pull request already exists for the branch, Ted finds it with `gh pr list` and records that one.

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

- An in-process daemon (`startDaemon`) now falls back to `TED_GH_BIN` for `gh`, as `main.ts` does, so tests that walk a Task through Validate run the stub `gh` and never reach GitHub.
- The pull request body has no link that opens the Task in Ted, because Ted has no URL scheme yet.
