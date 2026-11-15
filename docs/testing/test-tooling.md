# This repo’s test tooling

This page describes the tooling used to develop TED in this repo: `pnpm check`, the Vitest setup, the locks that let test runs share one machine, the logs they write, and `pnpm release`. None of it is part of the TED app, and no other Factory gets it. For what TED itself does at Validate, and how another Factory chooses its own rules, read [Factory validation](factory-validation.md).

The rules an agent must follow are repeated in `AGENTS.md`. This page holds the detail.

## Commands

- `pnpm install`, then `pnpm typecheck`, `pnpm lint` (Biome; `pnpm format` fixes) and `pnpm test` (Vitest).
- Run all three locally before merging to `main`: nothing runs them on GitHub. The CI workflow (`.github/workflows/ci.yml`, typecheck and lint) runs only when started by hand, so a Task’s pull request reports no checks and TED merges it without waiting for CI. Agents never start GitHub workflows.
- `pnpm check` runs typecheck, lint and two Vitest processes at once.
- `pnpm flaky <file> [-t <name>] [--runs N] [--load N]` runs one test file N times (default 5) alone under the full-run lock with one busy thread per core and no retry, and reports how many runs passed and which tests failed. Use it on a test that fails only in full runs, and fix the test’s timing rather than retrying it.

## What a Run may run

- Agents, TED’s own Runs included, run only the test files their change touches (`pnpm vitest run <files>`) and never `pnpm test` or `pnpm check`. The full suite runs only when the human or a merge runs `pnpm check`.
- A Run in this Factory runs test files only in Validate, as the Task Lead, once per visit. Work, the other Stages and sub-agents run none (`.ted/stages/work.md`, `.ted/stages/validate.md`).
- With `TED_RUN` set, `pnpm check` and any Vitest run of more than 3 test files (`runTestFiles`) are refused before they take a lock (`runRefusal` in `scripts/check.ts` and in `packages/daemon/test/support/suite-lock.ts`). `pnpm flaky` is refused under `TED_RUN` too.

These limits are code in this repo, not TED settings. TED has no setting for a test-file limit.

## Vitest projects and workers

- The `electron` project holds the test files that use Playwright’s `_electron` or resolve the installed Electron executable, directly or through a relative import. The `node` project holds the rest.
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

- `pnpm release <version>` builds in its own detached worktree beside the repo, at `<repo folder>-release` (`ted-release` next to a clone in `ted`), not inside `.git`, where Vite refuses to serve test files, so `main` can keep moving, here and on GitHub, while a release is tested, built and published. It fetches, checks that worktree out at `origin/main` (refusing while it holds changes or a build that isn’t published), runs `pnpm install` there and runs the rest of the release from that checkout’s own `scripts/release.ts`. `publish`, `discard` and `--install` run there too. It checks that the tag isn’t on GitHub yet. It needs a Developer ID Application identity in the keychain (`CSC_NAME` or `TED_SIGN_IDENTITY` may name one, and nothing else; `CSC_LINK` is refused) and notarization credentials: the keychain profile `ted-notary` saved with `xcrun notarytool store-credentials` (or `TED_NOTARY_PROFILE`), or electron-builder’s `APPLE_*` variables. It runs typecheck, lint and the tests unless `pnpm check` already passed on that exact commit (it records passing commits in `.git/ted-checked`). Then it bumps the version, commits, tags `v<version>` locally, builds the signed, notarized Apple silicon app with its `.dmg`, `.zip` and `latest-mac.yml`, checks the signature, Gatekeeper and the stapled ticket, smoke-tests the build and installs it in `/Applications`. It pushes and uploads nothing. It writes `packages/app/dist/release/ted-release.json` in the release worktree with the version, the commit it built, the commit it started from and each file’s SHA-512.
- `pnpm release publish` refuses unless the release worktree’s `HEAD` and the tag are at the built commit, every file matches its recorded hash, the tag isn’t on GitHub at another commit, and the repo is public. Then it pushes only the tag, creates the GitHub release with the files and GitHub’s generated notes, and puts the version change on `main`: a fast-forward when `main` hasn’t moved, otherwise a merge commit made with `git merge-tree` and `git commit-tree` and pushed without force, tried 3 times; a conflict stops it with a message to merge the tag by hand. Running it again after a partial failure pushes nothing twice, uploads to the existing release and skips a version change already on `main`. Run from a checkout on `main`, it then runs `git pull --ff-only` there; when that can’t fast-forward, or the checkout is on another branch, it says to pull by hand and still succeeds. After the version change is on `main`, it offers the release on the website: in a scratch worktree of the website repo’s `origin/main` (`TED_WEBSITE_DIR`, by default `~/Websites/ted-and-bill`) it writes `src/data/release.json` with the version, the publish date and a direct link to the `.dmg`, commits it and pushes `main`, which Cloudflare deploys. It skips the website when that file isn’t there, and does nothing when the website already offers the version.
- `pnpm release discard` works only while the tag isn’t on GitHub: it deletes the local tag, undoes the release commit with `git reset --keep` when `HEAD` is still that commit, and deletes the record, so the same version can be built again.
- `pnpm release --install` installs the last build again.
- The GitHub release workflow runs only when started by hand.
