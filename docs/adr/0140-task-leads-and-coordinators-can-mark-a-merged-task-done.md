# Task Leads and Coordinators can mark a merged Task done

ADR 0135 let only the human finish a Task at Merge whose pull requests merged on GitHub. A Task Lead that saw the merge could only end its turn and wait for the merge watcher, which notices on the poller’s schedule (TED-239, TED-272).

**The same check now has three callers.** `markDone(ref, by)` in `tasks/tasks.ts` takes who asked (`human`, `lead` or `coordinator`); everything ADR 0135 describes (wait for the Task and the merge watcher, a fresh poller read, every pull request `MERGED`, obligations, one holding) is unchanged.

- **Task Lead:** `ted task done` calls `POST /tasks/:id/done`, which sets `runToken` and acts only when the caller is the Task’s current Task Lead Run (`taskLead`). Sub-agents, other Tasks’ Runs, Automation Runs and the `daemon.json` token are refused. `POST /tasks/:id/mark-done` stays app-only.
- **Coordinator:** `ted coordinator done <id>` is a `done` action in `Coordinators.act`, with a receipt and operation ID like the others, for a Task of its own Factory at Merge.
- **Who did it** is recorded in `v2.TaskMarkedDone { taskId, by, at }`; `v1.TaskMarkedDone` still reads as the human’s. The thread says “You”, “The Task Lead” or “The Coordinator marked the Task done after its pull requests merged on GitHub”.
- The Merge Stage file tells the Task Lead to run `ted task done` once every pull request has merged.

## Considered Options

- **Open `mark-done` to Run tokens.** Rejected: one route would serve callers with different rules, and the app-only rule for it stays simple.
- **Make the merge watcher poll faster.** It still wouldn’t help when the watcher misses a merge, and every poll costs GitHub requests.

## Consequences

- A Run can now move its own Task to Done, but only when GitHub shows every pull request merged, so `isMerged`, Linear sync and retention can still trust Done.
- A Coordinator gains one more action at Merge; it never merges anything.
