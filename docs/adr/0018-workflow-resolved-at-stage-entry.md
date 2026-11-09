# The Workflow is resolved at each Stage entry, and the next Stage file goes into the live Run

`packages/daemon/src/workflow/` resolves a Factory’s Workflow every time a Task enters a Stage: when it starts, and on each `ted outcome advance`. It reads three layers (spec 4.4): TED’s defaults in `workflow/defaults/` (now `workflow.yaml` plus a Stage file for each of the seven agent Stages), the Library in `TED_HOME/library/`, and the Factory’s `.ted/` read with `git cat-file` from `origin/<default branch>` of TED’s clone, fetched first. `checkLayer` validates one layer and returns typed settings and problems with file, line and column; `resolveWorkflow` merges valid layers by the rules in spec 4.4 and answers the Stage list, each Stage file with its layer, the Factory notes and the next Stage. Tasks only call `Workflows.resolve`; they don’t read layers themselves.

**Last valid version.** Each time a layer checks out valid and differs from the stored one, TED commits `v1.WorkflowLayerAccepted` with the layer’s files and version: the commit SHA for a Factory, a content hash for the Library. When a layer has an error, TED resolves with that stored copy, or skips the layer when there is none (spec 4.11). Every Stage entry commits `v1.TaskStageEntered` with the Stage file’s layer and path and, for each layer, whether it was valid, last valid, skipped or absent, its version and its problems. `GET /tasks/:id/stage-entries` returns them for the UI that comes with Factory settings and banners.

**Next Stage file into the live Run.** After committing the Stage change and before answering `ted outcome advance`, TED appends one message to `runs/<run-id>/input.jsonl`: “TED moved this Task to Design” followed by the Stage file. The host polls that file every 150 ms and writes each complete line to the agent’s stdin, so Claude Code takes it as the next user turn. The agent module turns text into the line (`Agent.message`). The answer still goes back before anything stops the Run (ADR 0016).

`order` and settings that a later Stage entry changes apply from the next Stage on. A Task in a Stage that the new `order` no longer has moves to the next built-in Stage that it does have.

`ted workflow check [<path>]` runs `checkLayer` in the CLI process, with no daemon. With no path it checks `.ted` in the current folder. A path equal to the Library folder is checked as the Library, anything else as a Factory’s `.ted/`.

## Considered Options

- **Re-read the layers only when files change, with a watcher.** Rejected for now: a Factory’s `.ted/` lives on GitHub, so it needs a fetch anyway, and reading at each entry is what spec 4.4 asks. The Library watcher comes with Library settings.
- **Keep last valid versions as git refs or files under `TED_HOME`.** Rejected: the Library has no git history, and the store already gives one transactional place for both layers.
- **A fresh Run per Stage.** Rejected by spec 7.1: one long Task Lead Run spans every Stage.
- **Send the next Stage file over a socket to the host.** Rejected for the same reason as host output (ADR 0013): a message sent while the host is busy or the daemon restarts needs a buffer, and a file already is one.

## Consequences

- Every Stage entry fetches the primary repo. A failed fetch is logged and TED resolves with the last fetched `origin/<default branch>`.
- `input.jsonl` is a new part of the host contract (ADR 0013). A host started by an older TED doesn’t read it, so a Task whose Run started before this change gets no Stage file on its next Stage.
- Gates are read and merged but not acted on yet; every Stage advances on its own until the Gates ticket. A Stage that skips itself reports the outcome straight away, so it will skip its Gate too.
- `stages.backlog.enabled: false` makes `POST /tasks` start a Factory’s Task right away, so creating one also resolves the Workflow.
- ADR 0017’s hard-coded `['work']` order is gone; `taskLeadPrompt` now takes the resolved Workflow and adds the Factory notes after the Stage file (spec 7.4).
