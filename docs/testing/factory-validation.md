# Factory validation and Ted’s own test rules

Each Factory chooses its Check commands and its Validate instructions. The test-file limit, test-slot queue and `pnpm check` implementation in this repo are rules for developing Ted. Other Factories do not inherit those helpers merely by using Ted.

## The five examples from KRI-341

| Example | Where it lives | Effect on other Factories |
| --- | --- | --- |
| Test waits are logged and reported per Task | [suite-lock.ts](../../packages/daemon/test/support/suite-lock.ts), [test-waits.ts](../../scripts/test-waits.ts) and [test-reporting.ts](../../scripts/test-reporting.ts) | This repo’s helpers write a local JSONL log. `pnpm test-waits [days]` summarizes it by run kind, day and folder. Task-attributed reports use Ted’s general reporting API, but require an instrumented runner; arbitrary test commands do not gain measurements automatically. |
| A Run can run at most three test files at a time | [suite-lock.ts](../../packages/daemon/test/support/suite-lock.ts), [check.ts](../../scripts/check.ts), this Factory’s [Work](../../.ted/stages/work.md) and [Validate](../../.ted/stages/validate.md) files | The repo helpers refuse Vitest runs above three files and `pnpm check` when `TED_RUN` is set. A Check has no `TED_RUN`, so this Factory’s Affected tests Check may run more. Which Stage runs tests is a Factory instruction; the helper’s refusal checks the environment and file count, not the Stage. Ted has no general three-file cap for other Factories. |
| Small runs no longer wait behind a waiting full run | [suite-lock.ts](../../packages/daemon/test/support/suite-lock.ts) | This repo coordinates its test processes across checkouts. Small runs can pass a waiting full run, but once the full run’s turn comes, it yields only to small runs already waiting, for at most five minutes. This is separate from Ted’s queue for Factory Checks. |
| `pnpm check` no longer stalls on pnpm’s reinstall question while holding the lock | [check.ts](../../scripts/check.ts), `runChecks` | This repo’s full-check script disables pnpm’s modules-purge confirmation and closes stdin during dependency refresh. Other Factories choose their own commands and how those commands install dependencies. |
| Duplicate daemon tests were removed and slow files restructured | This repo’s `packages/daemon/test/` suite; commits `efd666f0` and `aac0c46f` | Duplicate failure tests were reduced, and `overnight-gates.test.ts` and `validate-diagnosis.test.ts` were restructured to share daemons between Tasks. These changes reduce this repo’s test cost; they add no validation policy to another Factory. |

The [test-lock reporting contract](../contracts/test-lock-reporting.md) explains the distinction between the local log and Task-attributed reports, including unsupported and incomplete measurements. Reporting measures waits; it does not choose tests, impose the repo’s locks, or change pass/fail results.

## This repo’s test runs on a busy machine

These are also rules for developing Ted only; the code is in [machine-load.ts](../../scripts/machine-load.ts).

- **Fewer workers when the machine is busy.** A test run reads the 1-minute load average per core when it starts (`os.loadavg()[0] / os.availableParallelism()`). At 0.75 or below it uses the usual worker counts: `pnpm check` runs 3 Electron and 6 Node workers, any other run of 10 or more files 6, a smaller run 3. Above 0.75 each count is multiplied by 0.75 ÷ load and rounded, never below 1: at 1.5 that is 2 and 3, at 4 or more 1 and 1. `pnpm check` starts at once and prints one line with the load and the counts it chose; a plain Vitest run prints the same line.
- **`pnpm check --wait-for-quiet`** waits first, after it holds the test lock and has installed dependencies, until the load per core is 0.75 or below. It prints what it is waiting for and the load once a minute. After 30 minutes it prints a warning and starts anyway with fewer workers. `--wait-for-quiet=<minutes>` sets another limit, and `TED_CHECK_WAIT_FOR_QUIET` (`1` or minutes) does the same without the flag. While it waits it holds the lock, so other test runs on the machine wait too.
- **`TED_TEST_LOAD`** overrides the reading: `off` ignores the load and keeps the usual counts, and a number is used as the load per core. `vitest.config.ts` sets `off` for every test file, and `scripts/measure-check.ts` sets it for the check it measures.
- **The load is recorded.** Each `run` line in `~/.cache/ted/test-failures.jsonl` carries `load` (per core, read once the run holds its slot or lock) and `workers`. `pnpm test-failures` says how many runs started on a busy machine and has a `busy` column: how many of a test’s failures were in such runs. `pnpm check` also saves `load` and `workers` with each run in `node_modules/.cache/ted-test-failures.json`.
- **`pnpm flaky <file> [-t <name>] [--runs N] [--load N]`** runs one test file N times (default 5, at most 50) with busy threads beside it (default one per core) and no retry, then prints how many runs passed and how many runs each test failed in. Each run’s output is saved under `node_modules/.cache/ted-flaky/`. It takes the full-run lock, like `pnpm check`, because its load would make any test run beside it fail; the load starts only once it holds the lock and stops when it ends or is interrupted. Its runs are not written to `test-failures.jsonl`. It is refused when `TED_RUN` is set: loading every core would slow every other Run.

