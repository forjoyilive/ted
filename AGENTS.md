# Ted

Ted (“Totally Excellent Development”) is a desktop app for running software factories: agents carry development tasks through a configurable workflow, and the human steers through an inbox and comments. Vocabulary lives in `GLOSSARY.md`; use its terms.

## Code

For validation policy and Factory customization, read [Factory validation](docs/testing/factory-validation.md). The test tooling in this repo (`pnpm check`, the Vitest setup, the test locks and logs, `pnpm release`) is development tooling, not part of the app; its detail is in [This repo’s test tooling](docs/testing/test-tooling.md).

pnpm workspace on Node 24: `packages/protocol` (paths, `daemon.json`, API types, `DaemonClient`), `packages/daemon`, `packages/cli`, `packages/app` (Electron, React renderer). Node and Electron run the `.ts` files directly. Only the renderer has a build step (Vite), and the preload stays plain `.cjs` because Electron’s sandboxed preload loader doesn’t strip types.

- `pnpm install`, then `pnpm typecheck`, `pnpm lint` (Biome, then Oxlint with the anti-slop rules below; `pnpm format` fixes what both can), `pnpm test` (Vitest). Run all three locally before merging to `main`: nothing runs them on GitHub, and agents never start GitHub workflows. Agents, Ted’s own Runs included, run only the test files their change touches (`pnpm vitest run <files>`) and never `pnpm test`, `pnpm check` or `pnpm flaky`; with `TED_RUN` set, those and any Vitest run of more than 3 test files are refused. In this Factory Ted chooses and runs a Task’s tests itself: the Affected tests Check (`pnpm check --affected`, `scripts/affected.ts`) runs every changed test file, the node test files that import a changed file themselves, and the Electron app tests named after changed app source (`chooseTests`); test files that reach a changed file only through other files are left to the scheduled full check, and a file Typecheck covers (only re-exports, or only types changed) picks none. A Run picks no test files for coverage; the Task Lead in Validate runs only the Electron app tests a sandboxed Check left out (`node_modules/.cache/ted-affected-left-out.txt`) and a single file to look into a failure (`.ted/stages/work.md`, `.ted/stages/validate.md`). `pnpm check --affected --list` prints the selection and the reason for each file without running anything. A test command can sit waiting for a test slot before it starts; let it wait. A test that passed on retry is broken: fix its timing. Keep each Electron test file to about a dozen app launches. Resolve the native test executable with `resolveElectron` from `packages/app/test/support/electron-installation.ts`, never by requiring `electron`, and launch an app in a test with `firstWindow` from `packages/app/test/first-window.ts`. To try the app from a one-off script, launch it only through `withApp` in `packages/app/scripts/with-app.ts`; never launch Electron from a script by hand or leave it running. Inside Codex’s sandbox, and on macOS inside Ted’s own sandbox (`TED_SANDBOX=1`), the Electron test files are skipped and `pnpm app` refuses, unless the sandbox is an Electron App’s (`TED_SANDBOX_ELECTRON=1`), as Ted Dev’s is. Read [This repo’s test tooling](docs/testing/test-tooling.md) before changing `scripts/`, `vitest.config.ts` or `packages/daemon/test/support/`: it covers the Vitest projects and worker counts, the slots and suite lock that let runs share the machine, the wait and failure logs, machine load, `pnpm flaky` and `pnpm release`.
- Code run from source is Ted Dev; only the code `pnpm package` stages is the release. `edition` in `packages/protocol/src/edition.ts` says which, and `markRelease` in `packages/app/scripts/stage.ts` is the only thing that changes it. Anything machine-wide (home folder, app name and userData, keyring service, installed command, login item, update checks, simulator names) comes from `identity()` or checks `edition`, so the two never touch each other.
- `pnpm ted <args>` runs the `ted` CLI from source, against Ted Dev’s home. It starts the daemon if needed.
- `pnpm app` builds the renderer and opens Ted Dev from source. Like `ted`, it reuses a running daemon or starts one.
- Set `TED_HOME` to use a folder other than the default: `~/.ted-dev` for Ted Dev, `~/.ted` for the release. Tests always set it to a temp folder. `TED_IDLE_EXIT_MS`, `TED_CLAUDE_BIN` and `TED_CODEX_BIN` are Ted Dev overrides only; release finds `claude` and `codex` through the login-shell `PATH`. Read runtime `TED_*` inputs through `tedEnv` in `packages/protocol/src/env.ts`, which classifies them and ignores test-only and unknown names in release; use `filterTedEnv` when forwarding an environment to Ted processes. Classify new inputs there, with a reason for each retained release input. See `docs/environment.md` for the policy and inventory.
- Write erasable TypeScript only, and name the `.ts` file in relative imports.
- Every daemon route sits behind the loopback guard in `packages/daemon/src/server.ts`. Each JSON request body has one hand-written parser beside its type in `packages/protocol/src/`, with an explicit request return type and a direct all-fields test; the CLI reuses these parsers. A parser takes `Untyped` and reads it only through `@ted/protocol/parse`, as `packages/protocol/src/failure-parsers.ts` does. The machine `settingParsers` table stays in `routes/machine.ts`; attachment resolution and authorization stay in the daemon. A route, its token flags and its handler live in the area’s file in `packages/daemon/src/routes/` (`tasks.ts`, `factories.ts`, `machine.ts`, `integrations.ts`, `runs.ts`); routes that work before the store opens stay in `server.ts`. Clients call the daemon only through `DaemonClient`. A route is closed to Run tokens unless it sets `runToken: true`, which only the actions listed under “What a Run token may do” in `docs/agents/runs-and-providers.md` may set. Any route other than a `GET` is also closed to the token in `daemon.json` unless it sets `fileToken: true`; only requests signed with the app’s in-memory key may call it. Never mark a route that answers a request, passes a Gate, posts as the human, changes settings or credentials, adds or changes a Factory, or starts a Run outside a Task. Never write the app’s key to disk, send it in a request, or hand it to the daemon other than on its stdin.
- Text the daemon logs or puts in Copy report goes through `redactSecrets` in `packages/daemon/src/redact.ts`, which removes URL passwords and token-shaped strings.

