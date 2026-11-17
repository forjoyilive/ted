# A Task moves to another Factory as one event that keeps its internal ID

A Task filed in the wrong Factory could only be archived and created again by hand in the right one, which loses its thread, attachments and Task brief (TED-500). The user wants to move it, and to have a started Task carry on in the new Factory with the conversation so far.

- **Who and which Tasks.** Only the app’s key calls `POST /tasks/:id/move-to-factory` (`Tasks.moveToFactory`), and a Coordinator asks through `ted coordinator transfer`, which always saves a confirmation card that only the user answers. `moveRefusal` in `packages/protocol/src/task-move.ts` refuses Done, archived, merged and setup Tasks; `planMove` in `tasks/tasks.ts` also refuses a move to the Task’s own Factory, a Source the new Factory already tracks, and a parent with a Task under it that can’t move. `GET /tasks/:id/move-plan?factory=` returns the same plan the move carries out, so the app’s dialog and the daemon can’t disagree.
- **The ID.** `tasks.id` is a UUID that every other table keys on; the shown ID is worked out from the Factory’s key and the Task’s number. So the move changes only the Task row’s `factoryId` and `number`. The old Factory and number go into `taskMoves`, which numbering counts like `deletedTasks`, so the old ID is never given to another Task, and `taskRowByDisplayId` falls back to it, so links and commands with the old ID still find the Task.
- **One event.** `store.moveTask` commits, in one commit: `v1.TaskMovedToFactory` for the Task and every Task under it, the removal of blocker links to Tasks that don’t move, the moved Task leaving its parent, the withdrawal of open requests (`withdrawn` with `movedToFactory`), and TED notes on the Tasks on the other side of each removed link. The event’s materializer clears what belongs to the old code, as `v1.TaskReset` does (worktree, Repos, pull requests, Check runs, Failure cases, send-backs, review scopes, Stage entries, the queue), and the tracker sync rows of the Task log, so sync asks for permission again. It keeps Comments, the Task log, description versions, the Task brief, attachments, Runs and the Source.
- **Order.** The move holds every Task in it and marks them and the parent it leaves as busy until the commit, so nothing is attached under them meanwhile; it checks every Task for running Checks before discarding any, and refuses when the Tasks, or what the move would discard, differ from the plan the user or the card saw (`movePlanKey`, sent as `planKey`). Before the commit, `discardForMove` does Reset’s steps for each started Task in the move: stop it, close its pull requests (stop if one stays open or has merged), unlink a planning chat, remove the worktrees, delete the branches. Then `store.moveTask`, then `queueStart` for each Task that wasn’t in Backlog, which takes it into the new Factory’s first Stage.
- **The new Task Lead.** A started move is a fresh-run request (`moved` in `store/task-history.ts`). The first Task Lead launch after it gets the Task brief and a plain-text copy of the old Task Lead’s conversation (`movedPickUp`, through `conversationText` like an agent change), read from the old Run, which the move keeps.

## Considered Options

- **Create a new Task in the other Factory and copy the thread.** Every Comment, attachment, brief and description version would be copied and rewritten, and links from other Tasks would point at the old one.
- **Clear the old Runs as Reset does.** The new Task Lead needs the old conversation, and the user can still read it in the Run chat.
- **Let a parent move without its children.** A parent’s children are the parts of its work; moving them with it keeps the plan whole, and a child that can’t move refuses the whole move, so nothing is left half moved.

## Consequences

- A move can’t be undone; moving the Task back gives it another new number.
- Text that names the old ID (Comments, branch names, pull request titles on GitHub) keeps the old ID; the old ID still finds the Task.
- A Linear, Asana or GitHub issue TED already moved stays where it is until the new attempt reaches that step again, as after a Reset.
