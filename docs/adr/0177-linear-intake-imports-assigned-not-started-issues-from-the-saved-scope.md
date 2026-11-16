# Linear intake imports assigned, not-started issues from the saved scope

Status: accepted (TED-451)

An Automation could bring Linear work in only one issue at a time: its agent searched Linear with its own tools and ran `ted task create --source <issue URL>` for each issue, and TED checked each one against the Factory’s Linear intake scope (ADR 0097). Asana already had a second way, where TED reads the tracker itself and imports everything eligible (ADR 0149). Linear now has it too.

- **One call does the whole intake.** `Tasks.linearIntake` (`POST /linear-intake`, `ted linear intake`) takes only the Factory: for an Automation Run, its own Factory. Runs for one Factory take turns. The route sets `runToken` and `fileToken`, like `/asana-intake`.
- **A saved Team or Project scope is required.** In an Unscoped Factory, `linearIntakeHold` in `tasks/intake.ts` refuses. Otherwise one Factory’s firing could take every issue assigned to the user across the workspace.
- **TED decides what is eligible from its own read.** `Linear.intakeIssues` in `linear/linear.ts` lists, in one paged GraphQL query, the issues assigned to the connected user whose state type is `triage`, `backlog` or `unstarted` (`linearIntakeStateTypes`), in the scope’s Team or Project. That matches what the one-issue template already told its agent. It reads at most 1,000 issues and reports when it stopped. `refuseLinearList` refuses a list from a workspace other than the scope’s. Without a Linear key the call is refused.
- **Each issue goes through the one-issue path.** For each listed issue, an issue already tracked in the Factory (`sourceClash`) is counted as tracked. Otherwise TED calls the same `createTask` that `ted task create --source <url> "<title>"` uses, with the same caller. Scope membership, Linear files, Linear sync consent (`ask` and the team question) and Backlog without a start therefore apply unchanged. A refusal is a skipped issue with its reason. A scope change during the run stops it.
- **At most 100 Tasks per run** (`maxLinearIntakeTasks`), counted for an Automation Run across everything it created from Linear in that firing. The rest are counted as left for the next run.
- **A built-in template, “Import my Linear work”**, runs `ted linear intake` once. The existing “Pull new Linear issues assigned to me” template stays, for Factories that want the agent to choose.

## Considered Options

- **Allow an Unscoped Factory.** Rejected: unlike the one-issue path, the human never sees a list before Tasks appear, so the scope is the only bound on what comes in.
- **Bring sub-issues in as child Tasks**, like Asana subtasks and GitHub sub-issues. Left for later: Linear imports have no tree today. Each eligible issue, sub-issue or not, becomes its own Task.
- **Include unassigned issues.** Rejected: Asana intake takes only the user’s own work, and a team’s unassigned backlog can be large.

## Consequences

- The intake rules for bulk Linear intake sit in `tasks/intake.ts` beside the others (ADR 0173); the listing stays in `linear/linear.ts` and the loop in `tasks/tasks.ts`.
- Tests use `stub-linear.ts`’s `assignedToMe` and states, and `startDaemon`’s `linear.intakeLimit` to lower the cap.
