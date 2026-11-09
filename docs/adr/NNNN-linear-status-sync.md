# Linear status sync for Tasks from a Linear issue

Status: accepted (KRI-26)

## Context

Since ADR 0037, a Task made from a Linear issue keeps the issue as its source, but nothing flows back: the issue stays in Todo while TED works on it and after it merges, and closing the issue in Linear doesn’t tell TED. The human chose sync both ways. Intake of new issues stays with Automations (KRI-154, KRI-155).

## Decision

- **TED → Linear.** When the Task leaves Backlog, the issue moves to its team’s started state; when the Task reaches Merge (the sign-off before it), to a started state whose name has “review” in it, if the team has one; when `TedStore.isMerged` says the Task merged, to the team’s completed state. TED picks states by Linear’s state `type` and then by name (“In Progress”, “In Review”, “Done”, else the lowest `position`), reads each team’s states once per 10 minutes, and never stores or guesses a state ID. It only moves an issue forward: an issue already at or past the target stays where it is. Archiving a Task without merging leaves the issue alone. Each pull request TED opens is attached to the issue once (`attachmentCreate`).
- **Linear → TED.** When an issue that TED saw open becomes completed or canceled while its Task is open, TED archives the Task if it has no live Run and hasn’t reached Merge, with the thread line “TED archived this Task · NOTE-1 was marked Canceled in Linear” (`v3.TaskArchived` carries `why`). Otherwise TED posts one `question` from TED, “NOTE-1 was marked Done in Linear”, with **Archive** and **Keep going**; work and the merge go on while it’s open. Reopening the issue, or the Task merging, withdraws the question. The first state TED sees for an issue is only recorded, so a Task made from an already-closed issue isn’t archived.
- **One poller.** `tasks/linear-sync.ts` reads every watched issue (a Task with a Linear source that is open, or merged and not yet synced) every 60 seconds in one batched GraphQL query (aliases, 50 issues per query), only while the `linearSync` machine setting is on and a key exists; without a key it makes no request. Requests live only in `linear/linear.ts`; the Tasks module decides archive or question in `linearIssueClosed`. Each Task is matched to its issue through its source URL, so the issue’s workspace must be the key’s.
- **Records.** What TED saw and did are events with no table, read back from the task log like GitHub activity (ADR 0065): `v1.LinearIssueSeen` (state type and name, written when they change), `v1.LinearIssueMoved` (the step and the state name, or none when TED left it), `v1.LinearPullRequestsLinked`. A failed request is logged through `redactSecrets` and tried again next cycle.
- **Text.** State names from Linear go through `clean` (as GitHub text does) and are cut to 80 characters before they reach the store, the thread or the Inbox.
- **Setting.** `linearSync` is a machine setting, on by default, shown as **Sync status with Linear** under the Linear key in Settings → Integrations once a key is stored. One key serves one workspace (ADR 0037), so a machine setting matches it.

## Considered Options

- **Hooks in the Tasks module at start, sign-off and merge.** Immediate, but each hook needs its own retry when Linear is down. A poller that compares the Task with what it recorded retries for free and is at most a minute late.
- **Cancel the issue when the human archives a Task.** The issue belongs to the human; archiving in TED doesn’t mean the work isn’t wanted.
- **A Factory setting.** Several Factories can share one workspace and key; the key is per machine, so the switch is too.
- **A comment with the pull request link.** An attachment shows in Linear’s sidebar and Linear treats a second one with the same URL as an update.

## Consequences

- A Task made before this change starts syncing at its next poll: its first read is recorded, then it moves forward to match the Task’s Stage.
- KRI-179 checks the queries and mutations against a real workspace; tests use `stub-linear.ts` only.
