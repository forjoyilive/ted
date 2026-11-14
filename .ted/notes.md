# TED

TED (“Totally Excellent Development”) is a desktop app for running software factories: agents carry development tasks through a configurable workflow, and the human steers through an inbox and comments. `AGENTS.md` at the repo root is the full guide to the code and its rules; read it before changing anything. Use the terms in `GLOSSARY.md`.

## Repos

One repo, `forjoyilive/ted`: a pnpm workspace on Node 24.

- `packages/protocol`: paths, `daemon.json`, API types and `DaemonClient`.
- `packages/daemon`: the daemon, its store, Runs, Tasks, Apps and GitHub work.
- `packages/cli`: the `ted` command.
- `packages/app`: the Electron app and its React renderer.

## Running it locally

- Nothing runs on GitHub when a pull request opens or `main` changes: the CI workflow (typecheck and lint) runs only when the human starts it by hand, and the full suite never runs there. Agents never start GitHub workflows. Local testing follows `AGENTS.md` and [This repo’s test tooling](../docs/testing/test-tooling.md).
- `pnpm install`, then `pnpm typecheck` and `pnpm lint`. This Factory’s Stage files reserve tests for the Task Lead in Validate: the test files the change touches, with `pnpm vitest run <files>`. No other Stage and no sub-agent runs test files. Never run `pnpm test`, `pnpm check` or a whole test folder: this repo’s test helpers refuse a Run’s test run of more than 3 files, because every test run makes other Runs wait. See [Factory validation](../docs/testing/factory-validation.md) when choosing validation rules for another Factory.
- `pnpm app` builds the renderer and opens TED Dev from source; `pnpm ted <args>` runs the CLI from source.
- TED Dev is an Electron App in `.ted/workflow.yaml` (`electron: true`), so `ted run-app "TED Dev"` starts it hidden inside TED’s sandbox. Plain `pnpm app` refuses in the sandbox, because Electron can’t open there. To drive the app from a script, use `withApp` from `packages/app/scripts/with-app.ts`, or extend an app test. The human can also start TED Dev with ▶.
- For isolated CLI trials, use `env -u TED_RUN_CAPABILITY -u TED_RUN_TOKEN -u TED_RUN -u TED_TASK -u TED_PLAN TED_HOME="$PWD/node_modules/.cache/ted-home" pnpm ted <args>`. Keep TED’s Task-control commands in the normal Run environment.
- In a Task, always set `TED_HOME` to the Task’s own folder, `node_modules/.cache/ted-home` in the worktree, which the TED Dev App already uses. Never use `~/.ted` (the installed TED that runs this Factory) or `~/.ted-dev`.

## Where things live

- Issues: Linear, team Kriya Design (`KRI`), project TED.
- Designs: the Figma file named in `AGENTS.md`.
- Spec and decisions: `docs/spec/` and `docs/adr/`.

## House style

- Plain, direct language in code, docs, commit messages and UI text.
- Curly quotes and apostrophes in prose and user-facing text; straight ones in code.
- No code comments unless they record something the code can’t say: an upstream bug, a platform quirk, a required order.
