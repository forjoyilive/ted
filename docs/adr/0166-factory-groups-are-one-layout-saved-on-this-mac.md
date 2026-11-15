# Factory groups are one layout saved on this Mac

The user can sort Factories into named groups (one per client, or Personal and Work) so a long sidebar is easy to scan, and filter the Inbox and All Tasks by group (KRI-403).

**One layout.** The sidebar’s Factories section is one list whose items are Factories and groups in any order; a group holds Factories in its own order, and a Factory is in at most one group. `v1.FactoryLayoutSaved` stores that whole list. Its materializer rewrites the `factoryLayout` table and also `factoryOrder` with the Factories in sidebar order, so each Factory’s `position`, ⌘1 to ⌘9 and every existing sort follow the sidebar, collapsed groups included. `GET /factories/layout` returns it, with any Factory the layout doesn’t name (one added since) at the end and ungrouped; `PUT /factories/layout` is app-only (no `runToken` or `fileToken`), refuses a layout that doesn’t name every Factory exactly once or repeats a group ID, and commits nothing when the layout is unchanged. It replaces `PUT /factories/order` (ADR 0068); `v1.FactoriesReordered` stays for replay. `v1.FactoryRemoved` deletes the Factory’s layout row, so a group can be left empty; an empty group stays until the user ungroups it. Live updates are the `factory-layout-changed` event.

**In the app.** `renderer/factory-layout.ts` holds every layout change (drop before, after or into, Move up and Move down, Move to group, New group, Rename, Ungroup) as pure functions, and the roll-up of a collapsed group’s waiting count and red marks. The `+` beside Factories offers New Factory… and New group. Ungroup removes only the heading: its Factories stay where the group was, so it needs no confirm, and the word avoids “Delete”. Which groups are collapsed is kept in the window’s local storage, like which Factories are open; opening a Factory inside a collapsed group expands it.

## Considered Options

- **Tags (a Factory in several groups).** Rejected: a sidebar section can show a Factory only once, and ⌘1 to ⌘9 need one order.
- **Groups in `.ted/workflow.yaml`.** Rejected: how one user sorts their Factories is personal and per machine, like the Factory name and order.
- **One event per action (group created, renamed, Factory moved).** Rejected: a full layout follows `v1.FactoriesReordered`, is checked whole in one place, and can’t leave the order and the groups disagreeing.
