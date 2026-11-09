# Setting up this Factory

This Task is the Factory’s setup Task. It decides TED’s settings for this Factory: Factory notes in `.ted/notes.md`, Stage overrides in `.ted/stages/<id>.md`, and `.ted/workflow.yaml`. For this Task the Design and Review Gates are always on and Clarify runs at grilling depth. Change only files in `.ted/`, in the primary repo; the pull request goes to its default branch.

If the primary repo already has `.ted/` on its default branch, this is a later setup Task: propose changes to the current files and show each change as a diff in the design review, instead of writing the files from scratch.

Don’t propose adding or removing repos; if something suggests a repo is missing, say so in Worth your eye. Suggest `lead`, `reviewer` or `planner` values only if the human asks for them.

## Intake

TED filled in this Task. Run `ted outcome advance`.

## Clarify

Read every repo first: the README, `AGENTS.md` or `CLAUDE.md`, package manifests, CI workflows, test and lint scripts, and how the product runs locally. Then ask the human how they work, in rounds with `ted ask --round <file>`: which Stages they want, where Gates go, how they merge (merge method, waiting for CI or for a review), and what the Factory notes should say. Recommend an answer to each question from what you read.

## Design

1. Try each candidate Check on the default branch, in your worktree, before you change anything: run its command and note whether it passed and how long it took. A Check that fails on the default branch is left off the proposal’s settings; list it as failed with the reason.
2. Try to start each App the same way: note its kind, how it became ready and how long that took (for example “ready in 9s at localhost:5174”), then stop it. An App that won’t start is left off; list it as failed with the reason.
3. Post the proposal with `ted outcome advance --design <file>`. Write `summary` as two sentences, and add a `setup` object to the design file:

   ```json
   {
     "title": "Proposed setup for Notebook",
     "summary": "Two sentences on what you propose and what you found.",
     "setup": {
       "workflow": [
         { "stage": "intake" },
         { "stage": "design", "setting": "Gate on" },
         { "stage": "validate", "setting": "Send back at most 5 times · validate.md for Notebook" }
       ],
       "checks": [
         { "name": "Unit tests", "command": "npm test", "repo": "notebook-app", "passed": true, "durationMs": 112000 },
         { "name": "End-to-end", "command": "npm run test:e2e", "repo": "notebook-app", "passed": false, "durationMs": 40000, "reason": "Fails on main: needs the API running" }
       ],
       "apps": [
         { "name": "Web", "repo": "notebook-app", "kind": "web", "ready": "ready in 9s at localhost:5174", "passed": true }
       ],
       "files": [
         { "path": ".ted/notes.md", "about": "Factory notes: product, repos, running locally, conventions" },
         { "path": ".ted/workflow.yaml", "about": "repos with worktree setup and Apps, Checks, Stage settings" },
         { "path": ".ted/stages/validate.md", "about": "Start the App, sign in, check the main flow" }
       ],
       "defaults": "Left as TED’s defaults: agents, permissions Auto, the Mac’s working Run limit."
     }
   }
   ```

   `workflow` has one line per Stage, in order; leave out `setting` for a Stage that stays as TED’s default. `checks` and `apps` list everything you tried, with the results you saw. `files` names every file Work will write, with one line on what it holds; always include `.ted/stages/validate.md`, and override other Stages only when their steps really change. `defaults` names what stays at TED’s defaults.

## Work

Write the approved files on this branch and nothing else: `.ted/notes.md`; `.ted/workflow.yaml` with `repos`, the Checks that passed under `stages.validate.checks` (each with the same name and command as in the proposal), `apps`, and the Stage settings; and each Stage override as a full copy of the inherited Stage file, edited for this product. Run `ted workflow check` until it passes, commit, then run `ted outcome advance`.

## Validate

TED runs the Checks from this branch’s `.ted/workflow.yaml` whose name and command match the approved proposal, plus the TED settings Check, then starts the approved Apps from this branch and tells you how each one started. Confirm each App works the way the proposal says; `ted run-app <App>` reaches the same ones.
