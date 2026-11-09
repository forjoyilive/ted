# The disk watch holds new work, and Storage deletes only inside TED’s folders

`packages/daemon/src/disk.ts` watches free space on the volume that holds `TED_HOME`, once a minute and once before the Tasks module starts. Below 10 GB it raises the `disk-almost-full` warning; below 2 GB it holds new work and raises the `disk-full` stops-work banner instead; the hold lifts only above 4 GB, so a disk hovering at 2 GB doesn’t flap. Both banners open Settings → Storage. The hold is not an event: `TedStore.holdNewWork('disk full')` keeps it in memory, every queued Task then carries `TaskFacts.queue = { hold: 'disk full' }` (“Queued · disk full”), and the queue pump in `tasks/tasks.ts` starts nothing while it is set, including held Task Leads. Running Runs carry on. `POST /dev/runs` answers 507. When the hold lifts, the disk watch calls `Tasks.wake()` so the pump starts what waited.

**A store write that fails.** `openStore` sends every commit through one wrapper. A commit that throws a disk-full error (`ENOSPC`, `SQLITE_FULL`, “database or disk is full”) tells the disk watch, which raises “TED can’t save changes: disk full”. That banner can’t be saved in the store, so it is an unsaved banner (`Banners.raiseUnsaved`): kept in memory, listed and sent to clients like the others. While it is up the server refuses every request that isn’t a `GET` or a `/storage/` cleanup with 507. The next successful commit, or a 1 MB test write into the store folder on the next check, clears it.

**Retention.** `packages/daemon/src/retention.ts` prunes raw Run output (`runs/<id>/`) at start and every 6 hours: a Run folder is deleted 14 days after its `host.log` was last written, and a finished Run’s `host.log` over 100 MB keeps only its newest whole lines. It skips live Runs (by the store, and by the host’s lock), any name that isn’t a Run id, and anything that isn’t a real folder.

**Time Machine.** On macOS the daemon runs `tmutil addexclusion` (no `-p`, so no admin rights) on `worktrees/`, `repos/`, `simulators/` and `scratch/` at start. The store and backups stay included.

**Storage.** `GET /storage` measures each category by walking its folders with `lstat` (allocated blocks, each inode once, links never followed). `POST /storage/remove-clones` deletes `repos/<owner>/<repo>` folders that no Factory and no unremoved Task repo uses and that aren’t being cloned right now, after checking that the real path is still that folder under `repos/`. Both routes are closed to Run tokens.

## Considered Options

- **Recording the hold as an event.** Free space is measured again at every start, so a stored hold would only go stale; the agent pause (ADR 0033) is stored because it has to survive a restart while the human fixes it.
- **Trimming a live Run’s `host.log`.** The host appends through an open descriptor and the daemon reads it by byte offset (ADR 0013), so the file can’t be shortened under them. A live Run’s output is pruned once it stops.
- **`du` for sizes.** Its flags and output differ between macOS and Linux; a walk in Node gives the same numbers on both.

## Consequences

- Apps, simulators, Automations and Planning Runs don’t exist yet. When they do, their starts must check `store.newWorkHold()` (or go through the queue), Automation firings held by a full disk make up once, App logs keep their last 10 MB, and **Erase simulators not used by a running Task** gets its route. Until then that button is disabled with “No simulators”.
- LiveStore persists in its leader thread; a failure there that never reaches `commit` is caught only by the test write.
