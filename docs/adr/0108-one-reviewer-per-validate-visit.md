# One reviewer per Validate visit, and no other sub-agent in Validate

Task Leads in Validate started extra review Runs over the same diff (“Independent Codex review”, “Codex branch review”) beside TED’s reviewer. Two reviewers find two sets of edge cases, and each set costs a Work visit and a Validate visit. The Stage file said not to; it didn’t hold.

`SubAgents.request` in `tasks/sub-agents.ts` now refuses, while the Task is in Validate:

- **A second reviewer.** `ted run start --reviewer` answers 409 when a reviewer chosen since this Validate visit began is queued, still running, or has ended with a final message. The message names its Run and says to use `ted run wait` or `ted run send`. A reviewer that failed, was dropped before it started, or was stopped before it said anything doesn’t count, so the Stage file’s “try again” still works.
- **Any other sub-agent.** `ted run start` without `--reviewer` answers 409. The Task Lead does Validate’s other steps (tests, screenshots, trying the change) itself.

`--agent`, `--model` and `--effort` are still refused with `--reviewer` (ADR 0055). The loop check is started by TED, not through this route, and is unaffected. Other Stages are unchanged.

## Considered Options

- **Count and report extra review Runs.** Rejected: the data already shows them, and reporting changes nothing in the round that pays for them.
- **Refuse only sub-agents that look like a review** (by name, prompt or `--agent`). Rejected: TED can’t tell what a prompt asks for, and a rule a Run can step around by renaming is no rule.
- **A Workflow setting to allow other sub-agents in Validate.** Not built. A Factory whose Validate Stage file needs one (say, a sub-agent that runs slow end-to-end tests) would need it; add `stages.validate.sub_agents: true`, resolved through `Workflows.resolve`, if that comes up.

## Consequences

- A Factory’s own Validate Stage file that tells the Task Lead to start a plain sub-agent now gets a refusal there.
- A Task Lead can still review the diff itself or run a review tool from its shell. TED’s Validate entry text (ADR 0107) tells it not to.
- Code that changes after the visit’s reviewer was requested can’t get a second review in that visit, so TED refuses `ted outcome advance` until the Task goes back to Work or the branch is back at the reviewed commit (ADR 0107).
