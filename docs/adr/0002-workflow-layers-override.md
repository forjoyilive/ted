# Workflow layers override at runtime instead of being copied into the repo

A Factory’s workflow comes from three layers: Ted’s defaults, the user’s Library in `~/.ted/library/`, and the Factory’s `.ted/`. Ted resolves them each time a Task enters a Stage, and the more specific layer wins, so the repo holds only what differs for that Factory. We chose this so one edit to the Library or a Ted update improves every Factory that doesn’t override it.

## Considered Options

- **Copy the resolved layers into `.ted/` when a Factory is created.** This makes the repo show exactly what runs, but every Factory would need its own update to pick up a Library change. Rejected; it only made sense while the workflow had to run without Ted (see ADR 0001).

## Consequences

- The repo alone doesn’t show the full workflow. The Factory settings screen makes up for this by showing the effective workflow and which layer each Stage file and setting comes from.
- A Library edit can change a Task while it is running, starting at the Task’s next Stage. Ted records which file and layer each Stage entry used.
