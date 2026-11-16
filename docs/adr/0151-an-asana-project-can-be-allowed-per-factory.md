# An Asana project can be allowed for a Factory

ADR 0150 let a Task sync with Asana only when the user allowed that Task, or imported it in the app. Tasks that Automations or the command line make from an Asana project then each need a click. Linear solves the same problem per team (ADR 0090), and the shared tracker sync (ADR 0147) already keeps group lists by tracker. Asana now uses them, with the project as the group.

**What the user allows.** Settings → Integrations → Asana has one row per Factory, drawn with the same `TrackerGroupsRow` as Linear’s teams. The user picks a project from a list Ted reads with the connected account (`GET /integrations/asana/projects`, `listAsanaProjects` in `asana/projects.ts`: workspaces, then each workspace’s non-archived projects, paged and capped). Allowing (`POST /integrations/asana/projects`) and removing (`POST /integrations/asana/projects/remove`) are app only: neither sets `runToken` or `fileToken`. Allow reads the project again with the connected account before storing its ID. The machine settings route refuses any change to the `asana` entries of `trackerSyncGroups` and `trackerSyncDeclined`, and to `trackerSyncGroupAccounts`, so a project ID reaches the lists only through Ted’s own read.

**Each item is judged by its own projects.** An Asana task can be in several projects or none. The sync cycle’s `GET /tasks/<gid>` asks for `memberships.project.gid`, so knowing the projects costs no extra request, and the shared records commit `v1.TrackerItemGroupsSeen` when the set changes. An import records each item’s projects in its `createTaskTree` commit. `asanaSyncOf` counts a Task as allowed through projects when any of its item’s last-read projects is allowed for the Factory under the connected account. The read always comes before that cycle’s writes, and the connector checks the Task’s state again just before each write, so an item moved out of every allowed project stops before the next write and resumes when a later read finds it back. A subtask gets nothing from its parent’s project.

**Permission records the account.** Allowing writes the connected account’s gid to `trackerSyncGroupAccounts[asana][factoryId][project]` in the same `v1.MachineSettingsChanged` as the list, and the `v1.TrackerGroupSyncAllowed` rows it records for waiting Tasks carry it too. An allowance counts only while that account is connected; with another account the Task shows “another account” and the Settings row offers Allow again, which records the new account. Declined projects aren’t tied to an account.

**The question.** When an Automation’s import creates a Task whose item is in no allowed project, Ted asks about the first of its projects that is neither allowed nor declined and has no open question for that Factory (`askGroups` in `tracker-sync/consent.ts`). An item in no project gets no question. The question uses the shared `tracker-group` purpose, so only the app answers it: Autopilot and the Coordinator already leave it alone, and it holds no merge or nudge.

**Removing a project** stops new Tasks from syncing through it. Tasks that synced only through it get a `v1.TrackerGroupSyncAllowed` row first, so they keep syncing while their item stays in the project, as Linear teams behave.

## Considered Options

- **Put the account in the group key** (`<project>@<account>`). Rejected: declined projects and question de-duplication would become account-specific, and the shared row would show odd keys.
- **Read the item’s projects in a separate request before each write.** Rejected: the cycle read already comes first and the per-write state check covers the gap; it would double the requests per item.
- **Let a parent’s project cover its subtasks.** Rejected: an Asana subtask belongs to the projects it is in, and the request says a subtask outside the project gets nothing.

## Consequences

`v1.TrackerItemGroupsSeen` is a new event that any tracker can use. A Task the user allowed on its own still syncs whatever projects its item is in.
