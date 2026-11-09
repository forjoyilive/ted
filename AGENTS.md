# TED

TED (“Totally Excellent Development”) is a desktop app for running software factories: agents carry development tasks through a configurable workflow, and the human steers through an inbox and comments. Vocabulary lives in `GLOSSARY.md`; use its terms.

## Code

pnpm workspace on Node 24: `packages/protocol` (paths, `daemon.json`, API types, `DaemonClient`), `packages/daemon`, `packages/cli`, `packages/app` (Electron, React renderer). Node and Electron run the `.ts` files directly. Only the renderer has a build step (Vite), and the preload stays plain `.cjs` because Electron’s sandboxed preload loader doesn’t strip types (ADR 0011).

- `pnpm install`, then `pnpm typecheck`, `pnpm lint` (Biome; `pnpm format` fixes), `pnpm test` (Vitest). CI runs all three on Ubuntu.
- `pnpm ted <args>` runs the `ted` CLI from source. It starts the daemon if needed.
- `pnpm app` builds the renderer and opens the app from source. Like `ted`, it reuses a running daemon or starts one.
- `pnpm ted dev run start [--cwd <dir>] "<prompt>"` starts a Claude Code Run in a detached host; `pnpm ted dev run show <run-id>` prints its state and Conversation.
- `pnpm ted dev factory add <owner/repo | git URL> --key NB` adds a one-repo Factory and clones it into `TED_HOME/repos/`. Then `pnpm ted task create --factory NB "<title>"` and `pnpm ted task start NB-1` start a Claude Code Task Lead in the Task’s worktree. `pnpm ted help` lists every command.
- Set `TED_HOME` to use a folder other than `~/.ted`. Tests always set it to a temp folder. `TED_IDLE_EXIT_MS` shortens the idle exit of a daemon that `ted` or the app started. `TED_CLAUDE_BIN` names the `claude` binary the daemon starts.
- Write erasable TypeScript only, and name the `.ts` file in relative imports (ADR 0008).
- Only `packages/daemon/src/store/` imports LiveStore. Events are named `v<N>.<PastTense>` and never edited once shipped; a change is a new versioned event (ADR 0010).
- Every daemon route sits behind the loopback guard in `packages/daemon/src/server.ts`; clients call the daemon only through `DaemonClient` (ADR 0009). A route is closed to Run tokens unless it sets `runToken: true`, which only actions spec 2.3 allows may set (ADR 0015).
- The renderer reaches the daemon only through `window.ted`. A new daemon call goes in `requests` in `packages/app/src/main.ts` and in `packages/app/src/renderer/ted.ts`; the preload stays as it is (ADR 0011).
- A new kind of live update is a new `DaemonEvent` variant, emitted by `TedStore` after its commit (ADR 0012).
- Only `packages/daemon/src/tasks/` starts Tasks or changes their Stage; it owns the order of git, commit and Run steps (ADR 0016). A route open to Runs acts only on the Run’s own Task, and only the Task Lead reports outcomes.
- The preamble and built-in Stage files are Markdown in `packages/daemon/src/workflow/defaults/`; the preamble names only `ted` commands that exist (ADR 0017).
- Code that knows how a particular agent CLI starts or what its output means lives only in `packages/daemon/src/agents/` (ADR 0014). The host’s `launch.json` and `host.log` formats only ever gain fields, because a running host can outlive a daemon update (ADR 0013).
- In the Electron main process, start work from `app.whenReady().then(...)`. Electron emits `ready` only after the ESM entry finishes evaluating, so a top-level `await` on it hangs.
- On Linux, a process spawned from Electron’s main process inherits Chromium’s open descriptors. Start the daemon only through `withDaemon`, which closes them (ADR 0011); any other long-lived process spawned from the app needs the same treatment.
- Test through public seams: `TedStore`, the daemon’s HTTP API, the daemon process, the `ted` binary, the Electron app (through Playwright’s `_electron`). Tests that start Runs use the stub agent `packages/daemon/test/fixtures/stub-claude.ts` and call `killRunHosts` in cleanup, because hosts outlive the daemon. The stub follows the `{"steps": […]}` JSON in its prompt, or on any one line of it, so a Task Lead test puts the steps in the Task’s title. Tests that start Tasks clone a local repo made by `makeOriginRepo` in `packages/daemon/test/helpers.ts`. CI runs the tests under `xvfb-run`.

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
