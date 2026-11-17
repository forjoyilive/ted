# Text that a later event replaces is blanked once in four kinds of old event

This is a third, one-time exception to “a shipped event is never edited” (ADR 0010), after ADR 0099 and ADR 0122. Both say a further rewrite needs its own decision; this is that decision, for four kinds of event only.

Four kinds of event carry text that no rebuild needs, because a later event replaces or deletes the row they wrote:

- `v1.SubAgentRequested.prompt`: the request row is deleted when its Run starts or the request is dropped.
- `v1.CoordinatorChanged.data`: each one replaces the Factory’s whole Coordinator row.
- `v1.WorkflowLayerAccepted.files`: each one replaces the layer’s whole row.
- `v2.TaskDraftSaved.draft`: each one replaces the Factory’s whole draft row.

ADR 0157 and the source changes before it stopped most of these writes, but the old events stay. On a copy of a real home the four kinds were 10,600 events and 45 MB of a 154 MB event log, and every pre-update and daily backup copies the log.

## What is blanked

Only the one text field, and only where a later event makes it unread:

- A `v1.SubAgentRequested` prompt becomes `""` when a later `v4.RunStarted` or `v1.SubAgentRequestDropped` has the same ID. Both delete the `subAgentRequests` row, and `v4.RunStarted` holds its own copy of the prompt. A request still queued keeps its prompt. A Run started by `v5.RunStarted` doesn’t count: since ADR 0157 a sub-agent’s instructions are read through its request, so only a request whose Run started under the old event is blanked. `v2.SubAgentRequested` is never touched, because it fills `subAgentInstructions`, which `v5.RunStarted` points at.
- `v1.CoordinatorChanged.data` becomes `"{}"` in every one but the last per Factory.
- `v1.WorkflowLayerAccepted.files` becomes `"{}"` in every one but the last per layer.
- `v2.TaskDraftSaved.draft` becomes `"{}"` in every one but the last per Factory.

The three JSON fields become `"{}"` rather than `""` because a `v2.CoordinatorChanged` between two `v1.CoordinatorChanged` events parses the row it patches. The blanked value only ever stands in a row that a later event replaces.

No row is added or deleted and no other column changes, so sequence numbers stay as they are and the state is not rebuilt. The event definitions and materializers don’t change. Old Run-start prompts and old Task briefs are out of scope: the state keeps them.

## Why it is safe

- Every reader of these events goes through the materializers, apart from the interval boundaries (`interval-schema.ts`), which read a sub-agent request’s `id`, `taskId`, `agent` and `at` and never its prompt.
- The last event of each group is untouched, and every earlier one is replaced whole by it, so a rebuild ends with the same rows. On the copy of a real home, states rebuilt from the original and from the blanked log had the same rows in all 79 state tables; only the observation sessions the two opens themselves recorded differed.
- It reuses ADR 0099’s steps and checks (`store/rewrite-eventlog.ts`), and adds one: from the original log, Ted works out again which events a later one replaces, and refuses the copy if any other event changed.

## How it runs

`packages/daemon/src/store/blank-replaced.ts` does the rewrite and `data.ts` decides when, with the store closed, right after ADR 0099’s compaction:

1. Nothing happens when `store/ted-store.json` has `replacedText` with `state: "done"`, or `state: "failed"` from this same version; when the event log holds events this Ted doesn’t know; or on the open that follows a restore. A new home gets the marker on its first open.
2. If no event would be blanked, the marker is written and nothing else happens.
3. A pre-update backup must exist from this same open: one the rebuild or the compaction took, or a new one. If it can’t be taken, the log stays as it is, nothing is marked, and the next start tries again.
4. The store folder, its `ted` folder and the event log must be a plain folder, folder and file, not links, with the log’s real path inside the store folder; otherwise the pass fails and nothing is touched. Compaction shares this check. The event log is then cloned to `eventlog@<n>.db.blanking`, the fields are blanked in the clone, and the clone is vacuumed.
5. The clone is verified against the original: SQLite’s integrity check; the same settings, tables, indexes and other tables’ rows; the same count of events per name; every event of another kind the same in every column; every event of the four kinds the same in every column and in every field but the blanked one, which is either unchanged or exactly the blank value; every one still decodes with its event’s schema; and every changed event is one that a later event replaces.
6. Only then is the clone flushed and renamed over the event log, and the marker written with the number blanked and the sizes before and after.

Any failure deletes the clone, logs the reason, records `state: "failed"` with this version and opens the store as it was; that version doesn’t try again.

On the copy of a real home it blanked 10,583 events in 2.2 seconds, and the event log went from 154.0 MB to 107.7 MB. Opening the store took about the same time before and after.

## Consequences

- The replaced text is gone from the event log. It is still in the pre-update backup taken before the pass until three newer ones replace it.
- Restoring an older backup brings the text back; the next start blanks it again, after a new backup.
- This is not a pattern for other events. It holds for these four because a later event replaces each one’s row whole and nothing reads the old text. Any further rewrite of shipped events needs its own decision.
