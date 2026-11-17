# The daemon opens the store behind a data status, and backs it up as plain folders

Amended by ADR 0156-backups-hold-only-the-event-log-and-share-attachments: backups leave out the state database, attachment files share disk, and five daily backups are kept.

The daemon now listens and writes `daemon.json` before it opens the store, and `packages/daemon/src/data.ts` owns opening, backups and restore. Until the store is open, only `GET /events`, `GET /data-status`, `GET /backups` and `POST /backups/restore` answer; every other route waits while the store is opening and then answers `503` with the reason (“Ted is updating its data”, “Ted couldn’t update its data”, “This data needs Ted 1.4 or later”). Runs, Tasks and the Run manager start only once the store is open, so a long rebuild never blocks the app from showing progress, and Run hosts keep running on their own (ADR 0013). All four routes are closed to Run tokens. The app shows the full-window data screen for every status except `ready`, and remounts the normal window when the store opens again.

**When state rebuilds.** LiveStore names its state file after the state schema’s hash and rebuilds it from the event log when no complete file for the current hash exists. Before opening, `store/files.ts` reads the files with `node:sqlite` (read-only) to predict that: an event log with events and no complete `state<hash>@*.db` means a rebuild. Only then does the daemon copy the event log and `ted-store.json` to a pre-update backup, show progress, and after a successful open delete state files for other hashes. If the copy fails, it doesn’t rebuild. Progress comes from counting materializer calls (`store/progress.ts`), because the single-threaded Node adapter doesn’t pass LiveStore’s boot progress on.

**Newer data.** If the event log holds any event name this Ted doesn’t define, the store was written by a newer Ted and stays closed. `store/ted-store.json` records the last Ted version that opened the store (`lastOpenedBy`), which the screen names. Checking event names, rather than a format number someone must remember to bump, catches every new event automatically.

**Backups** live in `TED_HOME/backups/<kind>-<local date[-time]>/`, each a `backup.json` (kind, `takenAt`, `takenBy`, `dataFrom`) beside a `store/` folder laid out like `TED_HOME/store/`, so a restore swaps that folder in. Kinds and how many are kept: `pre-update` 3, `daily` 5, `before-restore` 3 (the spec doesn’t give a number for the last). A daily backup holds only the event log, exported through LiveStore’s leader (`getEventlogData`) so it is a consistent copy while the store is open, plus the list of attachment hashes; attachment files from `TED_HOME/attachments/` (ADR 0022) are shared once into `backups/attachments/<hash><ext>` (a clone or hard link, ADR 0156) and deleted when no daily backup lists them. The daemon takes the daily backup when the store opens and checks every hour; a failure raises the warning banner “Today’s backup failed: <reason>” (problem `daily-backup-failed`, ADR 0021) and the next successful backup clears it.

**Restore** (`ted backup restore <name>`, or the button on a data screen) refuses with `409` while Runs are running unless the request says `stopRuns`; the CLI asks first, or takes `--yes`. It stops those Runs, closes the store, saves the current event log and `ted-store.json` as a `before-restore` backup, swaps in the backup’s `store/`, and opens again without another pre-update copy. From a data screen the store isn’t open, so no Runs are stopped; a Run started after the backup keeps running but the restored store doesn’t know it.

## Considered Options

- **LiveStore’s worker adapter**, which does forward boot progress. It needs a separate worker entry file and changes how the store runs (ADR 0010) for one progress bar. Counting materializer calls gives the same numbers.
- **Copying the live event log file for daily backups.** LiveStore’s WASM SQLite takes no OS locks, so a file copy can catch a half-written transaction. The leader’s export is taken in-process.
- **A store format number bumped by hand.** Easy to forget, and a missed bump silently drops events a newer Ted wrote.

## Consequences

- A new kind of change to the store needs nothing extra: new events or state tables are picked up by the checks above.
- Restoring the backup from before a failed update gives the older Ted back its data; the updated Ted will fail the same rebuild again until it is fixed.
- The Download Ted button opens a fixed URL in `@ted/protocol` (`downloadUrl`); KRI-122 and KRI-123 should replace it with the real download page.
