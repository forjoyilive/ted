# Ted

Ted (“Totally Excellent Development”) is a desktop app for running software factories: agents carry development tasks through a configurable workflow, and the human steers through an inbox and comments. `AGENTS.md` at the repo root is the full guide to the code and its rules; read it before changing anything. Use the terms in `GLOSSARY.md`.

## Repos

Two repos, both pnpm workspaces on Node 24. Each has its own `AGENTS.md`; read the one for each repo the Task touches.

`ted` (`forjoyilive/ted`), the desktop app:

- `packages/protocol`: paths, `daemon.json`, API types and `DaemonClient`.
- `packages/daemon`: the daemon, its store, Runs, Tasks, Apps and GitHub work.
- `packages/cli`: the `ted` command.
- `packages/app`: the Electron app and its React renderer.

`ted-mobile` (`forjoyilive/ted-mobile`), the iPhone app and the relay it talks to Ted through:

- `app/`: the phone app, Expo (React Native), iPhone only.
- `relay/`: the relay, a Cloudflare Worker.
- `docs/phone-relay.md` is the wire protocol and has an identical copy in `ted`; change both together.

## Running it locally

- Nothing runs on GitHub when a pull request opens or `main` changes: the CI workflow (typecheck and lint) runs only when the human starts it by hand, and the full suite never runs there. Agents never start GitHub workflows. Local testing follows `AGENTS.md` and [This repo’s test tooling](../docs/testing/test-tooling.md).
- `pnpm install`, then `pnpm typecheck` and `pnpm lint`. Ted runs the tests a change affects as the Affected tests check (`pnpm check --affected`). A Run picks no test files for coverage: the Task Lead in Validate runs only the test files a sandboxed check left out (Electron app tests, and tests the sandbox made skip themselves), and a single file to look into a failure, with `pnpm vitest run <files>`. No other Stage and no sub-agent runs test files. Never run `pnpm test`, `pnpm check` or a whole test folder: this repo’s test helpers refuse a Run’s test run of more than 3 files, because every test run makes other Runs wait. See [Factory validation](../docs/testing/factory-validation.md) when choosing validation rules for another Factory.
- `pnpm app` builds the renderer and opens Ted Dev from source; `pnpm ted <args>` runs the CLI from source.
- Ted Dev is an Electron App in `.ted/workflow.yaml` (`electron: true`), so `ted run-app "Ted Dev"` starts it hidden inside Ted’s sandbox. Plain `pnpm app` refuses in the sandbox, because Electron can’t open there. To drive the app from a script, use `withApp` from `packages/app/scripts/with-app.ts`, or extend an app test. The human can also start Ted Dev with ▶.
- For isolated CLI trials, use `env -u TED_RUN_CAPABILITY -u TED_RUN_TOKEN -u TED_RUN -u TED_TASK -u TED_PLAN TED_HOME="$PWD/node_modules/.cache/ted-home" pnpm ted <args>`. Keep Ted’s Task-control commands in the normal Run environment.
- In a Task, always set `TED_HOME` to the Task’s own folder, `node_modules/.cache/ted-home` in the worktree, which the Ted Dev App already uses. Never use `~/.ted` (the installed Ted that runs this Factory) or `~/.ted-dev`.

## Running the iPhone app

- In `ted-mobile`: `pnpm typecheck`, `pnpm lint` and `pnpm test`. Ted runs them as the Mobile Typecheck, Mobile Lint and Mobile Tests checks.
- Start the phone app only with `ted run-app "Ted Dev iPhone"` (pairs with Ted Dev) or `ted run-app "Ted iPhone"` (pairs with release Ted), never `pnpm ios` yourself. Each runs in the Task’s own simulator; `ted app screenshot <App>` saves its screen.
- In Validate, starting Ted Dev iPhone also starts an isolated desktop preview and local relay, including on mobile-only Tasks. Use [Paired iPhone previews](../docs/development/paired-iphone-preview.md). For pairing during ordinary local development, `pnpm relay` starts the relay at `http://127.0.0.1:8787`. Stop it when you are done.
- Agents never deploy the relay or change a Cloudflare account, and never build for TestFlight or the App Store (`eas build`, `eas submit`, `eas update`).

## Where things live

- Issues: Linear, team Kriya Design (`KRI`), project Ted.
- Designs: the Figma file named in `AGENTS.md`.
- Decisions: the area files in `docs/agents/`.

## House style

- Plain, direct language in code, docs, commit messages and UI text.
- Curly quotes and apostrophes in prose and user-facing text; straight ones in code.
- No code comments unless they record something the code can’t say: an upstream bug, a platform quirk, a required order.