## Choose a Factory’s validation

Use the Factory settings’ Checks section for commands Ted must run. Each Check has a name, command, optional repo and timeout (default ten minutes). The corresponding configuration is `stages.validate.checks` in the primary repo’s `.ted/workflow.yaml`. For example, this fragment declares a project’s test command:

```yaml
stages:
  validate:
    checks:
      - name: Tests
        run: npm test
        timeout: 20m
```

Choose the command that fits the project: a full suite, a focused suite or a script that selects tests. A Check runs in its selected repo’s Task worktree; omitting `repo` selects the primary repo. Checks for repos absent from the Task or unchanged from the base branch are skipped. Check configuration chooses commands, not a universal test-file budget.

Use the Factory settings’ Workflow section to edit Validate’s Stage file, stored as `.ted/stages/validate.md`. Put project-specific instructions there: which extra tests the Task Lead should run, when to run them, how to try the change and what evidence to report. Instructions for Work belong in its Stage file. Repo rules in `AGENTS.md` still apply; changing a Stage file does not reconfigure a test runner’s own limits.

Ted resolves built-in defaults, then the user’s Library, then the Factory. A more specific Stage file replaces the inherited file in full; Workflow settings merge by key. The Factory layer comes from `.ted/` on the primary repo’s remote default branch and is resolved at Stage entry, so editing a Task’s working copy does not immediately change its active instructions. Validate a proposed layer with `ted workflow check` before committing it.

Other existing controls include `reviewer` (agent, model and effort), `stages.validate.max_back`, `loop_check`, `p1_only_from` and `sub_agents`. See the [Workflow settings table](../spec/ted-v1-spec.md#45-workflowyaml) for their meanings and allowed layers. Checks are Factory-specific; the Library can supply shared Stage instructions and other Workflow settings.

## What Ted itself enforces

The general [Check runner](../../packages/daemon/src/tasks/checks.ts) runs configured commands sequentially and stops at the first failure. When Validate follows Work without a Work sign-off, Ted runs them before leaving Work. Tasks entering Validate another way run Checks at entry. A Check passes on a clean exit; its timeout and failure remain recorded. Ted also adds its built-in settings Check when the primary repo’s changes touch `.ted/`.

The built-in [Validate Stage](../../packages/daemon/src/workflow/defaults/stages/validate.md) asks for relevant extra tests following the repo’s rules, independent code and security review, and applicable visual verification. It specifies no three-file limit, pnpm requirement or repo test-lock policy.

Some validation behavior is enforced by Ted regardless of Stage wording: unresolved failure cases and remaining Checks hold advancement; only the user can accept a failure; one reviewer is allowed per Validate visit; and reviewed commits must still match when advancing. Stage customization does not bypass these safeguards. The [validation spec](../spec/ted-v1-spec.md#8-validation) and [failure-case policy](../spec/failure-cases.md) describe the general behavior.

This Factory chooses Typecheck, Lint and Affected tests as Checks in [.ted/workflow.yaml](../../.ted/workflow.yaml). Affected tests is `pnpm check --affected`, a script in this repo that works out which test files a Task’s changes affect and runs them; [This repo’s test tooling](test-tooling.md#affected-tests) says how it chooses. Over 60 files it runs a narrower set and leaves the rest to a Scheduled Check that runs the full `pnpm check`. The Task Lead no longer picks test files: its custom Validate file has it run only the Electron app tests that Ted’s sandbox kept the Check from running. That combination is a choice for developing Ted, and another Factory can choose a different test strategy using the existing controls.
