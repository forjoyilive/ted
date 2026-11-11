# A send-back records its cause in its own event

To measure where send-backs come from, each one now carries a cause where TED knows it. `v2.TaskSentBack` is shipped and stays as it is (ADR 0010). `store.recordSendBack` takes an optional `cause` and commits `v1.SendBackCauseRecorded` (`sendBackId`, `taskId`, `cause`, `at`) in the same commit; the materializer sets the `cause` column on the `sendBacks` row, and `SendBack.cause` reaches clients through `GET /tasks/:id/send-backs`.

Causes set today, all in `tasks/tasks.ts`:

- `check`: the send-back carries a Check run: a Check failed in Validate and either the Task Lead assessed the failure case as a regression and sent the Task back without a failed review or visual result, or the human chose Fix in this Task. It includes one released by the loop check or by Try again.
- `review`: a counted send-back the Task Lead reported from Validate with Findings.
- `human`: an uncounted send-back after the human asked for changes at a Gate, or Back to Design on the loop ask.
- `base-conflict`: the merge watcher’s two conflict send-backs, and a send-back from Validate or Review that the Task Lead named with `--cause base-conflict` and TED verified with its own test-merge (ADR 0110). A cause the caller passes wins over the three above.

Other send-backs have no cause yet: a Stage other than Validate sending back on its own, and the other send-backs from Merge (the rebase Check rerun, CI). The event’s `cause` is a plain string, so another cause is a new value and needs no new event. `SendBackCause` in `packages/protocol/src/checks.ts` lists them; `declaredSendBackCauses` lists the ones a Task Lead may name on `ted outcome back`, today only `base-conflict`.

`v1.SendBackCauseRecorded` has a Task log entry. The thread matches it to its send-back by the shared `at` and ends that line with “· base conflict”.

## Considered Options

- **`v3.TaskSentBack` with a `cause` field.** Rejected: every reader of the send-back events (the thread, the Task log) would need a third case for one optional field, and two changes adding fields at once would collide.
- **Deriving the cause when reading.** Rejected: `human` and `review` can’t be told apart from the stored fields alone once a Gate answer resets the count.
