# Execution commands are journaled on both Macs and reconciled on reconnect

TED-113 adds the command channel that later Tasks use to make worktrees, start Runs, run Checks and move artifacts on a paired execution Mac. This piece carries one operation kind, `probe`, which appends one line to a counter file in the execution Mac’s own storage. Only the validation harness sends it, on synthetic Tasks. No route, CLI command or button issues an operation, and no ordinary Task runs remotely.

## How a command travels

The execution Mac has no listener, so it asks. `POST /sync` on the controller’s TLS listener sits behind the same certificate and grant checks as `/heartbeat`. A request carries the execution Mac’s reports and whether it accepts new work; the answer carries the operations the controller has saved (`confirmed`), new commands and stops. Both Macs must have the `commands` capability or the connection is refused as incompatible.

- **Controller** (`execution/commands.ts`, `store/execution-operations.ts`): `issue` saves `v1.ExecutionOperationIssued` with the Task’s assignment and awaits `store.persisted()` before the command can be sent. A report becomes `v1.ExecutionOperationReported`; the first final outcome is kept, a repeat is confirmed again and a different second outcome is logged and ignored. A final report is confirmed to the execution Mac only after it is saved.
- **Execution Mac** (`execution/journal.ts`, `execution/operations.ts`): an append-only journal under `operations/` in the worker’s private storage, synced to disk before the next request reports anything. It is the inventory of accepted, running and finished operations and the record of reserved space. An entry leaves it only when the controller confirms it. Each Task’s assignment, generation and highest order stay, so a command the controller sends again after the entry is gone is refused as stale.

A command lost on the way is sent again because no acceptance was reported. A result whose confirmation was lost is reported again. A repeated command meets its journal entry. Together these give one execution.

## Identity and refusals

A remote machine’s ID in a Task assignment is its pairing’s grant ID, so a fresh pairing cannot claim the old pairing’s operations. Every command, stop and report carries the Task, machine, assignment, generation and reservation. The execution Mac refuses a command, before any side effect, when the machine is not its current grant, the generation is older than the newest it has recorded for the Task, the assignment differs at the same generation, the order is not newer than the last it accepted, or the repo is outside the approved repos. This Task adds no way to replace an assignment.

## Order, stop and the launch window

Operations of one Task run one at a time in the order the controller issued them; different Tasks run side by side. The controller sends a Task’s next command only when the earlier ones are accepted or final.

A stop is `v1.ExecutionStopRequested` on the controller and counts as stopped only when the execution Mac reports `stopped`. Until then the machine’s row says “stop requested, not confirmed”.

The execution Mac journals `start` before it launches. After a restart, an operation with `start` and no outcome is checked for evidence that its work happened: finished evidence is recorded as the result, proof that it never started puts it back in line, and anything else makes it `uncertain`. An uncertain operation is never run again by the service, its Task starts nothing new on either Mac, and nobody can resolve it yet; that comes with the Task that runs real work.

## Disconnects and reconciliation

Loss of connection is not process death. While disconnected, running operations finish and journal their results, nothing new starts, and no timeout releases anything. The first request of every connection carries the whole inventory. The controller compares it with its records before it applies any report or sends any command:

- an operation the controller does not know, for a Task that exists, is saved as `v1.ExecutionOperationUnknown`: never applied, held, and the Task starts nothing new;
- an operation of a Task deleted meanwhile is confirmed so the execution Mac can clear it, with one log line and nothing recorded on any Task; if it is still running the controller asks it to stop;
- an operation the controller saw accepted or running that the execution Mac no longer has becomes `uncertain`.

Deleting a Task deletes its operations in the same commit (`v1.ExecutionOperationsForgotten`).

## Limits

`executionLimits` in `packages/protocol/src/execution-commands.ts`: a command is at most 64 KiB, a result 256 KiB with 16 KiB of diagnostic text after `redactSecrets`, the journal holds at most 256 unconfirmed operations and 64 MiB, and accepting a command reserves room for its result. At a limit, or below 1 GB free disk, the execution Mac refuses new commands with `limit` or `disk`, reports that it is not accepting work and shows it in its status. It never deletes or shortens a stored result. Run output and artifacts get their own limits in the Tasks that add them.

## Considered options

A connection from the controller to the execution Mac would need a listener and a firewall opening on every execution Mac, against the outbound-only rule of TED-112. A LiveStore store on the execution Mac would be a second Task-shaped store, which ADR 0105 rules out; a journal of commands and receipts is enough. Folding sync into `/heartbeat` would change a shipped message for no gain.

## Testing seams

Network faults come from a relay the harness owns (`test/support/execution-relay.ts`). Crashes at exact points use `TED_EXECUTION_CRASH_AT`, a test-only variable the release ignores. `DaemonOptions.execution.ready` hands the fixture the commands module, since no route reaches it.
