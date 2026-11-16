# The Task Lead writes the merge commit

Pull requests TED opened carried the Task’s title as written by the user, and TED merged them with GitHub’s default message, so the base branch filled with subjects such as “Merge pull request #439 from forjoyilive/ted/ted-414-…” and titles that read nothing like commit history (TED-416).

Now, at Merge and before `ted outcome advance`, the Task Lead runs `ted task pr "<title>" [--body-file <file>]`. The title is a Conventional Commits title (`type(scope)!: description`, a known type, an optional lowercase scope) without the Task ID; TED adds ` (<Task ID>)` and refuses a title that already ends with one or that is longer than 72 characters with it. `commitTitleProblem` in `packages/protocol/src/commit-title.ts` is the only format check.

- **Where it happens.** `POST /tasks/:id/pull-request-title` (`runToken: true`, current Task Lead only, `Tasks.setPullRequestTitle`) works only at Merge while `leadPending` holds, so the merge never starts with a half-written message. It renames every open pull request with `gh pr edit --title` through `PullRequests.retitle`, then records `v1.PullRequestTitleSet { taskId, title, body }` with the full title. Running it again replaces both.
- **The merge.** `mergeTargets` in `tasks/tasks.ts` reads the latest title with `store.pullRequestTitle` and gives it to the merge watcher as `MergeTarget.message`; `mergePullRequest` passes `--subject` and, when there is a description, `--body` for the merge and squash methods, the auto-merge call included. A rebase merge makes no merge commit, so it gets neither.
- **The fallback.** With no title recorded, TED behaves as before: the Task’s title on the pull request and GitHub’s default merge message. The merge never waits for a title.
- **The switch.** `stages.merge.commit_titles` (on unless `false`) turns it off for a Factory, from Factory settings or the Library on the Merge Stage row. With it off the route refuses and tells the Task Lead to skip the step, and the merge passes no message even if a title was recorded earlier.
- **Instructions** live in `merge.md`, not `work.md`, because Merge is where the Task Lead knows the final shape of the change.

## Considered Options

- **TED writes the title itself from the Task title.** Rejected: the Task title is the user’s request, not a description of the change.
- **The Task Lead writes it at Work hand-off.** Rejected: the change can still move in Validate and Review; the user asked for the step at Merge, which needed ADR 0169 first.
- **Hold the merge until a title exists.** Rejected: an old Run, a Factory that turns the switch on mid-Task or a Task Lead that skips the step would leave the Task stuck.
- **Rename past pull requests.** Rejected: only new merges change.

## Consequences

- The Task Lead spends a little of its Merge turn on the title and description.
- The title and description are agent text that reaches GitHub. They go only into the pull request title and the merge commit, through `gh` arguments, never a shell.
