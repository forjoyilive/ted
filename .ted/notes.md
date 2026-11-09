# TED

TED (“Totally Excellent Development”) is a desktop app for running software factories: agents carry development tasks through a configurable workflow, and the human steers through an inbox and comments. `AGENTS.md` at the repo root is the full guide to the code and its rules; read it before changing anything. Use the terms in `GLOSSARY.md`.

## Repos

One repo, `forjoyilive/ted`: a pnpm workspace on Node 24.

- `packages/protocol`: paths, `daemon.json`, API types and `DaemonClient`.
- `packages/daemon`: the daemon, its store, Runs, Tasks, Apps and GitHub work.
- `packages/cli`: the `ted` command.
- `packages/app`: the Electron app and its React renderer.

## Running it locally

- `pnpm install`, then `pnpm typecheck`, `pnpm lint` and `pnpm test`.
- `pnpm app` builds the renderer and opens TED Dev from source; `pnpm ted <args>` runs the CLI from source.
- For isolated CLI trials, use `env -u TED_RUN_TOKEN -u TED_RUN -u TED_TASK -u TED_PLAN TED_HOME="$PWD/node_modules/.cache/ted-home" pnpm ted <args>`. Keep TED’s Task-control commands in the normal Run environment.
- In a Task, always set `TED_HOME` to the Task’s own folder, `node_modules/.cache/ted-home` in the worktree, which the TED Dev App already uses. Never use `~/.ted` (the installed TED that runs this Factory) or `~/.ted-dev`.

## Where things live

- Issues: Linear, team Kriya Design (`KRI`), project TED.
- Designs: the Figma file named in `AGENTS.md`.
- Spec and decisions: `docs/spec/` and `docs/adr/`.

## House style

- Plain, direct language in code, docs, commit messages and UI text.
- Curly quotes and apostrophes in prose and user-facing text; straight ones in code.
- No code comments unless they record something the code can’t say: an upstream bug, a platform quirk, a required order.
