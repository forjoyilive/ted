# `ted checks` is refused in Work

Status: accepted (TED-583). Changes ADR 0188-the-checks-run-as-validates-first-step-and-every-return-to-work-counts.

ADR 0188 made the Checks Validate’s first step and said the Work Task Lead “may run the Factory’s fast checks … and runs no tests”. Ted had no way to hold it to that. `ted checks` in Work still ran every Check, so in this repo a Task Lead could start Affected Tests (`pnpm check --affected`, up to 80 minutes) and make every other Run wait for test slots, minutes before Validate ran the same Checks again. The preamble still told the Task Lead to run `ted checks` before reporting Work finished, and that Ted ran the Checks before the Task left Work. The default Work Stage file offered `ted checks` too.

## Decision

**`ted checks` is refused while the Task is in Work**, with or without `--name`. `runChecks` in `packages/daemon/src/tasks/tasks.ts`, behind `POST /tasks/:id/checks`, answers 409 when `handsOff(task.stage)` is true, before it resolves the Workflow or records a Check run. The message says Ted runs the checks when the Task enters Validate, and to run the repo’s quick commands (its type check, its linter) directly. Only the Task Lead may call the route, so a sub-agent was already refused; the Stage rule applies whatever the caller.

**Every other Stage is unchanged.** From Validate on, `ted checks` runs the Checks as before, with the `agent` trigger, in the sandbox (ADR 0091).

The preamble, the default Work Stage file, `ted help`, the spec and the failure-case hint that named `ted checks` say the same.

## Considered Options

- **Allow one named Check in Work** (`--name` only). Rejected: a Task Lead could still name the test Check, and Ted can’t tell a quick Check from a slow one.
- **A per-Check setting saying which Checks Work may run.** Rejected for now: it adds a Workflow setting and checker work for something the Task Lead can already do by running the command itself.
- **ADR 0091’s rejected “Allow `ted checks` only from Validate on”.** That was about the sandbox: Validate runs the same agent-written code, so refusing Work would not have made anything safer. This ADR is about load and duplicate runs, and every Check still runs in the sandbox.

## Consequences

- A Task Lead in Work checks its work with the repo’s own commands. Those run in the Task Lead’s own sandbox, not as Check runs, so they leave no Check run in the Task’s history.
- Tests that used `ted checks` in Work to start a Check run now start it from Validate.
