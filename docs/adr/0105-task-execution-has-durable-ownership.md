# Task execution has durable ownership

The approved cross-machine plan for TED-97 keeps one controlling Mac authoritative for Tasks, the Board, Inbox, queue and Workflow decisions. Trusted Macs on a private network or VPN will execute Tasks. Ownership belongs to a Task rather than an individual Run: after automatic placement before first execution, its Runs, sub-agents and Checks stay on that machine. There is no migration or automatic failover.

This first piece records ownership without implementing network execution. `v1.LocalMachineIdentified` gives the local store a stable, randomly generated machine identity. `v1.TaskExecutionAssigned` records the Task, machine, assignment ID, generation, reservation ID, assignment operation ID and timestamp together. The immutable assignment is also the receipt for that operation and reservation; a separate journal would duplicate the same fact today. Only `tasks/execution.ts` initiates assignment writes, through the validated `TedStore.execution` interface. No route grants agents assignment authority.

Old Task events remain unchanged. A Task with no assignment resolves to the local machine at generation 0; this is compatibility information, not a remote execution grant. An already-started legacy Task cannot acquire remote ownership. Before local worktree preparation, setup, a new or revived Task Lead starts, or a sub-agent prepares its worktree or starts, Tasks records a local assignment if necessary and awaits `store.persisted()`. The first explicit assignment is generation 1. This foundation has no transition that replaces an assignment or advances its generation again.

Assignment writes compare the expected generation and commit synchronously, with no intervening await. An identical assignment operation retried at expected generation 0 returns the saved receipt, even after restart or full replay. Changing its Task, machine, assignment or reservation conflicts; operation, reservation and assignment identifiers cannot be reused across retained assignments. A new operation cannot overwrite ownership. Subsequent operations must match the Task, machine, assignment, generation and reservation. Deleting a Task forgets its assignment through `v1.TaskExecutionForgotten` in the deletion commit, including when its Factory is removed; late operations still fail because the Task no longer exists. Identifiers are bookkeeping, never authentication credentials.

Execution handles are structured references containing ownership and an opaque identifier, with no filesystem path. Their identifiers reject path syntax. Existing local worktree paths retain their current meaning; a later execution interface must resolve a handle on its owning machine, never turn a remote path into a controller filesystem path.

## Remote execution contract

The following rules are approved for the later pieces, not implemented networking in this PR:

- The controller keeps the only authoritative Task store and persists human answers. A remote execution journal records commands and receipts, not a second Task store.
- Existing work can finish during a disconnect. New process starts and Workflow advancement wait for the connection and reconciliation. No timeout alone releases ownership or authorizes another execution.
- Revocation rejects later traffic; it cannot prove an offline process has stopped. Stale generations and mismatched ownership must fail before any side effect.
- The first remote release carries ordinary single-repo Tasks through merge. Apps, simulators, Task shells, multi-repo execution and setup Tasks remain local. Planning, Coordinator and Automation Runs remain on the controller, while Tasks they start may be placed remotely.
- Machine pairing must distinguish separate installations, including a copied or restored store on another Mac; replay preserving a store identity is not proof of machine trust.

## Considered options

Hostname, address and filesystem location are mutable and are not execution identity. Editing shipped Task events would violate event-log compatibility. Expiring ownership or automatically retrying on another machine would allow duplicate execution while the original machine is offline. None of those alternatives provides the ownership guarantee needed by later execution pieces.
