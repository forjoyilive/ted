# An Inbox request can be snoozed, and it returns through a commit

Every open request stayed in the Inbox and in the waiting count until it was answered. A sign-off the human wants to look at tomorrow sat among the ones they can answer now (KRI-346). The human can now hide one request until a time they pick.

- **One table for every kind of request.** `v1.RequestSnoozed { requestId, ownerId, factoryId, until, at }` writes a `requestSnoozes` row and `v1.RequestSnoozeCleared { requestId, at }` deletes it. `ownerId` is the Task, plan or Automation the request belongs to. Task Comments, Planning requests and Automation questions share the table because `TedStore.waiting()` already lists them as one kind of thing by ID.
- **The waiting list leaves snoozed requests out.** The sidebar count, the Dock badge, the menu-bar count and notifications all read `waiting()`, so none of them changed. `TedStore.snoozed()` lists the snoozed ones with their return times, and `inbox-changed` carries both lists.
- **A request returns through a commit.** The snooze timer in the Tasks module (the one that already starts due Backlog Tasks, with the same `snoozes.now` and `checkEveryMs` options) calls `store.returnDueRequests(now)` every 30 seconds and once at start. It commits `v1.RequestSnoozeCleared` for each due row. The waiting list is worked out again after that commit, so `inbox-changed` fires and the app notifies the returned request as new, because it was not in the list the app saw last.
- **Answering ends the snooze.** The materializers of `v1.CommentAnswered`, `v1.PlanRequestAnswered` and `v1.AutomationCommentAnswered` delete the row, which covers an answer, a withdrawal, a replacement and an archive. Deleting the Task, plan, Automation or Factory deletes its rows.
- **The Task still waits.** A snoozed request stays open in its thread and can be answered there. When every open request of a Task is snoozed, `TaskFacts.requestsSnoozedUntil` holds the first return time and the status is `{ kind: 'waiting-on-you', snoozedUntil }`, drawn as “Snoozed until <time>” in grey.
- **Only the human snoozes.** `PUT /requests/:id/snooze` sets neither `runToken` nor `fileToken`. The Coordinator has no snooze action.
- **Preset times** come from `requestSnoozePresets(now, timeZone)` in `packages/protocol/src/time.ts`: an hour from now, and 9:00 in Ted’s app-wide timezone tomorrow, on the coming Monday (on a Monday, the one after) and on the same date next month (or that month’s last day).

## Considered Options

- **Hide snoozed requests by comparing the clock in `waiting()`.** No timer commit, but nothing would recompute the count or notify when the time passes, and a read would depend on the clock.
- **A new Task status kind.** Every grouping, filter and scenario that knows the status kinds would need a new case, and the Task is still waiting on the human. A field on Waiting on you changes only the label.
- **A module of its own with its own timer.** The Tasks module already runs a snooze timer that holds the idle exit and takes a test clock. A second one would repeat it.

## Consequences

- A snoozed permission request keeps its Run waiting until the human answers it or it returns.
- A pending request snooze keeps Ted running in the background, like a snoozed Backlog Task.
- Snoozing and returning add no line to the Task thread.
- The Snooze line shows on a Task request’s card. Planning and Automation requests are snoozed from their Inbox row only.
- A request can return up to 30 seconds after its time.
