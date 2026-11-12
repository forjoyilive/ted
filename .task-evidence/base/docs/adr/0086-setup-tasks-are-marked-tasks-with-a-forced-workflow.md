# Setup Tasks are marked Tasks with a forced Workflow

ADR 0005 makes Factory setup a Task. This records how TED builds one.

**Marking.** `v1.SetupTaskCreated` is committed with the Task’s `v2.TaskCreated` and sets `tasks.setup`. The Task carries `setup: true` and `createdBy: 'setup'`; the store queues it as a `setup-task` entry, so `queueOrder` puts it ahead of every other kind. Its number is 1: while a Factory is still cloning, a Task created by hand starts at 2, and the setup Task takes 1 when it is free.

**Creation.** When cloning finishes, `Tasks.setUpFactory` creates `<KEY>-1` (Priority Urgent, Clarify depth Grilling) unless the Factory already has a setup Task. If the primary repo has `.ted/` on its default branch, the Task stays in Backlog. A human starts a later one with `POST /factories/:id/setup-task` (app only) or the banner’s **New setup Task**; it is refused while one is open.

**Forced Workflow.** `taskWorkflow` in `tasks/tasks.ts` passes a setup Task’s resolution through `setupWorkflow` in `workflow/resolve.ts`: Clarify on at grilling depth, Design and Review on with their Gates, the primary repo’s `base_branch` dropped so the branch and pull request use the default branch, and the setup instructions from `defaults/setup.md` appended to each Stage file. Every resolve for a known Task goes through `taskWorkflow`.

**Proposal.** The design review takes a `setup` object (Workflow lines, Checks and Apps tried on the default branch, files, defaults). The Task Lead runs the tries itself in its worktree, inside its own sandbox; TED doesn’t run proposed commands outside it before approval. TED refuses a setup proposal from any other Task, and a setup Task’s Design without one.

**Validate.** A setup Task’s Checks come from `.ted/workflow.yaml` on its own branch, but only those whose name and command match a passing Check in the approved proposal. A Check the human didn’t approve never runs.

**Notices.** The `setup-unfinished` banner shows while a Factory without its own settings has an open setup Task, or had one that never merged. The app asks before starting a Task in such a Factory (Start anyway, Open setup Task or New setup Task) and never blocks.

## Considered options

- **Running proposed Checks through TED at Design.** Rejected: the commands come from the agent, and TED would run them outside the agent’s sandbox before the human has seen them.
- **Validate running every Check on the branch.** Rejected for the same reason: the branch is agent-written.
