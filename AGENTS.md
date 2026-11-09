# TED

TED (“Totally Excellent Development”) is a desktop app for running software factories: agents carry development tasks through a configurable workflow, and the human steers through an inbox and comments. Vocabulary lives in `GLOSSARY.md`; use its terms.

## Code

pnpm workspace on Node 24: `packages/protocol` (paths, `daemon.json`, API types, `DaemonClient`), `packages/daemon`, `packages/cli`, `packages/app` (Electron, React renderer). Node and Electron run the `.ts` files directly. Only the renderer has a build step (Vite), and the preload stays plain `.cjs` because Electron’s sandboxed preload loader doesn’t strip types (ADR 0011).

- `pnpm install`, then `pnpm typecheck`, `pnpm lint` (Biome; `pnpm format` fixes), `pnpm test` (Vitest). CI runs all three on Ubuntu.
- `pnpm ted <args>` runs the `ted` CLI from source. It starts the daemon if needed.
- `pnpm app` builds the renderer and opens the app from source. Like `ted`, it reuses a running daemon or starts one.
- `pnpm ted dev run start [--agent claude|codex] [--cwd <dir>] "<prompt>"` starts a Run in a detached host; `pnpm ted dev run show <run-id>` prints its state and Conversation.
- `pnpm ted dev factory add <owner/repo | git URL> --key NB [--local-folder <dir>]` adds a one-repo Factory and clones it into `TED_HOME/repos/`; `pnpm ted dev factory local-folder NB <dir>` changes the folder `worktree.copy` reads from. Then `pnpm ted task create --factory NB "<title>"` and `pnpm ted task start NB-1` start a Claude Code Task Lead in the Task’s worktree. `pnpm ted help` lists every command.
- Set `TED_HOME` to use a folder other than `~/.ted`. Tests always set it to a temp folder. `TED_IDLE_EXIT_MS` shortens the idle exit of a daemon that `ted` or the app started. `TED_CLAUDE_BIN` and `TED_CODEX_BIN` name the `claude` and `codex` binaries the daemon starts.
- Write erasable TypeScript only, and name the `.ts` file in relative imports (ADR 0008).
- Only `packages/daemon/src/store/` imports LiveStore. Events are named `v<N>.<PastTense>` and never edited once shipped; a change is a new versioned event (ADR 0010).
- Every daemon route sits behind the loopback guard in `packages/daemon/src/server.ts`; clients call the daemon only through `DaemonClient` (ADR 0009). A route is closed to Run tokens unless it sets `runToken: true`, which only actions spec 2.3 allows may set (ADR 0015).
- The renderer reaches the daemon only through `window.ted`. A new daemon call goes in `requests` in `packages/app/src/main.ts` and in `packages/app/src/renderer/ted.ts`; the preload stays as it is (ADR 0011).
- Every renderer colour is a token in `packages/app/src/renderer/styles/tokens.css`, written as `light-dark(<light>, <dark>)` with Figma’s Theme variable name; components use a CSS Module and `var(--…)` only, and `packages/app/test/theme.test.ts` fails on any other colour. Reuse the shared components in `packages/app/src/renderer/components/` (ADR 0020).
- A Task’s status, markers and activity line are chosen only in `packages/daemon/src/tasks/status.ts` from `TaskFacts`; a new input is a new `TaskFacts` field, and the app only draws what the Task carries (ADR 0023).
- A new machine setting is a field and default in `packages/protocol/src/settings.ts` plus a parser in `settingParsers` in `packages/daemon/src/server.ts`; every change is one `v1.MachineSettingsChanged` event. A new App Settings page is a component in `packages/app/src/renderer/settings/`, listed in `settingsSections` in `sections.tsx` (ADR 0024).
- Text the daemon logs or puts in Copy report goes through `redactSecrets` in `packages/daemon/src/redact.ts`, which removes URL passwords and token-shaped strings (ADR 0024).
- A new kind of live update is a new `DaemonEvent` variant, emitted by `TedStore` after its commit (ADR 0012), or by `packages/daemon/src/data.ts` for the store’s own status.
- A machine or Factory problem shows as a banner: call `banners.raise(…)` where you detect it and `banners.clear(…)` where it resolves, through `packages/daemon/src/banners.ts`; a button that does work in the daemon registers `banners.onAction(problem, handler)`. A stops-work problem starting is the `banner-raised` event (ADR 0021).
- `packages/daemon/src/data.ts` opens the store, takes backups and restores them; a route that needs the store gets it through `data.services()`, so it waits while the store opens and answers `503` while a data screen is up. Only `/events`, `/data-status` and `/backups` work before the store opens (ADR 0026). `pnpm ted backup list` and `pnpm ted backup restore <name>` work on `TED_HOME/backups/`.
- Only `packages/daemon/src/tasks/` starts Tasks or changes their Stage; it owns the order of git, commit and Run steps (ADR 0016). A route open to Runs acts only on the Run’s own Task, and only the Task Lead reports outcomes.
- The preamble and built-in Stage files are Markdown in `packages/daemon/src/workflow/defaults/`; the preamble names only `ted` commands that exist (ADR 0017).
- The Workflow is resolved only through `Workflows.resolve` in `packages/daemon/src/workflow/workflows.ts`, at each Stage entry; every Stage entry records the layers and Stage file it used. The Library lives in `TED_HOME/library/`, the Factory layer is `.ted/` on `origin/<default branch>`. `pnpm ted workflow check [<path>]` validates a layer (ADR 0019).
- A Task’s Task Lead field (`lead`: agent, model, effort) is compared with its live Task Lead Run in `tasks/`; a model or effort change goes through `RunManager.restart`, which restarts the agent inside the same host and the same Run, and only at an idle point. An agent change stops the Run and starts a fresh one. `pnpm ted task lead <id> claude|codex [--model] [--effort]` sets it (ADR 0027).
- A Task’s worktree lifecycle (copy, `setup`, `teardown`, removal) lives in `packages/daemon/src/tasks/`; every command run in a worktree gets `worktree.env` minus the reserved names in `isReservedEnvName` (`workflow/check.ts`), a resumed setup runs the command recorded when it started, and copy never reads outside the local folder or writes outside the worktree (ADR 0025).
- To send a live Run a message, use `RunManager.send`, which appends to the Run’s `input.jsonl`; the host forwards it to the agent’s stdin (ADR 0019).
- Code that knows how a particular agent CLI starts or what its output means lives only in `packages/daemon/src/agents/` (ADR 0014). Codex runs as `codex app-server`, driven by `agents/codex-driver.ts` inside the host (ADR 0018). The host’s `launch.json` and `host.log` formats only ever gain fields, because a running host can outlive a daemon update (ADR 0013).
- In the Electron main process, start work from `app.whenReady().then(...)`. Electron emits `ready` only after the ESM entry finishes evaluating, so a top-level `await` on it hangs.
- Closing the window hides it and Quit ends the daemon through `POST /shutdown`; the menus, quit decision and dialog text are plain functions in `packages/app/src/background.ts`, tested without Electron, and `main.ts` only wires them up. Anything that should keep TED running or count as waiting goes into `TedStore.activity()` (ADR 0028). Launch the app with `TED_HIDDEN_WINDOW=1` in tests and scripts: no window, tray icon, notification or quit dialog.
- On Linux, a process spawned from Electron’s main process inherits Chromium’s open descriptors. Start the daemon only through `withDaemon`, which closes them (ADR 0011); any other long-lived process spawned from the app needs the same treatment.
- Test through public seams: `TedStore`, the daemon’s HTTP API, the daemon process, the `ted` binary, the Electron app (through Playwright’s `_electron`). Tests that start Runs use the stub agents `packages/daemon/test/fixtures/stub-claude.ts` and `stub-codex.ts` and call `killRunHosts` in cleanup, because hosts outlive the daemon. The stub follows the `{"steps": […]}` JSON in its prompt, or on any one line of it, so a Task Lead test puts the steps in the Task’s title. Tests that start Tasks clone a local repo made by `makeOriginRepo` in `packages/daemon/test/helpers.ts`. CI runs the tests under `xvfb-run`.

