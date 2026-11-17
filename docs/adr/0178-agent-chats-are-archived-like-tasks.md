# Agent chats are archived like Tasks

Status: accepted (TED-427). Replaces ADR 0145-stopped-planning-chats-stay-open-and-can-resume on Mark finished and changes ADR 0142-new-conversation-keeps-the-coordinator-conversation and ADR 0171-each-coordinator-chat-has-its-own-id on ended Coordinator chats.

The Agents screen (TED-426) lists Coordinator and planning chats together, but each kind ended differently. A planning chat went from Open to Past when it Finished, and a Stopped or Failed one stayed open until the user clicked **Mark finished**. A Coordinator chat ended only as an old saved conversation and came back with **Continue**. The user had no one way to put a chat away or bring it back.

**Every Agent chat is open until the user archives it.** Archive, Unarchive and Delete work the same for both kinds and are the app’s alone: `POST /plans/:id/archive`, `POST /plans/:id/unarchive`, `POST /coordinator-chats/:id/archive` and `POST /coordinator-chats/:id/unarchive` set neither `runToken` nor `fileToken`, and the existing `DELETE` routes stay.

- **Planning chats.** `Plans.archive` stops a live Run the way Stop does (the Run stops, the checkout is removed, a linked Task hears the chat was archived through `Tasks.planEnded` with `archived`), then commits `v1.PlanArchived` with every open round or proposal to withdraw, in one event. `v1.PlanUnarchived` clears it. Both set the new `plans.archivedAt` column. An archived plan can’t resume or take answers (409). Every ended plan that isn’t archived can be written to, Finished ones included, through the existing `resume` path: a Run with a session resumes it; a Run without one is revived in the same Run with the planner’s first prompt (`RunManager.revive` with `fresh`, since a plan’s ID is its Run’s ID); a plan with no Run starts fresh, and the user’s message is queued for the new Run so steering delivers it.
- **Approving a proposal archives the chat.** The shipped `v1.PlanEnded` materializer sets `archivedAt` when the outcome is `finished`. That is also how plans that finished before this change show as archived after the state rebuild the new column causes. **Mark finished** and `POST /plans/:id/finish` are gone.
- **Coordinator chats.** An archived Coordinator chat is one with `endedAt` set. `Coordinators.archiveChat` stops the chat’s reply as Stop does, stops its Runs, cancels its open confirmation cards and clears their snoozes, then commits `v1.CoordinatorChatArchived`. Unarchive commits the shipped `v1.CoordinatorChatContinued`, so **Continue** became **Unarchive**; the next message starts a Run through the existing replacement path. Messages to an archived chat are refused with 409. Saved conversations from before ADR 0171 were already ended chats and now show as archived.
- **Run output.** `runOutputEnd` already keeps every plan’s Run and every Coordinator chat’s Runs, open or archived, so an archived chat keeps its output. Deleting a chat removes its rows but leaves `runs/<id>` to retention: `runOutputEnd` answers `unknown` for a Run with no row, and `pruneRunOutput` removes it `runOutputDays` after its last write. Removing a Factory still removes its chats’ Run output at once.

**Archived chats can be deleted automatically.** The `deleteArchivedChatsAfterDays` machine setting (default `null`, never; 1 to 365) is separate from `deleteArchivedAfterDays` for Tasks. `createChatArchiveCleanup` in `packages/daemon/src/chat-expiry.ts` runs on the same retention timer and setting change as the archived-Task cleanup, finds due chats with `chatsDue` (archived longer than the setting), and deletes each through `Plans.delete` or `Coordinators.deleteChat`. `GET /chat-archive-expiry?days=N` gives the due count for the app’s confirm dialog.

**In the app**, the Agents list puts archived chats in a collapsed **Archived** section under the open ones, newest archive first, and opens it while an archived chat is shown. Each row’s menu offers Archive or Unarchive, and Delete…. A chat’s header has **Archive**; an archived chat is read only, with **Unarchive** (and **Plan more from here…** for a planning chat) where the message box was.

## Considered Options

- **One `v1.AgentChatArchived` event with a kind.** Rejected: each kind’s table and store module are separate, and per-kind events keep each materializer beside its table.
- **Writing to an archived chat unarchives it.** Rejected: an archived chat is read only until the user unarchives it, like an archived Task.
- **Start a second planning Run when the plan can’t resume.** Rejected: a plan’s ID is its Run’s ID. Reviving the same Run without a session does the same job.

## Consequences

- A chat the user never archives stays in the open list, Stopped and Failed planning chats included.
- Finished planning chats from before the update appear under Archived, not Past.
