# A Workflow setting allows other sub-agents in Validate

ADR 0106 refuses every sub-agent in Validate except TED’s reviewer, and named the setting to add if a Factory needed one: a Validate Stage file that hands slow end-to-end tests to a sub-agent gets a refusal it can’t work around.

## Decision

`stages.validate.sub_agents` is `true` or `false`, default `false`. `checkLayer` rejects any other value and warns on any Stage other than Validate. It merges like every Stage setting, is written by `workflow/edit.ts`, and is a switch on the Validate row of Factory settings → Workflow and of the Library page.

When it is `true`, `ted run start` without `--reviewer` works in Validate as it does in other Stages. Nothing else changes:

- One reviewer per Validate visit (ADR 0106). A second `ted run start --reviewer` is still refused.
- `--agent`, `--model` and `--effort` are still refused with `--reviewer` (ADR 0055), so a plain sub-agent’s flags never reach a reviewer.
- A plain sub-agent isn’t a reviewer: it gets no `v1.ReviewerChosen` and no review scope, and it doesn’t count as the visit’s review.

When it is `false`, the refusal names the setting and says only the human changes it.

`validateRoundText` and `conflictRoundText` (ADR 0110) tell the Task Lead not to review the diff with a sub-agent, in either case; with the setting on they stop saying TED refuses other sub-agents.

**Where the value is read.** `SubAgents.request` asks `validateSubAgents`, which resolves the Task’s Workflow through `taskWorkflow` without a fetch. That is the Factory’s default branch as TED last fetched it, usually when the Task Lead reported the outcome that moved the Task into Validate. A later fetch for any Task of the Factory brings in a newer value. TED doesn’t store resolved settings per Stage entry, and `max_back` and `loop_check` are read the same way.

**Setup Tasks.** `setupWorkflow` forces no value. A setup Task’s Validate runs only the Checks of its approved proposal and takes `sub_agents` from the layers like any Task.

## Considered Options

- **A flag on `ted run start`.** Rejected in ADR 0106 and still: a rule the Run can lift isn’t a rule.
- **A list of allowed sub-agent names or prompts.** Rejected: TED can’t tell what a prompt asks for, and a name is whatever the Task Lead types.
- **Fetching the Factory’s default branch on each request.** Rejected: a network call per `ted run start`, for a setting that changes rarely.

## Consequences

- With the setting on, a Task Lead can start a sub-agent that reviews the diff, which ADR 0106 set out to stop. TED’s Validate entry text and the Stage file tell it not to; nothing enforces it.
- Each sub-agent takes a working Run slot through the queue, as in other Stages.