### Area rules

Each area’s rules are in `docs/agents/`. Before changing code in an area, read its file in full; a change that crosses areas reads each one. When a rule changes, edit the area file.

- `docs/agents/tests.md`: writing or changing any test, fixture or stub.
- `docs/agents/store-and-events.md`: the store, events, the event log and opening the data (`packages/daemon/src/store/`, `data.ts`).
- `docs/agents/renderer.md`: the app’s renderer and user-facing text (`packages/app/src/renderer/`).
- `docs/agents/tasks.md`: Tasks, Stages, requests, the queue, the Workflow, worktrees and the Task Lead (`packages/daemon/src/tasks/`, `workflow/`).
- `docs/agents/validate-and-checks.md`: Checks, Validate, reviewers, send-backs, base conflicts and Failure cases.
- `docs/agents/merge-and-github.md`: GitHub requests, pushes, pull requests, the Merge Stage, Cleanup and CI.
- `docs/agents/runs-and-providers.md`: Runs, their hosts, output and messages, and the Provider CLIs (`packages/daemon/src/runs/`, `agents/`, `health/`).
- `docs/agents/chats-and-agents.md`: Coordinator chats, planning chats, Agent files and their powers.
- `docs/agents/automations-and-apps.md`: Automations, Scheduled Checks, Apps, browsers, simulators and emulators.
- `docs/agents/trackers-and-intake.md`: Linear, Asana and GitHub issues: keys, sync, imports and intake.
- `docs/agents/factories-and-settings.md`: adding, changing or removing a Factory, machine settings, Factory settings, the Library, permission mode and drift.
- `docs/agents/platform.md`: the sandbox, caches, child processes and their environment, disk and retention, banners, diagnostics and remote execution.
- `docs/agents/app-shell.md`: the Electron main process, the daemon supervisor, updates, quit, notifications, packaging and icons.

These hold in every area; the area files have the detail:

- Only `packages/daemon/src/tasks/` starts Tasks or changes their Stage. Ted pushes branches and merges pull requests; agents do neither (`tasks.md`, `merge-and-github.md`).
- A shipped event is never edited; a change is a new versioned event (`store-and-events.md`).
- Anything that lets a Run make Ted run repo code goes through the OS sandbox. When the sandbox is missing, refuse; never run unsandboxed (`platform.md`).
- Code that deletes files under `TED_HOME` checks the name and real path first and never follows links (`platform.md`).
- Every GitHub request goes through the `Gh` runner, and nothing reads the `gh` token (`merge-and-github.md`).
- The Linear key and other credentials never go into `process.env`, a Run’s environment, a log line or the store (`trackers-and-intake.md`).
- Tests use the stubs and never reach the network, the real keyring, a tracker, a real simulator or the machine’s own Provider CLIs (`tests.md`).

## Anti-slop rules

