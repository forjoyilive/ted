# Setting up this Factory

This Task is the Factory’s setup Task. It decides Ted’s settings for this Factory: Factory notes in `.ted/notes.md`, Stage overrides in `.ted/stages/<id>.md`, `.ted/workflow.yaml`, and any Agents the human approves in `.ted/agents.yaml` and `.ted/agents/<id>.md`. For this Task the Design and Review sign-offs are always on and Clarify runs at grilling depth. Change only files in `.ted/`, in the primary repo; the pull request goes to its default branch.

If the primary repo already has `.ted/` on its default branch, this is a later setup Task: propose changes to the current files and show each change as a diff in the design review, instead of writing the files from scratch.

Don’t propose adding or removing repos; if something suggests a repo is missing, say so in Worth your eye. Suggest `lead`, `reviewer` or `planner` values only if the human asks for them.

## Intake

Ted filled in this Task. Run `ted outcome advance`.

## Clarify

Read every repo first: the README, `AGENTS.md` or `CLAUDE.md`, package manifests, CI workflows, test and lint scripts, and how the product runs locally. Then ask the human how they work, in rounds with `ted ask --round <file>`: which Stages they want, where sign-offs go, how they merge (merge method, waiting for CI or for a review), and what the Factory notes should say. Recommend an answer to each question from what you read. When the human may pick several answers, such as which Stages they want, mark the question `"multiple": true` with a list of recommended choices.

Ask too whether anything should happen after a pull request merges, such as a comment on the Asana task or Linear issue, a message to someone, or shutting down a test environment or emulator. That work belongs in Cleanup, an optional Stage between Merge and Done: the Task keeps its Task Lead and worktree, does each Cleanup step, and moves to Done once every step has a result. Recommend a Cleanup step for each such request, never a line in the Review or Merge sign-off and never a task the user does by hand. A step that needs judgment or another tool’s access (posting a comment, writing to an issue) is an instruction step for the Task Lead; a fixed shell command (stopping a test server, deleting a preview) is a command step that Ted runs itself, in the sandbox, before the Task Lead is told anything, and that may run twice after a restart.

## Design

