# Instruction Checks run an agent at Validate

Status: accepted (TED-556). Changes ADR 0188-the-checks-run-as-validates-first-step-and-every-return-to-work-counts and ADR 0066-factory-settings-sections-and-scratch-worktrees.

A Check was a shell command. Some things a Factory wants checked on every Task need judgment, not a command: whether a change left a doc out of date, for example. TED-553 asked for Checks written as instructions; TED-556 builds them, with an option to fix what they find. This repo’s own Docs drift Check is added in a separate Task once an installed release reads instruction Checks, because the installed `ted` that runs this Factory can’t read the new keys before then.

## Decision

**A Check is a command or an instruction.** Under `stages.validate.checks`, a Check is `{ name, run, repo?, timeout? }` or `{ name, instruction, fix?, timeout?, agent?, model?, effort? }`. `checkChecks` in `workflow/check.ts` refuses a Check with both `run` and `instruction` or neither, `repo` on an instruction Check, and `fix`, `agent`, `model` or `effort` on a command Check. `agent` takes the reviewer’s values; `timeout` has a command Check’s format and defaults to `20m` (`defaultInstructionCheckTimeout`). Scheduled Checks and Automations keep command Checks only.

**Order.** `planChecks` in `tasks/checks.ts` plans instruction Checks with `fix: true` first, then the command Checks and the Ted settings Check, then the other instruction Checks; each group keeps its list order. So the commands run once, on the code after any fix. An instruction Check is skipped when no repo has changes. Everything else is ADR 0188 unchanged: one Check run, `runChecks` runs the plan in order, and the first failure stops it and is a counted return to Work with cause `check`.

**A fresh sub-agent runs each one.** `createInstructionChecks` in `tasks/instruction-checks.ts` asks `SubAgents.requestForCheck` for a sub-agent with purpose `instruction-check`, in the primary repo’s worktree. Its agent, model and effort come from `reviewerFor` with the Check’s own `agent`, `model` and `effort` laid over the reviewer setting; a model or effort without an agent keeps the reviewer’s agent. Its prompt is Ted’s, built by `instructionCheckPrompt`: the Task, each repo’s diff command from its merge-base to `HEAD`, what it may do, the Factory’s instruction inside a fence with a fresh nonce, and how to report. The Task’s latest Task Lead Run is its parent even when that Run has ended, because `validation.enter` can run with no live Task Lead. The Task Lead can’t wait on, message or stop it, and stopping the Task Lead doesn’t stop it. It doesn’t take the Check slot and isn’t Validate’s one reviewer: it waits for a working-Run slot like any sub-agent, and `stages.validate.sub_agents` doesn’t limit it. The Check slot is taken when the first command starts and given back before the report-only instruction Checks. The timeout counts from when the Run starts, not while it waits for a slot; past it, Ted stops the Run.

**The result line.** The sub-agent’s final message is the report. Its last non-empty line must be `Result: pass` or `Result: fail` (`reportResult`). The report goes, through `redactSecrets`, into the Check’s log file, so the failure case evidence and the Findings come from it as they do from a command’s output.

**Ted checks the changes.** Ted reads each repo’s `HEAD`, tree and uncommitted files before and after the agent.

- A report-only Check that changed anything, committed or not, fails with “The agent changed files.”
- A `fix: true` Check may edit and commit in the Task’s worktree. Ted lists its new commits in the report. It passes when the agent reports pass and left no uncommitted changes; uncommitted changes fail it with “The agent left uncommitted changes.” A failed fixing Check’s commits stay on the branch. Ted never reverts anything.

**No report is a question for the user.** A crash, a stopped Run, a timeout or a final message without the result line is no report, never a pass. The Check run records `v1.CheckReportMissing` and the Task waits in its Stage while `checkReportMissing` in `tasks/tasks.ts` asks the user, with purpose `check-report`: **Try again** starts a new agent for the same Check in the same Check run; **Count it as failed** records it as failed and returns the Task to Work as for a reported failure. Only the user answers it. Ted doesn’t retry on its own, and an open question is withdrawn when Ted restarts. When the missing result line comes with changed files, it is still no report, and the report says the files changed.

