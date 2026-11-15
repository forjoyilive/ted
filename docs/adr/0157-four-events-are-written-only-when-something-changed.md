# Four events are written only when something changed

Status: accepted (TED-357)

A real home’s event log grew by several megabytes a day from four events that mostly repeated what the store already held. Measured on a backup of the installed TED, 10–13 November 2026, per day: `v1.WorkflowLayerAccepted` 70–90 events and 0.8–1.6 MB, `v2.TaskDraftSaved` up to 4,648 events and 2.9 MB, `v1.CoordinatorChanged` 120–280 events and 2.6 MB, `v1.TaskWaitObserved` 1,700–2,300 events and 0.2–0.3 MB. No shipped event is edited (ADR 0010); each fix changes when an event is written, and the Coordinator gets a new versioned event.

**A Factory layer is accepted again only when its files change.** `choose` in `workflow/workflows.ts` compares the layer’s files with the stored last valid copy and writes `v1.WorkflowLayerAccepted` only when they differ. The stored version stays the commit SHA: it is now the first commit that had those files, which the Factory settings notice shows with its commit date. Stage entries still record the current commit. The Library layer is unchanged; its version is already a content hash.

**The New Task dialog saves after typing stops.** `taskDraftSession` in `renderer/task-draft.ts` still writes the local recovery copy on every change, so nothing typed is lost, but sends the daemon save 1 second after the last change (`saveAfterMs`). Close, Create, a Factory change and unmounting the dialog flush it at once; consuming a revision drops a save still waiting for it.

**`v2.CoordinatorChanged` carries only what changed.** `store.coordinators.save` keeps the newest 100 receipts (`receiptsKept`), compares the new Coordinator with the stored one through `coordinatorChange` in `store/coordinator-change.ts`, and commits nothing when they are equal. Otherwise the event holds the changed top-level fields (`set`), the removed ones (`unset`) and, for `receipts` and `taskIds`, only the items added or changed with the list’s new length (`lists`). Its materializer reads the stored row and applies the change with `applyCoordinatorChange`; when applying the list change wouldn’t give the new list exactly, the whole list goes in `set`. `v1.CoordinatorChanged` still materializes as a full snapshot, and Continue still writes one (ADR 0142). Replaying all 551 snapshots of the measured log through the new code rebuilt every Coordinator exactly. What remains large is the `launch` prompt, written a few times a day.

**No empty wait observation at start.** Wait intervals are scoped to each observation session (`task-intervals.ts`), and every session starts with nothing waiting. `noteTaskWait` in `store/index.ts` therefore treats a Task it hasn’t observed in this session as `[]`, so start-up writes `v1.TaskWaitObserved` only for Tasks that are waiting. The only effect on timing is that a session ended by a crash with no other boundary is known to end at its start instead of a few milliseconds later.

## Considered options

- **Version the Factory layer by a content hash.** Rejected: the Factory settings notice reads the stored version as a commit for its date, and comparing files gives the same saving.
- **Debounce in the daemon.** Rejected: the route answers after the event log saves (ADR 0053), and only the app knows when the dialog closes.
- **Store Coordinator receipts in their own table.** Rejected for now: a larger change to `coordinators.ts`; the capped, added-only list gives most of the saving.
