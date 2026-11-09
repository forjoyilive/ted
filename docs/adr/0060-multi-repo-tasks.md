# Multi-repo Tasks: the Repos field, the Task folder and worktrees per repo

**The Factory’s repos.** `factoryRepos` (`packages/daemon/src/tasks/repos.ts`) is the one place that lists a Factory’s repos for Tasks. The primary repo comes first, from the Factory itself. Secondary repos come from `repos` in the resolved `workflow.yaml` when it lists any, otherwise from the repos stored when the Factory was added. Each entry carries its `name`, owner/repo, clone URL, `base_branch` and `worktree` settings. A secondary’s clone URL is the stored one, or one TED builds from the parsed owner/repo (`https://github.com/<owner>/<repo>.git`, or the SSH form when the remote is SSH); the remote text from `workflow.yaml` never reaches `git`. Owner/repo segments of `.` or `..` are dropped, so a clone path can’t leave `~/.ted/repos/`.

**The Repos field.** A Task stores its repos as owner/repo (`v1.TaskReposSet`, `chosenRepos` on the Task), so a `name` change in `workflow.yaml` doesn’t lose them. Unset means the primary repo. `PUT /tasks/<id>/repos` takes exactly one of `set`, `add` or `remove`, by `name` or owner/repo; the Task Lead (Run token) and the app may call it. It is refused in a single-repo Factory, for a Done or archived Task, with no repo left, and for a repo with an open (draft or ready) pull request. Removing a repo whose worktree has commits ahead of `origin/<base_branch>` changes nothing and answers with `confirm`: the app asks with Remove / Keep, and `ted task repos remove` exits 1 telling the Task Lead to ask the human and run it again with `--yes`.

**Worktrees.** Before the Task starts, the field is only recorded. When it leaves Queued, TED creates a worktree for every repo in the field, which is the primary repo unless the human or an earlier change set others, all on one branch name chosen so it is free in every one of those clones. Every `setup` runs, in Factory order, before the Task Lead starts, and any failures go to it together. Once the Task has worktrees, adding a repo creates its worktree at once from the Task’s branch (reusing the branch if that clone already has it, as Unarchive does) and runs its `setup` in the background; `ted task repos add` polls `GET /tasks/<id>/repos/<name>/setup` and prints the output when it ends. Removing a repo runs its `teardown` and removes its worktree. A human change is sent into the live Task Lead Run, and so is the end of a `setup` the human started.

**Run folder.** In a Factory with more than one repo, every Task Lead Run, and every sub-agent without `--own-worktree`, starts in the Task folder `~/.ted/worktrees/<TASK-ID>/`, even when the Task uses one repo; its prompt gains a Repos section listing the Factory’s repos, the Task’s worktrees and the `ted task repos` commands. In a single-repo Factory the Run folder stays the repo’s worktree. A sub-agent’s own worktree is cut from the Task’s first live repo, in that repo’s clone.

**Checks, pull requests and teardown** find a Task repo’s settings through its owner/repo, so each repo gets its own `base_branch`, `env`, `teardown` and clone URL.

## Considered Options

- **Key the field by `name`.** Rejected: the spec tracks Task repos by owner/repo so renames don’t break them.
- **Refuse a removal with commits outright, or post a question to the human.** Rejected: a confirm answer lets the app ask in place and lets the Task Lead ask through the usual `ted comment --choice`, without a new kind of request.
- **Hold the `ted task repos add` request open until `setup` ends.** Rejected: `setup` may run for 15 minutes or more, past the client’s idle timeout; the CLI polls instead, like `ted checks`.

## Consequences

- The app’s Repos field lists the repos stored with the Factory, not ones that only `workflow.yaml` names; the daemon accepts both.
- A secondary repo’s `setup` started by adding the repo is not stopped by Stop (it is not a Run); archiving stops it, and a daemon restart runs an interrupted one again.
- `TED_APP_<NAME>_PORT` and `TED_APP_<NAME>_URL` are not set yet; they come with Apps.
