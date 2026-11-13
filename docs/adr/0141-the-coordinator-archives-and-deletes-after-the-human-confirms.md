# The Coordinator archives and deletes Tasks after the human confirms

The Coordinator could create, start, move, tell, answer, resume, re-parent and finish Tasks, but not archive or delete them (ADR 0094). A user who said “archive the Done ones” or “delete these duplicates” in the Coordinator chat still had to do each one by hand.

**The Coordinator archives, unarchives and deletes Tasks of its own Factory, and the human confirms the risky ones on a card TED draws.** `ted coordinator archive|unarchive|delete <id>… --operation <id> --versions <JSON>` calls `POST /coordinator/archive|unarchive|delete` (`runToken: true`), which reaches only `Coordinators.remove`. One command names up to 20 Tasks, each with the version from a current read; a stale version or a Task of another Factory refuses the whole command.

- **Unarchive**, and **archive** of a Task with nothing to warn about, act at once through `Tasks.unarchive` and `Tasks.archive`, the same code the app’s buttons use, and record one receipt per Task (receipt ID `<operation>:<task ID>`). Unarchive uses the app’s defaults: the family archived with the Task comes back, and the Task stays under its parent; when the parent can’t take it back, the receipt says why.
- **Delete** always, and **archive** of a Task with an open pull request, Tasks under it, Tasks it blocks or a working Task Lead, saves a `CoordinatorConfirmation` on the stored Coordinator and changes nothing. The card lists each Task with what TED found and the choices from the app’s Archive and Delete dialogs (children, blocked Tasks, Close the pull request), preselected with the Coordinator’s pick. Close the pull request starts unticked unless the Coordinator was told to close it.
- The card shows in the Coordinator chat and as a `source: 'coordinator'` request in `TedStore.waiting()`, so it counts in the Inbox, can be snoozed (its snooze row’s owner is the Factory) and notifies like other requests. Only the app answers it: `POST /factories/:id/coordinator/confirmations/:confirmationId` sets neither `runToken` nor `fileToken`.
- On Confirm, `Coordinators.answerConfirmation` records the answer first, so a second click is refused, then reads each Task again. A Task whose Stage, Tasks under it, Tasks it blocks or open pull requests changed, or whose Task Lead started working, since the card was shown is refused with what changed. A Task whose choice also archives or deletes the Tasks under it is refused when one of those that is on the card changed. The check runs again right before each action, after the receipt is saved, and the at-once archive checks again that it still has nothing to warn about. The others go ahead, parents first, through `Tasks.archive` and `Tasks.delete`, each with a receipt. Cancel changes nothing. Delete cards list open pull requests as a warning; deleting leaves them open, as the app does.
- Archived Tasks can be deleted; only archive refuses an archived Task, and only unarchive refuses one that isn’t.
- The Coordinator isn’t woken when the human answers. It sees the receipts and the answered card the next time the human writes to it.

## Considered Options

- **Let the Coordinator confirm in its reply and act on the human’s typed “yes”.** Rejected: the Coordinator would decide what counts as consent, and a delete can’t be undone. Only a click on TED’s card deletes.
- **Refuse when a Task has children or blocks others, and make the human say what to do.** Rejected by the user in Clarify: the card offers the same choices as the app instead.
- **Keep confirmations only in the chat.** Rejected by the user: an unanswered card also waits in the Inbox.
- **Start a Coordinator turn when the human answers, so it reports at once.** Rejected: it costs a turn for every card, and the receipts already show the result.

## Consequences

- Archive and delete in the Coordinator chat use the same rules and side effects as the app’s buttons: archiving stops the Task’s Runs and removes its worktree; deleting can’t be undone.
- Confirmations live inside the stored Coordinator, so a new Coordinator conversation or removing the Factory removes them with it.
