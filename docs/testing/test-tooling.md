# This repo’s test tooling

This page describes the tooling used to develop TED in this repo: `pnpm check`, the Vitest setup, the locks that let test runs share one machine, the logs they write, and `pnpm release`. None of it is part of the TED app, and no other Factory gets it. For what TED itself does at Validate, and how another Factory chooses its own rules, read [Factory validation](factory-validation.md).

The rules an agent must follow are repeated in `AGENTS.md`. This page holds the detail.

## Commands

- `pnpm install`, then `pnpm typecheck`, `pnpm lint` (Biome; `pnpm format` fixes) and `pnpm test` (Vitest).
- Run all three locally before merging to `main`: nothing runs them on GitHub. The CI workflow (`.github/workflows/ci.yml`, typecheck and lint) runs only when started by hand, so a Task’s pull request reports no checks and TED merges it without waiting for CI. Agents never start GitHub workflows.
- `pnpm check` runs typecheck, lint and two Vitest processes at once.
- `pnpm check --affected` runs only the test files a branch’s changes affect, without typecheck or lint. `pnpm check --affected --list` prints the selection and stops. See [Affected tests](#affected-tests).
- `pnpm flaky <file> [-t <name>] [--runs N] [--load N]` runs one test file N times (default 5) alone under the full-run lock with one busy thread per core and no retry, and reports how many runs passed and which tests failed. Use it on a test that fails only in full runs, and fix the test’s timing rather than retrying it.

## What a Run may run

- Agents, TED’s own Runs included, never run `pnpm test` or `pnpm check`. The full suite runs only when the human or a merge runs `pnpm check`.
- In this Factory TED runs a Task’s tests itself, as the Affected tests Check (`pnpm check --affected` in `.ted/workflow.yaml`), before the Task leaves Work and at Validate entry. A Run picks no test files for coverage.
- The Task Lead in Validate runs test files only in two cases: the Electron app tests a sandboxed Check left out, and a single file to look into a failure. Work, the other Stages and sub-agents run none (`.ted/stages/work.md`, `.ted/stages/validate.md`).
- With `TED_RUN` set, `pnpm check`, `pnpm check --affected` (but not `--list`) and any Vitest run of more than 3 test files (`runTestFiles`) are refused before they take a lock (`runRefusal` and `affectedRefusal` in `scripts/check.ts`, `runRefusal` in `packages/daemon/test/support/suite-lock.ts`). `pnpm flaky` is refused under `TED_RUN` too.
- A Check is not a Run: TED starts it with `TED_TASK` and `CI=1` and without `TED_RUN` (`checkEnv` in `packages/daemon/src/tasks/checks.ts`, which drops every inherited `TED_*` variable), so the Check may run more than 3 files. Nothing else tells the two apart. An agent that unsets `TED_RUN` in its own shell gets past every one of these refusals, as it always could; they stop mistakes, not a Run that sets out to break the rule.

These limits are code in this repo, not TED settings. TED has no setting for a test-file limit.

## Affected tests

`pnpm check --affected` compares the working tree and `HEAD` with the merge-base of `HEAD` and `origin/<default branch>`, picks test files, prints each with the reason it was picked, and runs them. The selection is `affectedTests` in `scripts/affected.ts`; `checkAffected` in `scripts/check.ts` runs it.

A test file is picked for one of three reasons:

- **changed**: the change added or changed the test file, and it still exists.
- **imports**: the test file reaches a changed file through the import graph. The graph is read from the source text: a file points at every relative path (`./…`, `../…`) and every `@ted/<package>` entry it names in a quoted string, when that path is a file in the repo. That covers `import`, `import()`, and a fixture named with `new URL('./fixtures/stub-app.ts', import.meta.url)`. Test helpers, harnesses and fixtures are files like any other, so changing one runs the tests that use it.
- **app area** or **app smoke set**: for a changed file under `packages/app/src`, the Electron app tests in `packages/app/test`. Those tests launch the app instead of importing it, so the import graph can’t see them. A test’s area is its file name without `app-` in front and `-ui` or `-app` at the end (`app-settings.test.ts` is “setting”, `plans-ui.test.ts` is “plan”). A source file’s areas are its own name and its folders, leaving out `renderer`, `components`, `views` and `styles` (`renderer/settings/AgentsPage.tsx` is “agent page” and “setting”). Names are split into lower-case words and lose a plural `s`. A test is picked when its area and one of the file’s areas are the same words, or one starts with the other. A source file that matches no test runs the smoke set instead: `app.test.ts`, `app-settings.test.ts` and `app-task.test.ts` (`appSmokeTests`). The files every screen goes through (`main.ts`, `entry.ts`, `preload.cjs`, the renderer’s `index.html`, `main.tsx`, `Root.tsx`, `App.tsx` and `components/Sidebar.tsx`) run the smoke set as well as their own matches.

Every test counts as affected when the change touches what the test runner is made of (`runsEverything`): `vitest.config.ts` or `scripts/check.ts`, any file either of them reaches through the same graph (the setup files, `suite-lock.ts`, the stubs `vitest.config.ts` names, and the protocol modules the global setup imports), the root or a package’s `package.json`, `pnpm-lock.yaml` or `pnpm-workspace.yaml`.

How much of it runs:

- Up to 60 files (`maxAffectedFiles`), the whole set runs.
- Over 60, or when every test is affected, the run drops the test files that reach a changed file only through other files. What is left is the changed test files, the test files that import a changed file directly, and the app area and smoke set tests.
- If that is still over 60, it drops the direct importers too and runs the changed test files and the app tests, however many they are.
- `chooseTier` in `scripts/affected.ts` makes the choice. The command prints which set it took, each file with its reason, and how many files it left to the scheduled full check (the Scheduled Check that runs `pnpm check`).
- The limit is there because nearly every daemon test starts the daemon in-process and the app’s Electron tests import the daemon’s test helpers: a change to most files in `packages/daemon/src` reaches 270 or more test files, and a change to `packages/protocol/src` reaches all of them. Without the limit the Check would run for 20 to 30 minutes before a Task leaves Work and again at Validate entry.
- When git can’t say what changed, it runs every test.
- With nothing affected (docs only, for example) it says so and passes.
- The Check’s timeout in `.ted/workflow.yaml` is 60 minutes. In the last full run the 60 slowest test files took 95 minutes of file time on the `node` project and 21 on `electron`. With half the usual workers (load per core 1.5: 3 and 2) that is 32 minutes, and a run of ten or more files can first wait about 25 minutes behind someone’s full `pnpm check`. An average 60 files take 22 minutes with one worker. The default of 10 minutes is too short for either.

How it runs:

- It runs the `electron` and `node` projects as `pnpm check` does, each only when it has files, and no typecheck or lint.
- Ten or more files take the suite lock and get `pnpm check`’s worker counts. Fewer take one test slot and at most 3 workers per project, like any small run. Both scale down on a busy machine.
- It records no passing commit and doesn’t rewrite `ted-test-times.json`. Only a full `pnpm check` does.
- Inside a sandbox where Electron can’t start (see [Inside a sandbox](#inside-a-sandbox)), it leaves the Electron files out, prints them, and writes `node_modules/.cache/ted-affected-left-out.txt`: the Electron files that were changed or picked by name, to run by hand, and how many others were left out. A run outside the sandbox deletes the file. TED runs Checks in its sandbox unless the Factory is in Bypass, so on macOS the Task Lead runs the listed files in Validate, 3 per command.

## Vitest projects and workers

- The `electron` project holds the test files that use Playwright’s `_electron` or resolve the installed Electron executable, directly or through a relative import (`electronFiles` in `scripts/test-files.ts`). The `node` project holds the rest.
- `pnpm check` runs the `electron` project with 3 workers and the `node` project with 6. Any other run of 10 or more test files also gets 6 workers, because it runs alone. A smaller run gets 3, so two small runs side by side don’t take every core (`workersFor` in `vitest.config.ts`).
- On a branch whose changes since `origin/main` are all in `packages/app/src`, `packages/app/test` or docs, `pnpm check` runs only the tests in `packages/app/test` (`onlyAppChanged` in `scripts/check.ts`) and records no passing commit. `pnpm check --all`, any run on `main` and `pnpm release` run every test.
- Nearly every daemon test starts the whole daemon, so a change to `packages/daemon` or `packages/protocol` always needs them all.
- `pnpm check` writes per-file times to `node_modules/.cache/ted-test-times.json` and prints the 10 slowest.

## Retries in the `electron` project

- The `electron` project retries a failed test once, because app tests time out at random when the whole suite runs. A test that fails twice fails the run.
- `scripts/retry-reporter.ts` reports each test that failed and then passed. `pnpm check` prints it as “passed on retry” and keeps it as `passedOnRetry` in `node_modules/.cache/ted-test-failures.json` without failing the run. Treat such a test as broken and fix its timing.
- Keep each Electron test file to about a dozen app launches so no one file sets the run’s length.

## Sharing the machine: slots and the suite lock

Test runs share the machine through `packages/daemon/test/support/suite-lock.ts`, across every checkout.

- The global setup gives a run of fewer than 10 test files one of 2 slots in `~/.cache/ted/test-slots/`.
- A full run (10 or more files) takes `~/.cache/ted/test-suite.lock` and then every slot, so it runs alone. `pnpm check` holds them through dependency refresh and both of its Vitest processes.
- A run waits while live pids hold what it needs, says so, and takes over from a dead pid. A test command can therefore sit waiting before it starts.
- Waiting runs hold tickets in `~/.cache/ted/test-slots/queue/`, named with the time asked, the pid and `small` or `full`. Small runs get slots in the order they asked and don’t wait behind a waiting full run. Full runs go in the order they asked.
- A full run whose turn comes first lets the small runs that were already waiting go, for at most 5 minutes (`fullRunYieldMs`). It adds the time its turn came to its ticket, and small runs that ask at or after that time wait for it.
- A ticket without a kind is from a checkout with the older lock code: every run waits behind an earlier one, and no full run lets small runs go first while one waits.
- A small run that can’t write the slot folder runs without one.

## Logs of waits and failures

- Every run that takes a slot or the suite lock appends a `start` and an `end` line to `~/.cache/ted/test-waits.jsonl` (time waited, time running, file count, folder). `pnpm test-waits [days]` sums them by kind, day and folder.
- Every Vitest run, `pnpm check`’s two processes included, appends to `~/.cache/ted/test-failures.jsonl` when it ends (`recordVitestRun` in `scripts/failure-log.ts`, called from the global setup’s teardown): one `run` line with the time, the checkout, `small` or `full` and the test files that finished, and one `test` line for each test that failed or passed on retry. A run that can’t write the file carries on. Lines older than 90 days are dropped about once a day.
- `pnpm test-failures [days]` ranks tests and files by how often they failed, with the rate over the runs that included the file, and leaves out runs with more than 10 failed tests (`brokenRunTests`).
- `TED_TEST_FAILURES_FILE` names another file or, as `off`, records nothing. `vitest.config.ts` sets `off` for every test file, so a Vitest run a test starts is never recorded.

## Machine load

- A test run reads the 1-minute load per core when it starts (`scripts/machine-load.ts`). Above 0.75, `pnpm check` and plain Vitest runs multiply their worker counts by 0.75 ÷ load, never below 1, print one line saying so, and record `load` and `workers` in the run line of `~/.cache/ted/test-failures.jsonl`, which `pnpm test-failures` shows as a `busy` column.
- `pnpm check --wait-for-quiet[=<minutes>]` (or `TED_CHECK_WAIT_FOR_QUIET`) instead waits, holding the test lock, until the load is 0.75 or below, for at most 30 minutes, then starts anyway.
- `TED_TEST_LOAD=off` ignores the load and a number replaces it. `vitest.config.ts` sets `off` for every test file.

## Electron in tests and scripts

- Resolve the native test executable with `resolveElectron` from `packages/app/test/support/electron-installation.ts`, never by requiring `electron`: its loader can install concurrently in workers. The native project’s preflight prepares it once before collection.
- Launch an app in a test with `firstWindow` from `packages/app/test/first-window.ts`, which waits 60 seconds for the window.
- To try the app from a one-off script, launch it only through `withApp` in `packages/app/scripts/with-app.ts`. It builds the renderer, opens a hidden window with its own `TED_HOME`, skips the onboarding steps unless `onboarding: true`, and always closes the app and stops its daemon, even when the script throws or calls `process.exit`. Never launch Electron from a script by hand or leave it running.

## Inside a sandbox

- Inside Codex’s sandbox (`CODEX_SANDBOX` set), and on macOS inside TED’s own sandbox (`TED_SANDBOX=1`, which `sandbox.ts` sets on every command it wraps), the Electron test files are skipped with a warning. macOS stops Electron registering as an app there, and every launch aborts with a “quit unexpectedly” dialog.
- `pnpm app` refuses there for the same reason (`sandboxRefusal` in `packages/app/scripts/sandbox-refusal.ts`), unless the sandbox is an Electron App’s, which allows the one service Electron needs and sets `TED_SANDBOX_ELECTRON=1`. TED Dev is that kind of App in `.ted/workflow.yaml`, so an Automation Run’s `ted run-app "TED Dev"` starts it hidden in the sandbox (ADR 0153-an-automation-run-drives-its-electron-apps-over-their-debugging-port).

## Release

A release is built and tried on this Mac first, then published (ADR 0154-releases-are-built-tried-and-then-published-from-this-mac, ADR 0165-releases-build-in-their-own-worktree-and-publish-the-tag).

- `pnpm release <version>` builds in its own detached worktree beside the repo, at `<repo folder>-release` (`ted-release` next to a clone in `ted`), not inside `.git`, where Vite refuses to serve test files, so `main` can keep moving, here and on GitHub, while a release is tested, built and published. It fetches, checks that worktree out at `origin/main` (refusing while it holds changes or a build that isn’t published), runs `pnpm install` there and runs the rest of the release from that checkout’s own `scripts/release.ts`. `publish`, `discard` and `--install` run there too. It checks that the tag isn’t on GitHub yet. It needs a Developer ID Application identity in the keychain (`CSC_NAME` or `TED_SIGN_IDENTITY` may name one, and nothing else; `CSC_LINK` is refused) and notarization credentials: the keychain profile `ted-notary` saved with `xcrun notarytool store-credentials` (or `TED_NOTARY_PROFILE`), or electron-builder’s `APPLE_*` variables. It runs typecheck, lint and the tests unless `pnpm check` already passed on that exact commit (it records passing commits in `.git/ted-checked`). `--skip-checks` skips them anyway, says so, and records nothing; use it only when you have decided to release a commit that hasn’t passed a full run. Then it bumps the version, commits, tags `v<version>` locally, builds the signed, notarized Apple silicon app with its `.dmg`, `.zip` and `latest-mac.yml`, checks the signature, Gatekeeper and the stapled ticket, smoke-tests the build and installs it in `/Applications`. It asks the `claude` CLI (`claude -p --tools "" --strict-mcp-config` in an empty temporary folder, five minutes at most, so a planted change title can’t make it read or run anything) to draft the release notes from the merges since the last tag, and writes them to `packages/app/dist/release/release-notes.md` in the release worktree with **Features**, **Fixes** and **Other** sections, a **Major** section above them only when some changes stand out (one Major line may sum up several pull requests), and a full-changelog link; only the change titles, pull request numbers and folders touched go into the prompt (`notesPrompt`). Each change appears in one section only: `withoutMajorRepeats` drops a line below Major whose pull requests are all under Major. When Claude fails, its answer has no section heading, or its Major section is empty, it falls back to a plain draft: an empty **Major** section to write by hand or delete, then **Features**, **Fixes** and **Other**, one line per merge since the last tag (the first commit of each merged branch, with its pull request number), sorted by `changeKind` (only tests, docs, scripts or `.ted/` is Other; a `fix/` branch or a title starting with Fix, Stop, Don’t, Wait, Refuse, Restore, Prevent, Avoid, Correct or Repair is a fix), and a full-changelog link. It pushes and uploads nothing. It writes `packages/app/dist/release/ted-release.json` in the release worktree with the version, the commit it built, the commit it started from and each file’s SHA-512.
- `pnpm release publish` refuses unless the release worktree’s `HEAD` and the tag are at the built commit, every file matches its recorded hash, the tag isn’t on GitHub at another commit, the release notes exist and have no empty Major section, and the repo is public. Then it pushes only the tag, creates the GitHub release with the files and those notes, and puts the version change on `main`: a fast-forward when `main` hasn’t moved, otherwise a merge commit made with `git merge-tree` and `git commit-tree` and pushed without force, tried 3 times; a conflict stops it with a message to merge the tag by hand. Running it again after a partial failure pushes nothing twice, uploads to the existing release and skips a version change already on `main`. Run from a checkout on `main`, it then runs `git pull --ff-only` there; when that can’t fast-forward, or the checkout is on another branch, it says to pull by hand and still succeeds. After the version change is on `main`, it offers the release on the website: in a scratch worktree of the website repo’s `origin/main` (`TED_WEBSITE_DIR`, by default `~/Websites/ted-and-bill`) it writes `src/data/release.json` with the version, the publish date and a direct link to the `.dmg`, commits it and pushes `main`, which Cloudflare deploys. It skips the website when that file isn’t there, and does nothing when the website already offers the version.
- `pnpm release discard` works only while the tag isn’t on GitHub: it deletes the local tag, undoes the release commit with `git reset --keep` when `HEAD` is still that commit, and deletes the record, so the same version can be built again.
- `pnpm release --install` installs the last build again.
- The GitHub release workflow runs only when started by hand.