1. Try each candidate check on the default branch, in your worktree, before you change anything: run its command and note whether it passed and how long it took. A check that fails on the default branch is left off the proposal’s settings; list it as failed with the reason.
2. Try to start each App the same way: note its kind, how it became ready and how long that took (for example “ready in 9s at localhost:5174”), then stop it. An App that won’t start is left off; list it as failed with the reason. An App or Check that builds with Xcode, `swift`, `actool` or `ibtool` needs the `ios-xcode` sandbox access group: give it `sandbox_access: [ios-xcode]` in `.ted/workflow.yaml` and list it as `"sandboxAccess": ["ios-xcode"]` on its row in the proposal; `ted sandbox groups` lists every group and what it opens. An `ios-simulator` App that builds with `xcodebuild` must pass `-derivedDataPath "$TED_DERIVED_DATA" -packageCachePath "$TED_SWIFTPM_CACHE"`, because Ted’s sandbox refuses Xcode’s own folders in the home folder. If the build resolves Swift packages, it must also pass `-IDEPackageSupportDisableManifestSandbox=1`, because SwiftPM can’t start its own sandbox inside Ted’s, and `-IDEDisablePackageManifestCaching=1`, because the manifest cache sits in the home folder. If its Swift code uses macros (such as `@Observable` or `#Preview`), it must pass the build setting `SWIFTC_DISABLE_SANDBOX=YES`, because the macro plugin server can’t start its own sandbox either. For the same reason, `swift build`, `swift run` and `swift test` must pass `--disable-sandbox`. An Expo app whose `node_modules` has `expo-modules-jsi` also builds ExpoModulesJSI in Xcode’s “[CP-User] Build ExpoModulesJSI xcframework” phase with a second `xcodebuild` that starts with an empty environment, so it gets neither flag and fails. Its `run` command builds that framework first, outside Xcode, with an `xcodebuild` wrapper first on `PATH` that adds both flags and sets `TMPDIR` back, because SwiftPM otherwise writes a lock file in the shared temp folder: `w="$(mktemp -d "$TMPDIR/xcodebuild.XXXXXX")" && printf '#!/bin/sh\nTMPDIR="%s" exec /usr/bin/xcodebuild -IDEPackageSupportDisableManifestSandbox=1 -IDEDisablePackageManifestCaching=1 "$@"\n' "$TMPDIR" > "$w/xcodebuild" && chmod +x "$w/xcodebuild" && (cd ios && PATH="$w:$PATH" PODS_ROOT="$PWD/Pods" PLATFORM_NAME=iphonesimulator ../node_modules/expo-modules-jsi/apple/scripts/build-xcframework.sh)`, then the app’s own `xcodebuild`. The script records what it built, so Xcode’s phase then skips the build. Pass `-resultBundlePath` with a path inside `$TMPDIR` too, or a failed build can’t save its result bundle. An `ios-simulator` or `android-emulator` App’s `run` command should print a line that is exactly `TED_APP_READY` once the app is built, installed and launched: Ted builds one of these Apps at a time and starts the next when it sees that line, when the command exits, or after 15 minutes. Ted also gives these Apps `TED_APP_CPUS`, the number of CPU cores the build may use; pass it on so a build doesn’t take every core, with `xcodebuild -jobs "$TED_APP_CPUS"` or `./gradlew --max-workers="$TED_APP_CPUS"`.
3. Post the proposal with `ted outcome advance --design <file>`. Write `summary` as two sentences, and add a `setup` object to the design file:

   ```json
   {
     "title": "Proposed setup for Notebook",
     "summary": "Two sentences on what you propose and what you found.",
     "setup": {
       "workflow": [
         { "stage": "intake" },
         { "stage": "design", "setting": "Sign-off on" },
         { "stage": "validate", "setting": "Send back at most 5 times · validate.md for Notebook" },
         { "stage": "cleanup", "setting": "On · Comment on the Asana task (instruction) · Stop the preview (command, not tried)" }
       ],
       "checks": [
         { "name": "Unit tests", "command": "npm test", "repo": "notebook-app", "passed": true, "durationMs": 112000 },
         { "name": "End-to-end", "command": "npm run test:e2e", "repo": "notebook-app", "passed": false, "durationMs": 40000, "reason": "Fails on main: needs the API running" }
       ],
       "apps": [
         { "name": "Web", "repo": "notebook-app", "kind": "web", "run": "npm run dev -- --port ${PORT}", "ready": "ready in 9s at localhost:5174", "passed": true }
       ],
       "agents": [
         {
           "id": "release",
           "name": "Release helper",
           "about": "Walks through cutting a release: version bump, changelog and the tag.",
           "powers": ["ask", "read_code"],
           "instructions": "# What this Agent is for\n\nHelps cut a Notebook release. Start a chat with it before you tag a version.\n\n## How it works\n\n- Read CHANGELOG.md and the commits since the last tag first.\n- Ask before proposing a version number.\n"
         }
       ],
       "files": [
         { "path": ".ted/notes.md", "about": "Factory notes: product, repos, running locally, conventions" },
         { "path": ".ted/workflow.yaml", "about": "repos with worktree setup and Apps, checks, Stage settings" },
         { "path": ".ted/stages/validate.md", "about": "Start the App, sign in, check the main flow" }
       ],
       "defaults": "Left as Ted’s defaults: Providers, permissions Auto, the Mac’s working Run limit."
     }
   }
   ```

   `workflow` has one line per Stage, in order; leave out `setting` for a Stage that stays as Ted’s default. `checks` and `apps` list everything you tried, with the results you saw; give each App the exact `run` command you will write in `.ted/workflow.yaml`. Give each Check and App that needs a sandbox access group its `sandboxAccess` list, exactly as you will write `sandbox_access` for it; the user sees it in the approval, and Ted gives a setup Task’s Apps and Checks only the groups the user approved. A repo whose `worktree.setup` or `worktree.teardown` needs a group gets a `worktree` line, `{ "repo", "step": "setup" or "teardown", "sandboxAccess": [...] }` (leave out `repo` for the primary repo); Ted refuses the branch if its setup or teardown asks for other groups than the approved ones. `files` names every file Work will write, with one line on what it holds; always include `.ted/stages/validate.md`, and override other Stages only when their steps really change. `defaults` names what stays at Ted’s defaults.

   `agents` is optional, and suggesting none is the normal case. Suggest an Agent only for a recurring job in this repo that a chat with the human helps with and that needs knowledge a general chat lacks, such as cutting a release, planning database migrations or an unusual deploy, and only when what you read shows how that job is done here. Don’t suggest one for work a Task already does (writing code, reviewing, fixing tests), and never one whose id Ted or the Library already uses, such as `coordinator` or `planner`: Ted refuses it, because the Library’s settings would fill in anything the setup files leave out. Give each the fewest powers it needs, from `ask` (Ask the user), `read_code` (Read the code), `run_commands` (Run commands in the copy), `propose_tasks` (Propose Tasks) and `manage_tasks` (Manage Tasks); suggest `manage_tasks` only if the human asked for an Agent that starts or moves Tasks. `run_commands` needs `read_code` and goes with `commands`, a list of `{ "name", "command" }` (add `"repo"` in a Factory with several repos) that Ted runs in the chat’s copy, in its sandbox, when the chat asks by name; list only commands you ran in Design, such as the repo’s own test or lint command. Leave out `agent` and `model` unless the human asked for a Provider. `instructions` is the full text of `.ted/agents/<id>.md`: what the Agent is for, what to read first and what to ask before acting; Ted adds the commands its powers allow. Don’t list the Agent files under `files`: the sign-off shows them from `agents`. The human can remove any Agent when they approve.

   When the user asked for after-merge work, add a `cleanup` line after the other Stages that names each step and whether it is an instruction or a command. Don’t run command steps in Design: they act after a merge and may shut things down, so the line says they weren’t tried. Leave the line out when Cleanup stays off.