## Issue tracker: Linear

- Workspace `kriyadesign`, team **Kriya Design** (`KRI`), project **TED**: https://linear.app/kriyadesign/project/ted-4c57b190ffe4/overview
- Create every issue in that team and project. Check for an existing issue before creating one.
- Comments and discussion go on the issue as Linear comments.

### Wayfinding operations

Used by `/wayfinder`.

- **Map**: an issue in the TED project labelled `wayfinder:map`.
- **Ticket**: a sub-issue of the map (`parentId` = the map), labelled with exactly one of `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, `wayfinder:task`. Map and tickets carry no other labels.
- **Blocking**: Linear’s native “blocked by” relation.
- **Frontier**: open sub-issues of the map with no assignee whose blockers are all completed or canceled; lowest identifier first.
- **Claim**: assign the ticket to the dev driving the map before any work.
- **Resolve**: post the answer as a comment, move the ticket to Done, then add a line (linked title + one-line gist) to the map’s Decisions so far.
- **Out of scope**: move the ticket to Canceled and add a line to the map’s Out of scope section.

## Code review before merge

Every code change gets a review before it merges to `main`, usually from Codex (`/codex-review`). Fix or answer each confirmed finding before merging.

A change also gets a security review (`/security-review`) before merging if it touches any of these: starting agents or running shell commands, messages between processes, credentials or tokens, network requests, or reading and writing files outside the repo being worked on.

## Designs: Figma

- File: https://www.figma.com/design/SLTyztzQXHFdz4sk3TcePk/TED?node-id=0-1 (file key `SLTyztzQXHFdz4sk3TcePk`)
- Put designs and prototypes on that page or on sibling pages in the same file. Link the frame from the Linear issue it answers.

## Domain docs

- `GLOSSARY.md` at the repo root. Architecture decisions go in `docs/adr/`.
- The v1 spec is `docs/spec/ted-v1-spec.md`. Next to it are `ted-v1-gaps.md`, which holds the open questions, and `ted-v1-screens.md`, which maps each screen to its Figma frames.
