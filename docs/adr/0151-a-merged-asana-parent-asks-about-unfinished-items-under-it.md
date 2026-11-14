# A merged Asana parent asks about unfinished items under it

ADR 0150 left a merged parent open in Asana for as long as any subtask was incomplete, and said nothing. That is right while a TED Task is carrying the subtask, but an item added in Asana after the import, an item the import skipped, or one whose Task was archived without merging would keep the parent open for ever without the user knowing why.

**What TED reads.** When a parent Task is Done and merged and may sync, and its item isn’t complete, the Asana connector (`advance` in `tasks/asana-sync.ts`) reads every level under the item with `readSubtree` in `tasks/asana-unfinished.ts`: 100 items and 10 levels like the import, at most 40 requests, no files or comments, from the cycle’s shared budget of 100 requests. The cap holds page by page: a list cut by it makes the tree over the limit. A parent starts its read only when more than 40 requests are left; while a parent that ran short is waiting, every parent read more recently than it steps aside, so the least recently read parent always goes next. It doesn’t go below an unfinished item that has a TED Task (open or Done) in the Factory, because that Task asks about its own subtree when it merges; it does go below a completed item, whose Task no longer looks. A list Asana refuses or doesn’t finish is unreadable; a tree past a limit counts as unreadable as a whole, while the items it did read with TED Tasks still make the parent wait.

**Wait or ask.** `planUnfinished` sorts the unfinished items. One with an open or Done TED Task makes the parent wait (`waiting-children`), with no question: each completes its own item when its work merges. Any other unfinished item (new, skipped, its Task archived) and anything unreadable goes into one question on the parent, an `asanaUnfinished` Comment recorded with `v1.CommentAsanaUnfinishedAsked`, with **Add them as Tasks** (only when an item can be imported), **Complete it in Asana anyway** and **Leave it open in Asana**. While it is open the parent’s Task Sync state is `needs-answer`.

**What an answer covers.** `coveredBy` reads the answered questions: Complete and Leave cover exactly the items listed, by key, and the latest answer for a key wins. Add imports the new items through the add-to-tree import as children of the Done parent (the one exception to “Done parents stay closed” in `docs/contracts/task-hierarchy.md`); an existing Task for an item under it stays where it is, never linked under the Done parent and covers nothing itself: what it imported now has Tasks, and what it couldn’t import is asked about again. `parentStep` then decides: any uncovered item asks (keeping an open question that already lists them, otherwise withdrawing it and posting a new one), any item with a TED Task waits, any item covered by Leave leaves the parent open (`left-open`, kept in memory like the waiting count), and otherwise TED completes the parent. When nothing uncovered is left, an open question is withdrawn. Nothing ever completes an item under the parent.

**Who answers.** Only the user. Autopilot (`ordinaryAutopilotRequest`) and the Coordinator (`coordinatorNeverAnswers`) leave it alone.

## Considered Options

- **Import the new items as top-level Tasks.** Rejected: the request asked for them under the parent, and the Asana tree is what the user sees.
- **Complete the parent at once on Complete anyway, even with TED Tasks still open under it.** Rejected: those Tasks will complete their own items, and the parent waiting for them keeps the usual order.
- **Stop watching after Leave it open.** Rejected: the request asks TED to ask again when a new unfinished item appears, so the parent stays watched until its item is complete.

## Consequences

A merged parent costs one subtask list per cycle while it waits on TED Tasks, more when items under it have no Task. After a restart the parent can show “waiting for merge” until the next cycle; an open question survives the restart because it is a Comment.
