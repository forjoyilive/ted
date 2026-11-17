# Every child process starts from the one environment the daemon read at start

`packages/daemon/src/command-env.ts` owns how Ted builds a child process’s environment. `createEnvironment` reads the login shell’s environment once at start (ADR 0033; it moved here from `health/environment.ts`) and again on **Check again** or while a Fix is being watched. The daemon makes one and passes it everywhere:

- Runs and agent checks use it as before.
- Worktree setup and teardown, and setup for a scratch worktree in Factory settings, start from it and then go through `worktreeCommandEnv`, which drops `TED_` names, `ELECTRON_RUN_AS_NODE` and agent credentials (ADR 0044). They still run with `/bin/sh -c` (ADR 0025).
- GitHub and Git health and `gh` use it through `gitEnv` and `ghEnv`, which add `GIT_TERMINAL_PROMPT=0` and turn off `gh` prompts and update notices.
- A Fix opens the user’s terminal with it, whether the Fix came from agent health or from GitHub and Git health.

Before this, setup and teardown started from the daemon’s own `process.env`. When the app starts the daemon from Finder, that has a short `PATH`, so a setup such as `pnpm install` failed where the Task Lead and the Checks (which run `$SHELL -lc`) found `pnpm`. GitHub and Git health kept a second login-environment cache that reloaded on its own schedule, so the Fix terminal’s environment depended on which screen opened it.

## Considered Options

- **Run setup and teardown with `$SHELL -lc`, like Checks.** Rejected for now: it reads the user’s shell startup files on every command and changes which shell parses `worktree.setup`, which ADR 0025 fixes as `/bin/sh`. Starting from the login environment gives setup the same `PATH` without that.
- **Keep two caches and copy the login `PATH` into setup only.** Rejected: it keeps two places that decide what a child process inherits.

## Consequences

- `git` calls for clones, fetches and worktrees still start from `process.env`, since `git` is at a fixed path; `git push` keeps its own filtered environment.
- `GIT_TERMINAL_PROMPT=0` from the login read now also reaches setup and teardown.
- A reload from GitHub and Git health now also refreshes the environment Runs get, and vice versa.
