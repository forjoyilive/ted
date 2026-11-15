# LiveStore’s changeset rows are emptied when the store opens

LiveStore writes one row to `__livestore_session_changeset` in the state database for every event it applies: the SQLite session changeset that undoes it. Nothing in TED trims the table. On one machine it held 87,818 rows taking 178 MB of a 272 MB state database, and it grows by about 27 MB a day.

This changes only the state database, which is derived from the event log. No event is touched, so ADR 0010 stands.

## Why the rows can go

From LiveStore 0.5.0’s source (`@livestore/common`):

- `rollback` in `leader-thread/materialize-event.ts` reads the rows to undo events, and only `LeaderSyncProcessor` calls it, when a pull from the sync backend rebases local events. LiveStore’s own trim (`trimChangesetRows`) deletes rows below the backend head in the same pull handler, so it never runs either.
- `getEventsSince` in `leader-thread/eventlog.ts` reads them at boot to attach a changeset to each pending event. A missing row becomes `unset`, which the client session treats like no changeset.
- The client session’s own rollback uses changesets it made itself, in memory, not these rows.

TED opens LiveStore with `makeAdapter` and file storage only (`packages/daemon/src/store/index.ts`), with no sync backend, so no rebase and no rollback can happen.

## What TED does

`trimChangesets` in `packages/daemon/src/store/trim-changesets.ts`, called by `data.ts` before `openStore`, while the store is closed and only when `checkStore` says `current` and no output drop is about to rebuild the state. When the table and its index take 20 MB or more (read from SQLite’s `dbstat`), it deletes every row and runs `VACUUM`. It never drops the table: LiveStore would then treat the state as incomplete and rebuild it.

It runs at every such open, not once per home, because the table refills as new events commit and a state rebuild writes a row back for every event. A failure is logged through `redactSecrets` and the store opens as before; a failed `VACUUM` leaves free pages in the file and no other harm.

Measured on a copy of that machine’s store, rebuilt with the current schema: the delete and `VACUUM` took 463 ms and left a 91 MB file. The store then opened as `current`, every state table matched row for row, a new Task committed and was there after a reopen. Because the boot read loads every event since the backend head (all of them, with no backend) together with its changeset, the daemon’s memory just after opening fell from about 1,830 MB to 1,110 MB. At under a second the step needs no progress on the data screen.

## Considered Options

- **Drop the table.** LiveStore then rebuilds the state on every open.
- **Delete rows while the store is open.** LiveStore holds the database and keeps its own view of the table; changing it from outside while the leader runs isn’t safe.
- **Once per home, with a marker.** A rebuild writes every row back, so the space returns.
- **No size limit.** The `VACUUM` costs about half a second for a 90 MB file at every open; 20 MB keeps it to opens where it frees space worth having.

## Consequences

- Revisit this before TED adds a sync backend or upgrades LiveStore: with a backend the rows are needed for rebases, and a new LiveStore version may read them elsewhere.
- Between opens the table grows as before; the space comes back at the next open of the daemon.
