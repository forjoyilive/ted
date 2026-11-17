# A Task Lead asks before its Task is archived

A Task Lead that found its Task was a duplicate or no longer needed could only say so in a Comment and ask the human to archive it from the app (TED-242, TED-271). Nothing reached the Inbox, and the Task sat in its Stage until the human noticed.

**The Task Lead asks, and the human (or Autopilot, or the Coordinator on the human’s word) answers Archive or Keep it.** `ted task archive --reason "<why>"` calls `POST /tasks/:id/archive-request` (`runToken: true`), which acts only for the Task’s current Task Lead Run on its own Task (`taskLead`). It posts one `question` with the purpose `archive`, the choices Archive and Keep it, and an `archive` field (`v1.CommentArchiveAsked`): the one-line reason and, when a pull request is open, the Lead’s recommendation to close or keep it with a reason. The route refuses a Task that is archived or Done, a second open archive request, and a Task with an open pull request but no recommendation. An archive request can’t be superseded.

- **Archive** runs `Tasks.archive`’s path with the options in the answer (`AnswerRequest.archive`: close the pull requests, the Tasks under it, the Tasks it blocks, the hierarchy revision). The hierarchy check runs first, then the answer is recorded, then the Task is archived, so the request reads as answered rather than withdrawn by the archive.
- **Keep it** records the answer and tells the Task Lead that Ted won’t archive the Task and the Task stays in its Stage.
- **The card** says what archiving does, lists the Tasks under the Task and the Tasks it blocks, and offers Close the pull request preset to the Lead’s recommendation. With Tasks under it or Tasks it blocks, Archive opens the app’s Archive dialog, which answers the request.
- **Autopilot** answers Archive itself, using the recommendation and unblocking the Tasks it blocks, when the Task’s effective Autopilot is on and no Task under it would be archived; otherwise the request waits for the human. The Task Lead can’t answer it with `ted autopilot answer`.
- **The Coordinator** answers it with `ted coordinator answer --choice Archive|"Keep it"`; with an open pull request, Archive also needs `--close-pull-requests` or `--keep-pull-requests`. It can’t answer Archive when Tasks under the Task would be archived too.
- **Reaching Done** withdraws an open archive request. Other Stage moves leave it open.

## Considered Options

- **A standing setting that lets Task Leads archive without asking.** Rejected by the user in Clarify: each archive is asked for.
- **Let Archive call the existing archive route.** Rejected: the archive would withdraw the request, so it would never show as answered and the Lead would get no answer.
- **A separate archive request for the Coordinator.** Dropped: `ted coordinator archive` (ADR 0141) already archives Tasks, with a confirmation card when there is something to warn about.

## Consequences

- A Run can ask for its own Task to be archived, but only the human, Autopilot or the Coordinator archives it, through the same code as the app’s Archive.
- A Task Lead can’t ask to archive another Task.
