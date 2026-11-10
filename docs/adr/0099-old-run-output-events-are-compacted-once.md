# Old Run output events are rewritten once to drop their lines

This is a deliberate, one-time exception to “a shipped event is never edited” (ADR 0010). It follows ADR 0097.

Since ADR 0097 a Run’s output lives in `host.log`, and nothing reads the `entries` of `v1.RunOutputRead` and `v2.RunOutputRead` events: their materializers set `runs.readOffset` from `toOffset`, and `v2` also sets `runs.lastOutputAt` from the last entry’s `at`. The lines were still in the event log. On one machine the log was 660 MB, 564 MB of it the arguments of 60,360 `v2.RunOutputRead` events. LiveStore reads every event into memory when the store opens, because with no sync backend every event counts as not yet pushed (`getInitialSyncState` in its `make-leader-thread-layer.ts`), so each open took 3.6 seconds and 2.7 GB of memory, and each daily backup exported the whole file.

## What is rewritten

Only the `argsJson` of `v1.RunOutputRead` and `v2.RunOutputRead` rows. A `v1` event keeps `runId` and `toOffset` and gets `entries: []`. A `v2` event keeps `runId` and `toOffset`, and its `entries` become the last entry alone, as `{ offset, line: "", at }`, or stay empty. An event that isn’t exactly the shipped shape, or wouldn’t get shorter, is left as it is. No row is added or deleted, and no other column changes, so sequence numbers, parent pointers, `schemaHash`, `syncMetadataJson` and the sync status table stay as LiveStore wrote them. The event definitions and materializers don’t change.

## Why it is safe

- LiveStore 0.5.0 keeps no checksum or hash chain over events. `schemaHash` is the hash of the event definition’s schema, not of the arguments, and a mismatch only logs a warning (`rematerialize-from-eventlog.ts`). A rebuild decodes each row’s arguments with the event’s schema, and the rewritten arguments decode.
- The materializers read only the fields that are kept, so a rebuild gives the same state. On a clone of the store above, a rebuild from the compacted log and a rebuild from the original gave the same rows in all 57 state tables, LiveStore’s session changesets included; only the `updatedAt` column of `__livestore_schema` and `__livestore_schema_event_defs` differed, which is the time of the rebuild.
- TED 0.1.6 reads a compacted log: it opened one, and rebuilt the same state from it. It rewrites `ted-store.json` without the marker; the next newer TED finds nothing to compact and writes the marker again.

Deleting the old events was rejected: it leaves gaps in the sequence numbers and parent pointers and loses a Run’s `readOffset` and `lastOutputAt` unless other events are changed to carry them. Exporting everything into a fresh log was rejected because TED would have to recreate LiveStore’s tables itself.

## How it runs

`packages/daemon/src/store/compact.ts` does the rewrite and `data.ts` decides when, with the store closed, on the first open by a TED that has this change:

1. Nothing happens when `store/ted-store.json` has `outputCompaction` with `state: "done"`, or `state: "failed"` from this same version; when the event log holds events this TED doesn’t know (ADR 0026); or on the open that follows a restore, which waits for the next start.
2. If no old output event would get shorter, the marker is written and nothing else happens. A new home gets the marker on its first open.
3. A pre-update backup must exist: the one this open took for a rebuild, or a new one. If it can’t be taken, the log stays as it is, nothing is marked, and the next start tries again.
4. The event log is copied to `eventlog@<n>.db.compacting` beside it (a clone where the file system can), the rows are rewritten in the copy, and the copy is vacuumed.
5. The copy is verified against the original: SQLite’s integrity check passes; page size, `user_version`, encoding and `auto_vacuum` are the same; tables and indexes are the same; every other table has the same rows; the count of events per name is the same; every event other than old output is the same in every column; every old output event is the same in every other column and has the same `runId`, `toOffset` and last `at`; and every rewritten event decodes with its event’s schema.
6. Only then is the copy flushed and renamed over the event log, and the marker written with the number of events rewritten and the sizes before and after.

A crash before the rename leaves the original file and no marker, so the next start begins again; a crash after it leaves a compacted log, and the next start finds nothing to do. If any step fails, the copy is deleted, the reason is logged, `outputCompaction` records `state: "failed"` with this version, and the store opens as it was. That version doesn’t try again, so a failure can’t fill `backups/` with a copy per start; the next version does.

The data screen shows “Updating TED’s data…” with the count of events while this runs. On the store above it rewrote 59,873 events, the log went from 660 MB to 54 MB, and the open that compacted took 6 seconds; later opens take about 1.5 seconds and 1.0 GB of memory.

## Consequences

- The lines of Run output that an older TED stored are gone from the event log. They are still in the pre-update backup until three newer pre-update backups replace it, and in each Run’s `host.log` while retention keeps it.
- Restoring a backup from before the compaction brings the old log back; the next start compacts it again, after a new backup.
- A TED older than 0.1.6 that rebuilt from a compacted log would show one empty line per old output event. It can’t open a store 0.1.6 has written output to anyway, because it doesn’t know `v3.RunOutputRead`.
- This is not a pattern for other events. Another rewrite of shipped events needs its own decision.
