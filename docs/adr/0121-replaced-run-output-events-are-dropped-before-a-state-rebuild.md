# Replaced Run output events are dropped before a state rebuild

This is a second deliberate exception to “a shipped event is never edited” (ADR 0010), after ADR 0099-old-run-output-events-are-compacted-once. It follows ADR 0120-the-read-offset-is-an-event-only-with-another-change.

Until ADR 0120 every batch of a Run’s output committed one `RunOutputRead` event. On one machine 163,151 of 199,379 events were `RunOutputRead` events that a later one for the same Run replaced. A release that changes the state schema rebuilds the state database by replaying every event, so each of them was replayed and thrown away.

A `v1`, `v2` or `v3.RunOutputRead` event only sets `runs.readOffset` and, when it carries an output time, `runs.lastOutputAt`. No materializer reads either column. So for each Run only two of these events decide the rebuilt state: its last one, and the last one that carries an output time.

## What is dropped

`dropSupersededOutput` in `packages/daemon/src/store/drop-output.ts` deletes every `RunOutputRead` event of the shipped shape except, for each Run, its last and the last that carries an output time. An event it can’t read as the shipped shape stays. The events left are renumbered 1, 2, 3… from the log’s first number, each pointing at the one before, so the log is again one unbroken chain. Nothing else in a kept event changes.

## When it runs

Only in `data.ts`, with the store closed, when the state database is about to be rebuilt from the event log and a pre-update backup of this version exists. That is the only time the event count costs anything, and the rebuild then builds the state from the new log, so no state database ever holds numbers from the old one. It does nothing when fewer than 1,000 events would go, or when the log isn’t one client’s unbroken chain.

## Why it is safe

- It works on a copy of the event log. The copy replaces the original, by a rename, only after it passes verification. Any failure deletes the copy and the store opens from the original log.
- Verification attaches the original and checks: SQLite’s integrity check; the same settings, tables, indexes and other tables’ rows; the copy is one chain starting at the original’s first number; walking both logs in order, every event of the copy is the original’s next event with the same name, arguments, client, session, schema hash and sync metadata, and every original event passed over is a readable `RunOutputRead`; the number passed over is the number dropped; and each Run’s final read offset and last output time, worked out the way the materializers do, are the same in both.
- The current state files are removed before the rename. A crash between the two leaves the original log and no state, which rebuilds as before.
- The pre-update backup holds the original log.

## Considered Options

- **Leave gaps in the numbering.** LiveStore’s rebuild reads events in order and doesn’t follow the parent numbers, but other code paths look a parent up, so the chain is kept whole.
- **Run it once, behind a marker, like ADR 0099.** It would force a rebuild only to save a later one time. Running it before a rebuild that is happening anyway costs about two seconds on the log above.
- **Verify by rebuilding the state from both logs and comparing.** It doubles the rebuild. The event walk and the per-Run comparison check the same thing from the events.

## Consequences

- An event’s sequence number is not stable across this pass. The state database derives Task log and interval boundary IDs from it (`withTaskLog`, `withIntervalBoundaries`), so a thread event’s ID changes when the state is rebuilt after the pass; their order doesn’t. Those IDs are used only to order rows and as list keys. Never store one in an event or outside the state database.
- The pass keeps working for homes that still gain `RunOutputRead` events from an older TED, and finds nothing to do once ADR 0120 has been in use.
- Any further rewrite of shipped events needs its own decision.
