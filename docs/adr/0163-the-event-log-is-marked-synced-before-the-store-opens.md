# The event log is marked synced before the store opens

LiveStore keeps every event above the sync backend’s head in memory, as events still to be pushed. Ted has no sync backend, so the head stayed at 0 and the daemon held every event it had ever committed: on one machine 91,637 events, about 250 MB of JavaScript heap, read again at every start. The engine also lets its heap grow in proportion to what is live, so the daemon’s footprint was higher still.

This changes one number in a LiveStore table in the event log file. No event is touched, so ADR 0010 stands.

## How LiveStore uses the head

From LiveStore 0.5.0’s source (`@livestore/common`):

- `getInitialSyncState` in `leader-thread/make-leader-thread-layer.js` reads `head` from the one row of `__livestore_sync_status` and the newest event’s number, and loads every event above the head with `getEventsSince` as the leader’s `pending` list. It refuses to start when the head is above the newest event.
- Only a pull from a sync backend moves the head (`updateBackendHead`), and only a push to one sends `pending`.
- A state rebuild reads the event log itself, not `pending`.

## What Ted does

`markEventsSynced` in `packages/daemon/src/store/sync-head.ts`, called by `openStore` before LiveStore starts, while the store is closed. It sets `head` to the newest event’s `seqNumGlobal`, up or down. Down matters: `store/drop-output.ts` renumbers the events into a shorter chain, and a restored backup can be older than the head. A failure is logged through `redactSecrets` and the store opens as before, with every event in memory.

Events committed after the open still collect in `pending` until the next open.

Measured on a copy of that machine’s store, opened through `createData` with no services, as the memory footprint macOS reports:

| Case | Before | With ADR 0156’s trim after a rebuild and narrower Run queries | With this too |
| --- | --- | --- | --- |
| Ordinary restart | 1.1 GB | 0.92 GB | 0.6 GB |
| First start after an update (a rebuild) | 2.2 GB | 1.6 GB | 1.5 GB |

The JavaScript heap after the open fell from 500 MB to 91 MB. The store then saved a Task, reopened and rebuilt from the event log with the same Tasks and Runs.

## Considered Options

- **Leave the head alone.** The daemon holds every event twice over and the figure grows with the event log.
- **Set it once per home.** Each session’s events would stay above the head for good.
- **Set it from `data.ts`.** Tests and scripts that call `openStore` directly would skip it, and one that shortened the event log would then fail to open.

## Consequences

- Revisit this before Ted adds a sync backend or upgrades LiveStore: with a backend, events at or below the head are never pushed, and a new LiveStore version may read the row differently. ADR 0156 has the same condition.
- After a rebuild the daemon still holds memory the rebuild used once, until it restarts. Rebuilding in a separate process would remove it.
