# TED imports labelled GitHub issues in bulk

Status: accepted (TED-452)

Asana work comes into TED two ways: an Automation names one task with `ted task create --source`, or it runs `ted asana intake` and TED imports everything in the Factory’s saved scope from its own read (ADR 0149). GitHub had only the first way, through the “Daily GitHub issue triage” template, where the agent lists issues with `gh` and creates Tasks one at a time. The prompt decides which issues the agent looks at, and every firing costs an agent search.

Now `ted github intake` (`POST /github-intake`, `Tasks.githubIntake`) imports every eligible issue in one call:

- **Only an Automation Run calls it**, in its own Factory, and not a Scheduled Check’s agent. The route sets `runToken` and not `fileToken`; the app and the terminal are refused, and the human tries it with Run now on the Automation. Calls for one Factory run one after another.
- **It needs the Factory’s GitHub intake label** (`githubIntakeScopes`, ADR 0159). Without one it refuses with a 409 that names Factory settings → GitHub intake, because anyone can open an issue on a public repo and nothing else filters a bulk import. Only people with triage access can add a label. The one-issue path still takes any open issue when no label is set.
- **TED lists the issues itself**: `listIntakeIssues` in `packages/daemon/src/github/intake.ts` asks GitHub, through the `Gh` runner, for each Factory repo’s open issues with the label, 100 per page and at most 5 pages per repo, and reads each field through `@ted/protocol/parse`. A repo it can’t list is named in the result and the others go on; a repo with more issues is named as incomplete.
- **`planGitHubIntake` in `tasks/intake.ts` decides what to import**: it skips an issue already tracked in the Factory (by `sourceKey`) or whose parent issue is tracked, and leaves an issue whose parent is also listed to the parent’s import, which brings it as a child.
- **Each issue goes through the existing create path**: `createTask` with the issue’s URL, as an Automation create. So `judgeGitHub`, the sub-issue tree, outsider marking, Backlog-only and the Factory’s auto-start exception all apply unchanged. A refusal for one issue is reported with TED’s reason and the run goes on.
- **A run creates at most 100 Tasks** (`maxGitHubIntakeTasks`, sub-issues included, counted across the firing’s GitHub Tasks). A tree that doesn’t fit what is left waits for the next run. The label is read once at the start and checked again before each Task; if it changed, the run stops.
- **A template, “Import GitHub issues”**, runs `ted github intake` every 30 minutes. The triage template stays for Factories that want the agent’s judgement or have no label.

## Considered Options

- **Read every listed issue with `readGitHubIssue` before deciding.** Rejected: one query per issue on a large repo, and `createTask` reads the issue again anyway.
- **Allow the bulk command without a label.** Rejected for the reason above.
- **A separate store commit for the bulk import, as Asana’s tree import has.** Rejected: GitHub already creates a parent and its sub-issues in one `store.createTask` commit, and a second path would copy its checks.
- **Let the app or the terminal call it.** Rejected: the one-issue checks apply only to Automation creates, and Run now already gives the human a way to try it.

## Consequences

- Tests cover the rule in `packages/daemon/test/intake.test.ts` and the whole command in `packages/daemon/test/automations.test.ts`, with the stub `gh` answering the `TedGitHubIntake` list from its `issues` state.
