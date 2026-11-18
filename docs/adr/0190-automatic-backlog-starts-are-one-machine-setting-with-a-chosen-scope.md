# Automatic Backlog starts are one machine setting with a chosen scope

Status: accepted (TED-558). Supersedes the setting part of ADR 0093-automatic-backlog-starts-are-a-machine-local-factory-choice; in ADR 0129 “the Factory setting” now means this setting.

Each Factory had its own **Start Backlog Tasks automatically** switch. With many Factories, the user had to visit each one to change where work comes from, and wanted to switch focus between groups of projects in one place.

**One setting.** `backlogStarts` in the machine settings holds `enabled`, `all`, `groupIds` and `factoryIds` (`packages/protocol/src/backlog-starts.ts`). It stays local to this machine, like the old switch and Factory groups (ADR 0166). Only the app-only `PUT /backlog-starts` changes it (no `runToken`, no `fileToken`), through `parseSetBacklogStartsRequest`; it refuses an unknown Factory or group ID, and `PATCH /settings` refuses the key. A save that changes nothing writes nothing.

**Who takes part.** `backlogStartFactories` reads the setting against the current Factory layout: nothing while `enabled` is off, every Factory when `all` is on, otherwise the chosen Factories plus every Factory in a chosen group. Group membership is read at each check, so a Factory moved into a chosen group takes part at once. `backlogEligible` in `tasks/tasks.ts` uses it in place of the Factory’s flag, cached per `backlogVersion`, which now also moves on `factory-layout-changed`. Changing the setting clears the automatic start failures, as changing a Factory’s switch did. Ordering, caps, snoozes and the other exclusions are unchanged.

**Groups and Factories that go away.** When a layout save drops a chosen group, `withoutGroups` in `factory-setup.ts` chooses its Factories one by one, so nothing quietly stops starting. `factory-removal.ts` drops a removed Factory from `factoryIds`.

**Upgrading.** Until `backlogStarts` is first saved, `settings()` in the store derives it from the Factories’ stored `autoStartBacklog` flags: on, with those Factories chosen, if any flag is on. No migration event is written. `v1.FactoryAutoStartBacklogChanged` and the column stay for replay; the `PUT /factories/:id/auto-start-backlog` route, its parser and `Factory.autoStartBacklog` in the API are gone.

**In the app.** Settings → General has a **Backlog starts** group with the switch and **Start from** (All Factories or Chosen Factories, listed like the sidebar). The All Tasks header has a **Backlog starts: …** button that names what takes part and opens the same controls, and Backlog rows that will start on their own say “Starts automatically”. Factory settings have no switch. The New Task dialog’s note follows the setting.

## Considered Options

- **Keep the per-Factory switch as a shortcut into the global list.** The user chose to remove it.
- **One switch for every Factory, with no choice.** Rejected: the user works on some projects at a time.
- **A migration event on first open.** Rejected: deriving the value until the first save changes nothing for existing homes and writes no event at startup.
