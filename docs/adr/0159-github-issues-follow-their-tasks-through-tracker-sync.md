# GitHub issues follow their Tasks through tracker sync

A Task imported from an issue in one of its Factory’s repos (ADR 0158) should keep that issue up to date: say when work starts, link it from the pull requests, and close it when the work merges. GitHub is the third connector of the shared tracker sync (ADR 0147), in `packages/daemon/src/tasks/github-sync.ts`, with its GitHub calls in `packages/daemon/src/github/issue-sync.ts`. Linear’s and Asana’s connectors are unchanged.

**One switch is the only consent.** The `githubIssueSync` machine setting, off by default and shown in Settings → Integrations as **Keep issues up to date**, turns every GitHub sync read and write on or off. There is no per-Task permission and no per-repo question: a Task syncs when its source carries `TaskSource.github`, which TED sets only for an issue in one of the Factory’s repos. Off by default because what TED writes appears in public repos under the user’s own account. Import works whatever the switch says. Every request goes through the `Gh` runner, so it uses the user’s `gh` login and never a token.

**What TED writes.** Four things, all fixed text that never mentions TED or AI and never contains text an agent wrote:

- “Work on this has started.” the first time the Task is past Design (Work or later), once.
- In each pull request’s description, “Fixes owner/repo#N” when the Task has one repo, or “Part of owner/repo#N” in each when it has several, so GitHub doesn’t close the issue at the first merge. An issue with open sub-issues also gets “Part of”, so GitHub never closes a parent at merge; until TED has read the issue it counts the sub-issues as unknown and writes “Part of”. `pullRequestBody` in `tasks/pull-requests.ts` asks for the line just before each write, through a function that reads the switch, the Task and the last sub-issue count then. The connector’s link step reads each new pull request’s description and rewrites the line with `withIssueLine`, which also covers a switch turned on after a pull request opened; while an issue has open sub-issues, each cycle checks its Task’s linked pull requests once per daemon run and turns “Fixes” into “Part of”.
- “Fixed in <pull request URLs>.” once every pull request of the Task has merged.
- Closing the issue as completed, after that comment, if it is still open.

A parent issue with open sub-issues (`subIssuesSummary`) is not closed; TED posts one note on the Task saying it left the issue open. Nothing is written for a Task archived without merging, and TED sets no labels or assignees. The writes are `POST repos/<owner>/<repo>/issues/<n>/comments`, `PATCH repos/<owner>/<repo>/issues/<n>` and `PATCH repos/<owner>/<repo>/pulls/<n>`, with owner and repo checked against `[A-Za-z0-9_.-]+` and never dot-only.

**No comment twice.** Before each comment TED reads the issue’s comments, newest first, up to 500 in pages of 100, and skips the write when the signed-in user already posted that exact text. That covers a reply lost after GitHub saved the comment and a restart before TED recorded the step. When an issue has more than 500 comments TED can’t be sure, so it posts nothing. Just before each write TED checks the switch again, and that the Task is still in the state the write is for (not archived unless it merged), because the reads before it take time. A pull request whose line wasn’t written for that reason doesn’t count as linked, so the next cycle tries again.

**Turning the switch on doesn’t touch finished work.** The first read of an issue whose Task is already Done or archived records the final step and its pull requests as linked without writing anything, so turning the switch on never comments on old issues. Open Tasks catch up: one past Design gets the started comment and its pull requests get their line. To make a connector’s baseline count in the same cycle, the shared cycle now reads the Task’s record again after `see`; for Linear and Asana `see` writes only what was seen, so nothing changes for them.

**Closed on GitHub** follows the shared rule for any close reason (completed, not planned, duplicate): the first read is a baseline; later, open to closed archives a Task that hasn’t started and otherwise asks Archive or Keep going, withdrawn on reopen or finish. A close whose closing event names one of the Task’s own pull requests (the `ClosedEvent`’s `closer`) is not a close outside TED, so “Fixes” closing the issue at merge asks nothing.

**Reads.** One GraphQL query per 50 issues per cycle, every minute, reading each issue’s state, close reason, closer and sub-issue counts. When a batch fails for a reason other than a rate limit or sign-in, its issues are read one at a time so one deleted or private issue doesn’t stop the rest.

**In the thread and the app.** TED’s close is a quiet thread line, “Closed owner/repo#N on GitHub”; link records draw no line, since the baseline records links TED didn’t write. The Task menu’s **Open source in GitHub** item says whether sync is on.

## Considered Options

- **Ask per Task or per repo before writing, like Linear and Asana.** Rejected: the user asked for one switch, and the switch is off until they turn it on.
- **Write the issue line only from the connector.** Rejected: TED already writes the pull request description when it opens one, and adding the line there avoids a second write for most pull requests.
- **Treat any close while the Task is at Merge as TED’s own.** Rejected: GitHub says what closed the issue, so TED doesn’t need to guess from timing.

## Consequences

TED now writes to GitHub issues and pull request descriptions as the user, in public repos too, but only with the switch on, only for issues in a Factory’s repos and only the fixed text above. A comment with the same text that the user posted themselves counts as TED’s, so TED doesn’t post it again.
