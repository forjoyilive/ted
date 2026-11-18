# Stage queue priority and the busy-hold skip are Workflow settings

Status: accepted (TED-648). Amends ADR 0192-cleanup-skips-the-busy-hold-and-queued-labels-say-only-why and ADR 0030-one-queue-for-working-run-slots.

ADR 0192 hard-coded Cleanup: a Task in Cleanup skipped the busy hold and sorted with the continuations, ahead of new Tasks. A Task in Merge, with only a short Task Lead turn left, waited behind new work like any other. The user wanted Merge to go first too, and the choice of which Stages go first to be the Factory’s, in `workflow.yaml`.

**Two Stage keys.** `stages.<id>.priority` is a whole number, 0 or more; `stages.<id>.skip_busy_hold` is `true` or `false`. `workflow/check.ts` accepts both on every agent Stage, Cleanup and custom Stages included; Backlog still takes only `enabled`, and Done takes no settings. When a key is missing, `defaultStagePriority` and `skipsBusyHoldByDefault` in `packages/protocol/src/stage.ts` answer: Cleanup ranks 2 and skips the hold, Merge ranks 1, every other Stage ranks 0, and only Cleanup skips the hold. A Factory without the keys keeps Cleanup as it was; Merge now goes ahead of other Stages but still waits for the busy hold.

**Rank orders Tasks only.** `queueOrder` keeps setup Tasks, sub-agents, planning chats, Coordinators, Side chats, drafts and Automations ahead of Tasks. Within Tasks it sorts by `stageRank` (higher first), then continuations before new starts, then `recent`, then Task Priority, then rank. So a Low Task in Merge starts before an Urgent Task in Work. `skipsBusy` no longer moves a queued Task in with the continuations; the Stage rank does that job now. Rank never lets a Task past the busy hold, the working-Run limit, Factory caps, the disk hold or agent pauses.

**Where the settings are read.** The pump and the store’s `queue()` are synchronous; the Workflow resolves asynchronously. `remember` in `tasks/tasks.ts` already kept each Factory’s `max_working_runs` for the caps; it now also keeps the Factory’s `stages` settings, and `wake` drops both. `stageQueue` in `tasks/queue.ts` turns those settings and a Task’s Stage into `{ rank, skipsBusy }`, and `queuePlace` puts them on every Task entry: continuations, queued, held and revived Tasks. `fill` reads held and revived Tasks again after `slotUse` has loaded each Factory’s Workflow, and sorts them with the rest through `queueOrder` before `startsNow`, so a held or revived Task Lead no longer goes ahead of everything: it sorts as a continuation within its Stage’s rank, after setup Tasks, sub-agents, chats and Automations. The automatic Backlog start sorts the same list before adding its candidate last. Before a Factory’s Workflow is first loaded, the defaults apply. The store no longer reads `isCleanup` for the queue: the pump publishes `skipsBusy` with each Task’s place in `taskPlaces`, and the queued label (“Queued · computer is busy” or the place) reads it there.

## Considered Options

- **One on/off key** that both skips the busy hold and goes ahead. The user chose a rank, and a separate key for the busy hold.
- **Rank also skipping the hold** above some value. The user chose to keep the two apart: rank only decides what goes first.
- **Reading the Workflow in the store.** The store has no resolver and would need an async path.
- **Putting the defaults in the built-in `workflow.yaml`.** A Factory that overrides `stages.merge` would then have to restate them.
