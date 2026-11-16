# Ted’s built-in preamble and Stage files ship as Markdown in the daemon package

The preamble and Ted’s default Stage files live in `packages/daemon/src/workflow/defaults/` (`preamble.md`, `stages/<id>.md`) as plain Markdown, read when a Run starts. `taskLeadPrompt` builds a Task Lead’s first message from the preamble, the current Stage file and the Task, in that order (spec 7.4). The preamble maps plain intents in Stage files (“post a note”, “report the outcome”) to `ted` commands and points to `ted help` (spec 4.8). It lists only commands that exist.

Until KRI-86 adds layers, the Workflow is hard-coded in `workflow.ts` as Backlog, then `['work']`, then Done. KRI-86 puts the Library and the Factory’s `.ted/` on top of these same files (ADR 0002) without changing `taskLeadPrompt`’s callers.

## Considered Options

- **Strings in TypeScript.** Rejected: Stage files are Markdown everywhere else (the Library and `.ted/`), and the defaults are the base layer of the same lookup.

## Consequences

- Packaging has to ship `workflow/defaults/` with the daemon.
- Changing the preamble changes what every new Run gets. Runs that are already running keep the message they started with.