**Coverage after a fix.** A fixing Check changes the code the Check run started on. When one changed anything, Ted records the coverage and the failure context again before the commands run, so `requireCoverage` matches the code the commands checked and nothing reruns. `record` in `tasks/failure-cases.ts` accepts a context captured after the Check run started only for Ted’s own record of a Check run that had a fixing Check.

**A passed instruction Check reruns only when the Task’s changes change.** On a pass Ted stores a change key, `v1.CheckChangeKeyRecorded`: `git patch-id --stable` of each repo’s diff from its merge-base to `HEAD` after any fixes, with the instruction, `fix`, agent, model and effort (`changeKey`). At the next plan, if the last passed key for that Check matches (`store.passedChangeKey`), the Check is planned as passed with `notRerun` and the thread says “not rerun: the Task’s changes are the same as when it passed”. A rebase at Merge that only brings in other people’s commits therefore doesn’t rerun it. No key is stored while the worktree has uncommitted changes, so that Check runs again next time. Command Checks rerun as before.

**Fixing happens only at Validate.** A Check may fix only in a `validate` Check run while the Task is in Validate. At Merge a changed Task goes back to Work, so a `fix: true` Check that has to rerun there runs report-only; so does one that `ted checks` runs.

**`ted checks` before Validate runs commands only.** It plans the command Checks, then lists the instruction Checks with their instructions, marking those that may fix. In Work `ted checks` is refused altogether (TED-583, ADR 0193-ted-checks-is-refused-in-work).

**Run now on a chosen Task.** In Factory settings, Run now on an instruction Check asks for a Task: `GET /factories/:id/checks/try/tasks` lists open Tasks in the Factory, owned by this machine, with a Task Lead Run and a worktree that has changes. The try goes through the same human-only `POST /factories/:id/checks/try` with `instruction` and `taskId` (`InstructionCheckTryRequest`) and runs through `check-tries.ts` as before. It is always report-only. Its result (Last run and Report) shows only in Factory settings; it opens no failure case and changes nothing on the Task. The agent is still a sub-agent Run on that Task, so it shows in the Task’s Runs; the thread leaves out its start line through `runNowAgents` in `tasks/thread.ts`, which picks out an `instruction-check` sub-agent that started outside any Check run of that Task holding an instruction Check of the same name.

**Settings.** A Factory settings save carries instruction Checks as their own `instructionChecks` list beside `checks`; a save that names only `checks` keeps the instruction Checks as they are. The YAML is written commands first, then instruction Checks. The app’s Checks section has two lists, Commands and Instruction Checks, each with its own Add button. Each Check is a collapsed row with Edit and Run now; Edit opens one editor at a time below its row, and a ⠿ handle reorders a Check within its own list, by drag or with the arrow keys.

**Events.** `v2.ChecksStarted` carries the instruction Check fields, with `v1.CheckChangeKeyRecorded` and `v1.CheckReportMissing` beside it. No shipped event changes. `CheckResult.command` is optional and absent on an instruction Check.

## What changes in ADR 0188

- The Checks no longer always run in list order: fixing instruction Checks run before the commands, and the other instruction Checks after them.
- A Check run can start Runs: one sub-agent per instruction Check.
- A Check can change the Task’s code during Validate, before the commands run.
- A passed instruction Check isn’t run again while the Task’s own changes are the same.
- A Check with no result waits for the user’s answer instead of failing.

## Considered Options

- **A `ted check report` command for the sub-agent.** Rejected: the loop check already reads a final message, and a command would need a new Run-token route.
- **A separate batch after the Check run.** Rejected: it would duplicate the failure case, progress and Accept this failure handling.
- **Fixing Checks after the commands.** Rejected: the commands would run twice whenever the agent fixes something.
- **The Task Lead carries out the instructions.** Rejected: a fresh agent sees only the diff and the instruction, and the Task Lead isn’t running when the Checks start.

## Consequences

- A Factory can check, and fix, things no command can, at the cost of an agent Run per instruction Check per Validate visit whose changes differ.
- With Bypass, “report only” rests on the prompt and Ted’s before-and-after comparison, which catches the change after it happened.
- A fixing Check’s commits are part of the Task’s branch and reach the pull request like any other commit.
- Run now on an instruction Check leaves a sub-agent Run in the chosen Task’s Runs.
