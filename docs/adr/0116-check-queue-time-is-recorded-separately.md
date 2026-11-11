# Check queue time is recorded separately

Supersedes ADR 0103’s decision not to record Check waiting. Scheduling, the FIFO line, limits, cancellation and working-Run slot accounting stay as described there.

A Task’s Check run has two different kinds of time: waiting for the machine’s Check limit, and executing each Check command. `CheckSlots.take` reports entry and admission synchronously. An immediately admitted request uses the same timestamp for both, so its wait is exactly zero. Waiting requests record admission when the slot is assigned, or cancellation when their abort signal fires. Settings tries still share the same slots; only Task-attributed requests record this history.

New versioned `CheckSlotEntered`, `CheckSlotAcquired`, `CheckSlotCanceled`, `CheckSlotInterrupted` and `CheckSlotRecoveryRecorded` events retain the Task, Check run, trigger and Stage. Validate, agent-requested Checks and Merge reruns all connect through `beginChecks`. Admission is persisted before commands launch. Stop, archive and delete retain their existing cancellation behavior. Shutdown records a waiting request’s observed interruption.

Existing `CheckStarted` and `CheckFinished` events materialize per-command execution boundaries. `runChecks` also reports an observed interruption through the new `CheckExecutionInterrupted` event. Existing Check states, outcomes and `durationMs` values are unchanged; a completed command’s timing query uses its original duration. An interrupted command gets a timing interval without turning its Check result into a completed command.

`TedStore.checkTiming(checkRunId)` and `listCheckTimings(taskId)` return named timing history. Existing Check-run reads also include `timing`. The result retains Check run identity, Task, trigger and Stage. Execution positions refer to that run’s stored Check plan, including repo, command and skipped/not-run results. It distinguishes:

- `complete`, `canceled`, or observed `interrupted`: start, end and measured duration;
- `ongoing`: a recorded start with no observed end yet;
- recovered `interrupted`: start and `detectedAt`, with no end or duration;
- `unavailable`: no recorded start for that interval. This includes older queue measurements and commands that never started; the Check result distinguishes skipped/not-run commands.

On recovery, unfinished runs record detection and end as interrupted, as before. Detection is never used as the interval’s end: neither queue nor execution time silently includes unobserved downtime. An observed end recorded before shutdown remains intact. Repeated recovery records preserve the first detection, including another stop before the old run is finished. New Check runs have separate identities and intervals. No Conversation scan, inferred legacy queue duration or working-Run slot is needed. The materialized boundaries rebuild from the versioned event log.
