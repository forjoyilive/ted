# Automation intake rules live in one module

Status: accepted (TED-449)

An Automation brings work in from Linear, GitHub and Asana, and TED refuses what the Factory’s intake setting doesn’t take (ADR 0097, ADR 0149, ADR 0159). Those rules were spread over `tasks/linear-intake.ts`, `tasks/github-intake.ts`, an Asana guard inside `tasks.ts`, inline refusals in `create` and the Automation prompt in `automations.ts`, in three shapes: a function that throws and returns an `unchanged` check, a refusal string plus a separate scope reader, and an inline guard. The prompt described the rules in its own words, and nothing tied them to the checks.

Now `packages/daemon/src/tasks/intake.ts` holds them:

- **`scopeHold`** reads one tracker’s intake setting for a Factory and returns it with `unchanged()`, which throws when the setting changed since the read. Every tracker uses it.
- **`automationIntake`** is what `ted task create` from an Automation goes through. Creating it raises the Follow-up refusals (Asana, GitHub) and the GitHub `--start` refusal, and takes the GitHub scope. `judgeGitHub` judges the issue read that `githubIssue` makes, `verify` checks Linear membership, `unchanged` checks both scopes again, and `refuseTrackedParent` refuses a sub-issue of a tracked issue. `create` and the Follow-up path call each at the point where the old checks ran, so the order of checks and every message stay the same.
- **`asanaIntakeHold`** and **`refuseAsanaRoot`** are Asana’s scope guard (including the Factory-removal check) and its verdict on a root. `requireIntakeRoot`, the preview, the import and `asanaIntakeNow` still read Asana in `tasks.ts`.
- **`intakeLines`** writes the prompt’s Linear and GitHub intake lines next to the checks they describe.

Every refusal throws `RequestError` with the status it had before. The module reads no tracker and commits no event: the Tasks module still reads, creates and orders the steps (ADR 0016). Sync stays in `tasks/tracker-sync/` (ADR 0147); intake is a separate question.

## Considered Options

- **One call that also reads the tracker.** Rejected: the module would need `gh`, the Linear client and Asana, and its tests a stub for each. Passing the read in keeps it testable with plain data.
- **Leave Asana out**, because its intake imports whole trees from the daemon. Rejected: its scope guard and root verdict are the same kind of rule, and bulk intake for Linear and GitHub (TED-451, TED-452) will reuse `scopeHold`.
- **Move `sourceKey` and `sourceClash` in too.** Rejected: they serve every caller, not just Automations.

## Consequences

- A new intake rule, its refusal text and its prompt line change together in `intake.ts`, with a case in `packages/daemon/test/intake.test.ts`.
- The unit cases from `test/github-intake.test.ts` and the scope cases from `test/linear-intake.test.ts` moved into `test/intake.test.ts` with the same expected text; `linear-intake.test.ts` keeps only its Linear client tests.