`pnpm lint` runs the [anti-slop](https://github.com/dmmulroy/anti-slop) rules through Oxlint (`oxlint.config.ts`, plugin in `tools/oxlint/anti-slop/`, Ted’s own MIT-licensed copy of upstream, which Ted may edit and doesn’t track). They reject patterns that hide what a value is: `typeof` checks instead of parsing input once at its boundary, unexplained casts, `unknown` in parameters, returns and type aliases, loose `Record<string, …>` types, and module mocking.

- Code a Task adds or rewrites must pass. Old code keeps the violations recorded per file and rule in `oxlint-suppressions.json`, and a file can’t gain more. A Task doesn’t have to clean the rest of a file it touches, but when its change removes violations, `pnpm lint` fails until it runs `pnpm exec oxlint --prune-suppressions` and commits the lower counts. Don’t follow Oxlint’s message to run `oxlint --suppress-all`: with no file named, it records every new violation in the repo.
- Remove a cast where you can. A cast that stays in source code gets a one-line `// SAFETY: <reason>` comment just before it, stating what makes it true; this is an exception to the no-comments rule. Test files and fixtures don’t need one.
- No `vi.mock`, `vi.doMock` or Jest equivalents: pass a real seam.
- No `oxlint-disable` or `eslint-disable` comments; `pnpm lint` fails on them. A violation is fixed, or its file pattern is exempted in `oxlint.config.ts` with its reason listed below.
- Untyped data (a request body, a file, Provider CLI output, YAML, an Asana, Linear or GitHub response, JSON stored in the database, a message in the app) is read only through `@ted/protocol/parse` (`packages/protocol/src/parse.ts`), the one file exempt from `no-runtime-typeof`, `no-unknown-parameters`, `no-unknown-returns`, `no-unknown-type-aliases` and `no-unsafe-dictionary-type`. Use `Json`, `JsonObject` and `JsonArray` in place of `Record<string, unknown>`; the checks (`isString`, `isObject`, `isOneOf`, `parseJson` and the like) where a bad value is skipped or collected; and `reader(fail)` where it is refused with an error naming the field. `Untyped` is only the parameter of a function that reads its input this way. `packages/protocol/src/failure-parsers.ts` is the pattern.
- Exemptions in `oxlint.config.ts` and their reasons:
  - Off everywhere: `require-readable-spacing`, because Biome alone decides layout; `no-shape-in-symbol-names`, because it misfires on real shapes such as a Factory icon’s. The `anti-slop-effect` rules aren’t registered: Ted uses Effect only where LiveStore needs it.
  - Off in tests (`**/test/**`, `*.test.ts(x)`): `require-safety-comment-for-type-assertion`, because a cast in a test builds a fixture and claims nothing about production input.
  - Off in `packages/protocol/src/parse.ts`: `no-runtime-typeof`, `no-unknown-parameters` and `no-unknown-returns`, because looking at a value of unknown type is its whole job; `no-unsafe-dictionary-type`, because `JsonObject` is the index type that replaces the loose ones; `no-unknown-type-aliases`, because `Untyped` is an alias for `unknown`.
  - Not linted: JavaScript files and `tools/oxlint/anti-slop/` itself.

## Issue tracker: Linear

- Workspace `kriyadesign`, team **Kriya Design** (`KRI`), project **Ted**: https://linear.app/kriyadesign/project/ted-4c57b190ffe4/overview
- Create every issue in that team and project. Check for an existing issue before creating one.
- Comments and discussion go on the issue as Linear comments.

### Wayfinding operations

Used by `/wayfinder`.

- **Map**: an issue in the Ted project labelled `wayfinder:map`.
- **Ticket**: a sub-issue of the map (`parentId` = the map), labelled with exactly one of `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, `wayfinder:task`. Map and tickets carry no other labels.
- **Blocking**: Linear’s native “blocked by” relation.
- **Frontier**: open sub-issues of the map with no assignee whose blockers are all completed or canceled; lowest identifier first.
- **Claim**: assign the ticket to the dev driving the map before any work.
- **Resolve**: post the answer as a comment, move the ticket to Done, then add a line (linked title + one-line gist) to the map’s Decisions so far.
- **Out of scope**: move the ticket to Canceled and add a line to the map’s Out of scope section.

## Code review before merge

Every code change gets a review before it merges to `main`, usually from Codex (`/codex-review`). Fix or answer each confirmed finding before merging.

A change also gets a security review before merging if it touches any of these: starting agents or running shell commands, messages between processes, credentials or tokens, network requests, or reading and writing files outside the repo being worked on. Use an available security review skill or tool, or review manually when none is available.

## Designs: Figma

- Light-mode images alone are sufficient when sharing results for review or at Design.
- File: https://www.figma.com/design/SLTyztzQXHFdz4sk3TcePk/Ted?node-id=0-1 (file key `SLTyztzQXHFdz4sk3TcePk`)
- Put designs and prototypes on that page or on sibling pages in the same file. Link the frame from the Linear issue it answers.

## Domain docs

- `GLOSSARY.md` at the repo root.
- A decision that must last goes in the matching `docs/agents/` area file, with its reason in one or two sentences.
- An ADR may still be written in `docs/adr/` while working out a decision, but ADRs are deleted from time to time. Code comments and `docs/agents/` files never cite an ADR by number; they state the fact itself.
