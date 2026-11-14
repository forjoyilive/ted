# Drift is found from `based_on`, TED keeps the inherited texts it has seen, and a Task can force a Gate on

KRI-149 shows when a Stage file a Factory or the Library overrides has changed underneath it (spec 5.5), and adds Merge with an agent.

**Finding drift.** `workflow/drift.ts` `findDrift(inherited, own)` flags a Stage when the more specific layer has its own `stages/<id>.md`, records `stages.<id>.based_on`, and `stageFileHash` of the file it would otherwise inherit differs from that hash. An override with no `based_on` is never flagged: TED can’t tell what it was copied from. Factory rows compare against TED’s defaults plus the Library; Library rows compare against TED’s defaults only.

**Remembering inherited texts.** To show what changed in the inherited file, and in which TED version, the daemon records every default and Library Stage file it reads as a `v1.StageFileTextSeen` event (hash, layer, Stage, text, TED version), once per hash, in the `stageFileTexts` table. A drift row diffs the text recorded for `based_on` against the inherited text now (`diffOf: 'inherited'`). When TED never saw that version, for example a copy made on another machine, the row diffs the override against the inherited text instead (`diffOf: 'yours'`) and says so. “Changed in TED x” uses the version recorded with the current default’s hash.

**Counts.** `Workflows` keeps the drift count for each Factory it has resolved and for the Library, recomputes them on every resolve and every `inherited()` call (which the Library watcher triggers), and emits `drift-changed` when they change. `GET /drift` returns the same counts. The sidebar’s Factory Settings entry, the Workflow nav item and Settings → Library show them. Drift never raises a banner or an Inbox item.

**Keep mine and Use inherited** are ordinary settings edits that collect until Save: Keep mine sends `keepStageFiles`, which rewrites `based_on` to the inherited file’s current hash and leaves the Stage file alone; Use inherited (Use default in the Library) deletes the copy as Reset does.

**Merge with an agent** is the app-only `POST /factories/<id>/stages/<stage>/merge-inherited`. It refuses with 409 when that Stage has no drift, and otherwise creates and starts an ordinary Task: title “Merge inherited changes into <stage>.md”, Priority None, Clarify depth None, the primary repo (the default), and a description with the instructions, the inherited diff (or the whole inherited file) and the current override, each in a fence longer than any backtick run inside it.

**Forced Gates.** `NewTask.forcedGates` commits `v1.TaskGatesForced` with the Task’s creation. `tasks.ts` resolves a Task’s Workflow through `taskWorkflow(task)`, which applies `withForcedGates`: each forced Stage is turned on with a Gate, and put into `order` before the first later built-in Stage if the Factory left it out. No Task TED creates forces a Gate any more: the drift merge Task forced the Review Gate until TED-331 and now follows the Factory’s Gates, and Tasks created before that keep theirs. A forced Gate is not part of the public `Task`.

**Settings Tasks start from the default branch.** `NewTask.changesSettings` commits `v1.TaskChangesSettings`; for such a Task `taskWorkflow` drops the primary repo’s `base_branch`, so its worktree starts from, and its pull request targets, the GitHub default branch that `.ted/` is read from (spec 4.3), whatever `base_branch` says. The drift merge Task sets it.

## Considered Options

- **Shipping a table of past default hashes and texts with each TED build.** Would give the right diff even for copies made on another machine, but grows with every release. Recording what this machine has seen covers the common case; the fallback diff covers the rest.
- **A Task field telling the Task Lead to stop at Review.** Rejected: a Gate must be enforced by TED, not left to the agent.
- **Counting drift by reading every Factory’s files on request.** Rejected: the sidebar needs the count all the time, and `resolve` already has the layers in hand.
