# Base conflicts found at hand-off are recorded

ADR 0110 refuses `ted outcome advance` while the branch conflicts with its base. At Work that refusal is the whole story: the Task Lead resolves the conflict in place and no send-back exists, so nothing in the store said the conflict happened. A Factory dashboard could count conflicts that became send-backs and not the ones caught earlier.

## Decision

`v1.BaseConflictFound` records each conflict TED’s own test-merge finds: `id`, `taskId`, `stage`, `repo`, `base` (the branch name), `tip` (the base commit), `fileCount`, `files` and `sendBackId`.

- When `advance` is refused at Work, Validate or Review, `store.recordBaseConflict` commits it with `sendBackId` null, before the 409.
- When a `--cause base-conflict` send-back from Validate or Review is verified, `store.recordSendBack({ conflict })` commits it in the same commit as `v2.TaskSentBack` and `v1.SendBackCauseRecorded`, with that send-back’s ID and time.

`files` holds at most 50 names, each through `clean` (escapes and hidden characters removed, `redactSecrets`, cut at 300 characters); `fileCount` is the real number. The base name goes through `clean` too.

Rows live in the `baseConflicts` table and go with the Task (`v1.TaskDeleted`), which is also how Factory removal deletes them. `GET /tasks/:id/base-conflicts` (`DaemonClient.listBaseConflicts`) returns a Task’s rows; like `send-backs` it is closed to Run tokens.

The event has a Task log entry without the file names. The thread shows a refusal as “TED kept this Task in Work: its branch conflicts with main in 2 files”; a row with a `sendBackId` adds no line, because its send-back already reads “· base conflict”.

A dashboard counts conflicts caught at Work as rows with `stage: 'work'`, and conflicts that became send-backs as rows with a `sendBackId`. A conflict at Validate or Review usually has both a refusal row and a send-back row.

ADR 0112 reads these rows for the base tips it trusts and for the files a send-back’s conflict named.

## Considered Options

- **A field on `v2.TaskSentBack` or `v1.SendBackCauseRecorded`.** Rejected: shipped events aren’t edited (ADR 0010), and a refusal at Work has no send-back to carry it.
- **Only a count of files.** Rejected: the next review names the files (ADR 0112), and the names are already in the Findings and the refusal message.
- **Record the merge watcher’s conflicts too.** Not done: GitHub reports those, without a base commit or file list. They are counted as `base-conflict` send-backs from Merge.

## Consequences

- A Task Lead that reports `advance` again without resolving the conflict adds a row each time.
- Nothing records a conflict when the fetch or the test-merge itself fails; the outcome goes through, as in ADR 0110.
