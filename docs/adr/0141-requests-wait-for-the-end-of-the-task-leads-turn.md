# Requests wait for the end of the Task Lead’s turn

The Task thread lists items in the order they were posted. A Task Lead often posted a request (a design review, a sign-off, a question) and then the note explaining it, so the user read the Approve button before the explanation (TED-279). The user wanted the order right when things are posted, not reordered when the thread is drawn.

**A request posted during a turn is held until the turn ends.** `postComment` in the store commits `v1.RequestHeld { commentId, runId }` in the Comment’s own commit when the Comment is not a `note` or `permission`, was asked by a Run (its author, or the Run passed to `postFailureDecision` for `ted failure ask`), and that Run is `working`. `v1.RequestReleased { commentId, at }` clears the hold and sets the Comment’s `createdAt` to the release time, so the thread’s plain time order puts it after the turn’s notes.

- **Release:** `tasks/held-requests.ts`, owned by the Tasks module, releases a Run’s held requests when its turn ends (the `turnEnded` observer in `RunManager`, told whenever a batch of output holds an idle line, even if a queued message has already started the next turn) or it finishes, and every 10 seconds releases any whose Run isn’t working or that have been held for 5 minutes (`holdAtMostMs`). It also sweeps once at start, so a request held when the daemon stopped is posted after a restart.
- **While held**, a request is left out of `waiting()` (Inbox, badge, notifications), `listOpenRequests` (Autopilot, Coordinator lists, Linear team asks), a Task’s `openRequests` fact, the `GET /tasks/:id/comments` route and the Coordinator’s Task view, and no `comment-posted` or `comment-updated` event carries it. Autopilot’s answer guard and the Coordinator refuse it by ID, and `markRead` leaves it unread. TED’s own rules still read it as open, so the Task Lead can’t get past a pending question by posting it during a turn.
- `Comment.held` is set on a held Comment; the CLI tells the Task Lead its request will show when the turn ends. The preamble tells it to explain before posting a request.
- Requests TED posts on its own (the Merge sign-off, CI stuck, failure decisions TED raises) and permission and simulator asks, which block the Run, post at once.

## Considered Options

- **Reorder in the thread** (draw a note posted after its author’s request above it). Rejected by the user: the order should be right the first time.
- **Hold the request in memory only.** A restart would lose it, and Gate logic expects the Comment to exist.
- **Only instruct the Task Lead.** Agents forget; kept as a second measure.

## Consequences

- A request reaches the Inbox when the turn ends: usually seconds later, at most about 5 minutes.
- A note posted more than 5 minutes after its request in a long turn still lands below it.
- Threads from before this change keep their order.
- Most tests ask a request and wait for its answer within one stub turn, which holding would delay by 5 minutes. `TED_HOLD_REQUESTS_MS` (test-only, `0` in `vitest.config.ts`) sets the longest hold; a test about holding passes `startDaemon`’s `heldRequests: { maxMs: holdAtMostMs }` instead.
