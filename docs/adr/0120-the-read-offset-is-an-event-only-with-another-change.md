# The read offset is an event only when something else changes

This amends ADR 0097-run-output-lives-in-host-log.

ADR 0097 commits one `v3.RunOutputRead` event for every batch of output the daemon reads from a Run’s `host.log`. On one machine, after a few days, 161,398 of the event log’s 195,265 events were `RunOutputRead` events, about 134 per Run. Each release that changes the state schema replays all of them.

Most of those events say only “read a little further”. The offset matters to the store when the lines led to something the store records.

- **`store.recordRunOutput` commits `v3.RunOutputRead` only with another event.** When the batch changes the Run’s state, session, problem, retrying flag or ending, finds auto mode unavailable, or asks or withdraws a permission Comment, the offset is committed in the same commit as before. Otherwise nothing is committed and it returns `false`.
- **The store holds the newer offset in memory.** `runReadOffset` and `lastOutputAt` answer with the held value, so the Conversation, the stall check and everything else that reads them see every line at once. The next commit for that Run carries the held offset and last output time and clears the held value. A Run’s ending always commits, so a finished Run’s offset is in the event log.
- **The Run’s folder holds it across a restart.** After a batch that commits nothing, `RunManager` writes `{ from, toOffset, lastOutputAt }` to `runs/<run-id>/read-offset.json`, where `from` is the offset of the Run’s last committed `RunOutputRead`. It writes a temporary file created exclusively, then renames it, mode `0600`. When it starts following a Run it opens that file without following a link, takes it only if it is a regular file of at most 1 KB, and gives it to the store with `holdRunOutput`. The store uses it only when `from` equals the offset it loaded for the Run and `toOffset` is past it and not past the end of `host.log`; then reading goes on from `toOffset`. Anything else means reading on from the store’s offset.
- **The file only extends an offset the event log holds.** The lines between `from` and `toOffset` led to no event, so skipping them after a restart loses nothing the store records. If the commit at `from` never reached the event log (a crash before it was saved) or the store was restored from an older backup, the loaded offset differs from `from`, the file is ignored and the lines are derived again. A daemon killed after reading a batch and before the file is written derives that batch again, as ADR 0097 already allowed.

## Considered Options

- **Commit the offset at most every few seconds.** It still writes an event per Run every few seconds for hours, and output read since the last commit would be derived again after any restart.
- **Rewrite the old `RunOutputRead` events down to one per Run.** Shipped events are not rewritten (ADR 0010); the one exception is ADR 0099’s compaction. Old events stay, and only new growth stops.

## Consequences

- An event log grows with what Runs do (state changes, permission prompts, endings), not with how much they print.
- The state database’s `runs.readOffset` can be behind what the daemon has read while a Run is live. Read it only through `store.runReadOffset`.
- A process that can write a Run’s folder can make TED skip output by writing a larger offset. It can already write `host.log` itself, so this gives it nothing new.
