# Asana items follow their Tasks through Task Sync

A Task imported from Asana should tell its Asana item about the work: which pull requests carry it, and when it is finished. ADR 0147 made the shared tracker sync for this; Asana is its second connector. In the app the feature is called Task Sync.

**What TED writes.** One comment per pull request, “TED opened a pull request for this task: <title> (<repo>#<number>) <URL>”, where the title is the Task’s title, which TED gives the pull request,, in the cycle after TED opens it, and the item’s completion once TED has confirmed every pull request of that Task merged. These are the only two writes, `comment` and `complete` in `asana/asana.ts`: fixed `/tasks/<digits>` paths, a JSON body, `opt_fields=gid` so the reply stays small, redirects refused, the reply size-capped, and the token sent only to the Asana API origin. TED never moves sections, sets custom fields, reopens an item or completes one for a Task archived without merging. A parent whose Asana item has any incomplete subtask, imported or not, stays open; TED reads its subtasks each cycle and completes it once none is open; ADR 0151 makes it ask about unfinished items no TED Task is carrying. An item someone already completed gets its links and nothing else.

**No link twice.** Before posting, TED always reads the item’s comments and skips a URL already there, matched as a whole link. One rule covers a reply lost after Asana saved the comment and a restart before TED recorded it. It costs one read per new pull request; an item with more than 500 comments is never commented on, rather than risk a repeat.

**Permission is tied to an account.** `v1.TrackerSyncAllowed` carries the connected account’s gid. An import made in the app records it for each Task it creates, in the same commit; the command line, Runs and Automations never do. Any other Task gets it from **Sync with Asana** in the Task menu (`POST /tasks/:id/asana-sync`, app only), which reads the connected account first and refuses while Asana isn’t connected. Each write names the account it is for, and `asana.ts` refuses it when the token in hand belongs to another, so a reconnect in the middle of a cycle can’t send anything as the new account. Permission counts only while that account is connected: disconnected, nothing is sent and work that comes due waits; another account, the Task shows that it is paused until it is allowed again. One `asanaSync` machine setting, on by default, stops every Asana read and write.

**The Task shows its state.** The store keeps two things in memory, the connected account (from each sync cycle, the allow route and every Asana settings route’s status) and the count of open items under a merged parent, and builds `asanaSync` on the Task with `asanaSyncOf` in `packages/protocol/src/asana-sync.ts`: not allowed, off, disconnected, another account, waiting for merge, waiting for items under it, completed by TED, completed in Asana, or archived. The app draws it as the Task Sync row in the Task’s details.

**Bounded requests.** A cycle runs every minute and sends at most 100 requests: at most half go to reading items, starting where the last cycle stopped, and the rest to subtasks, comments and writes. A connector that runs out of requests, or gets `Retry-After`, throws `TrackerWait`, which ends the cycle and puts off the next one for that long. `retryAfterMs` in `asana.ts` reads the header in seconds or as a date and keeps the delay Asana asks for, limited only to one day so a broken header can’t stop sync for good; intake’s tree reader keeps its own 120-second limit because it waits inside one import. Just before each write the connector checks again that the switch is on and the Task still syncs, because the reads before it can take long enough for either to change. Every other failure is logged and tried again next cycle.

**Completion in Asana** follows the shared rule. The question an Archive answer would also apply to Tasks under it now names those Tasks, for every tracker, because Archive already archives them.

## Considered Options

- **Track uncertain writes and read comments only after one.** Rejected: the record of an uncertain write is lost in exactly the crash it is meant to cover, and the extra read is cheap.
- **Ask once per Asana project, like Linear’s team question.** Rejected for now: permission from the import and the Task menu is enough, and a project question needs its own intake design.
- **Keep the open-subtask count in an event.** Rejected: it changes whenever someone works in Asana, and the next cycle reads it again within a minute.

## Consequences

The daemon’s Asana token now writes to Asana, but only these two requests, only for an allowed Task and only for the account that allowed it. After a restart the Task Sync row can show “waiting for merge” for a merged parent until the next cycle counts its open subtasks again.