## Work

Write the approved files on this branch and nothing else: `.ted/notes.md`; `.ted/workflow.yaml` with `repos`, the checks that passed under `stages.validate.checks` (each with the same name and command as in the proposal), `apps`, and the Stage settings, including `stages.cleanup` when the proposal turns Cleanup on; and each Stage override as a full copy of the inherited Stage file, edited for this product. Cleanup is never listed in `order`; turn it on with `enabled: true` and one entry under `steps` per approved step, `{name, instruction}` or `{name, command}` with an optional `timeout` (default `10m`):

```yaml
stages:
  cleanup:
    enabled: true
    steps:
      - name: comment on the Asana task
        instruction: Post a comment on the Asana task this Task came from, with the merged pull request’s link.
      - name: Stop the preview
        command: ./scripts/preview.sh stop
```

For each Agent the human kept, add it to `.ted/agents.yaml` with the same `name`, `powers` and `commands` (a map of each name to its command, or to `{ command, repo }`), and `agent` and `model` only when the proposal has them, and write `instructions` word for word to `.ted/agents/<id>.md`. The approval message names any Agent the human removed; write nothing for those. With no Agents kept, write no `.ted/agents.yaml` and no `.ted/agents/` files. Ted compares these files with the approved proposal and refuses `ted outcome advance` and the Review sign-off while they differ:

```yaml
release:
  name: Release helper
  powers: [ask, read_code]
```

Run `ted workflow check` until it passes, commit, then run `ted outcome advance`.

## Validate

Ted runs the checks from this branch’s `.ted/workflow.yaml` whose name and command match the approved proposal, plus the Ted settings check, then starts the Apps from this branch whose name, repo and `run` match the approved proposal and tells you how each one started. Each gets only the sandbox access groups the user approved for it. When a command’s output ends with a line saying the sandbox refused a path in an access group, propose that group for the App or Check (send the Task back to Design to change the proposal); never work around the refusal by moving the tool’s files or turning off its checks. Confirm each App works the way the proposal says; `ted run-app <App>` reaches the same ones.
