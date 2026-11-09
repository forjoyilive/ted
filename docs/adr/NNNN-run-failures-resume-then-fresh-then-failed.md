# A Task Lead Run that dies is resumed in place, then started fresh, then marked Failed

**What counts as a failure.** The Run manager records how every Run ended in `v1.RunEnded`, in the same commit that marks it finished: `stopped` when TED asked (`RunManager.stop`, or the host’s own exit record, which now carries `stopped: true` when the host got SIGTERM), `exited` with the code or signal when the agent ended by itself, or `lost` when the host died without an exit record. It also keeps the agent’s last 8 stderr lines, through `redactSecrets` and cut to 300 characters each, and `resumeFailed` when the last agent start was a resume that never reported its session (`sessionContinuedFrom` in each agent module: any stream-json line for Claude Code, a `thread` result for Codex). A Task Lead Run whose ending isn’t `stopped` fails, unless the agent’s health check says it isn’t Ready, which stays Paused as before. A Task Lead Run that is Working and has written no output for `stallAfterMs` (30 minutes; `TED_STALL_AFTER_MS` for the daemon process) also fails: TED stops it and treats the stop as the failure. The clock restarts at each output line, at a revive, and while the agent kind is paused, so time at a usage limit or offline doesn’t count; a retrying CLI writes retry lines, which count as output.

**What TED does.** `recover` in `tasks/tasks.ts` records one `v1.TaskLeadFailed` per failure with a `recovery`:

- `resume` for the first failure in 30 minutes when the Run has a session and the Task Lead’s agent hasn’t changed. `RunManager.revive` writes a new `launch.json` with the resume flags and the Run’s own model, effort and permissions, and starts a new host in the same Run folder. The Run keeps its id, so it is the same Run; `v1.RunRevived` sets it back to Working. The new host counts the start records already in `host.log` so permission replies tagged with a generation still match, writes its pid to `host.pid` (stop and restart signal that pid, not the first start record’s), and starts reading `input.jsonl` from `inputFrom`, its size at revive time, so old messages aren’t sent again.
- `fresh` when the resume failed, the Run has no session, or the disk is full. The event queues the Task, and the next free slot starts a fresh Task Lead Run from the brief with the KRI-101 `fromTheBrief` note (“Picking up after a crash”).
- `failed` when an earlier failure (not counting failed resumes) was less than 30 minutes ago and after the last Resume or Retry. The same event sets the Task’s `failedAt` and inserts the FAILED ask: a `question` from TED with the title “The Task Lead stopped twice in 30 minutes”, what TED tried, the error lines in a fenced block, the single choice **Retry**, and `failed.runId` naming the last Run.

**Retry.** `POST /tasks/:id/resume` on a Failed Task records `v1.TaskRetried`, which clears Failed and queues the Task, and answers the FAILED ask with the choice Retry. Answering the ask with Retry calls the same function with the typed text as a Comment; answering it with text alone (Send) posts a plain Comment for the next Run and leaves the ask open.

## Considered Options

- **Start a new Run with `--resume` and call it the same Run in the UI.** Rejected: the spec keeps the resumed session as the same Run, and a new Run id would break Conversation tabs and Run tokens.
- **Count failures in memory.** Rejected: the log answers the same after a daemon restart and also draws the thread lines.
- **Detect a failed resume by exit time.** Rejected: a slow machine makes any threshold wrong; whether the agent reported its session is exact.

## Consequences

- `host.log`’s exit record and `launch.json` gained fields (`stopped`, `inputFrom`), and the host writes `host.pid` (ADR 0013).
- A failed sub-agent isn’t handled here; sub-agents report to their Task Lead (KRI-109).
- The app draws the FAILED ask in red with **Open last Run**, **Send** and **Retry**; the sidebar footer shows “N failed” (opening All Tasks filtered to Failed) and the Factory row a red dot.
