# Agent health is checked in one daemon module, and Paused is stored as facts

`packages/daemon/src/health/` holds the pieces any CLI health check needs: `environment.ts` reads the login shell’s environment (`$SHELL -l -i -c`, 10-second timeout, falling back to the usual bin folders), `cli.ts` finds a binary on that `PATH`, runs it with a timeout and compares versions, and `terminal.ts` opens a command in the user’s own terminal (a `.command` file with `open -a Terminal` on macOS; `$TERMINAL`, `x-terminal-emulator`, `gnome-terminal`, `konsole`, `xterm` on Linux). KRI-114’s `gh` and `git` checks reuse them.

`agent-health.ts` checks each agent kind at start, every 10 minutes, on **Check again** (which also reads the login shell again), when a Run reports an auth error, and before each Run (a Ready result less than 30 seconds old counts). What each CLI prints stays in `agents/` (ADR 0014): each `Agent` has a `health` spec with its minimum version (KRI-81), the version and auth commands and how to read them, and its sign-in, update and install commands, plus `authErrorFrom(line)`. The check runs the binary with exactly the environment a Run gets (`RunManager.environment()`, minus the variables that agent removes), so a check and a Run never disagree about which binary or login they see.

A kind that isn’t Ready is paused in the store (`v1.AgentPaused`, `v1.AgentResumed`). A Task Lead that can’t start because its kind is paused is held (`v1.TaskRunHeld`, with the session to resume when an open Run stopped on an auth error; `v1.TaskRunReleased` when it starts). `TedStore` turns both into `TaskFacts.paused` and `TaskRun.paused`, so the status engine (ADR 0023) shows “Paused · Claude Code is signed out” with no new code in the app. When the kind is Ready again, the tasks module starts every held Task Lead (resuming the session when it has one) and sends a carry-on message to Runs that hit an auth error but stayed open.

The full health (version, path, account, fix command, paused Run count) lives in daemon memory and reaches clients through `GET /agents/health` and the `agent-health-changed` event. The banner (`agent-unavailable`, one per kind) shows for signed out, too old and wrong credential, and for not installed only when a Run is waiting on that kind. Its **Fix**, and `POST /agents/:kind/fix`, open the fix command in the user’s terminal and then check again every 5 seconds for 10 minutes. TED never runs an update or a sign-in itself.

## Considered Options

- **Pause state only in memory.** Task status is computed inside `TedStore` from stored rows; an in-memory flag would need a second path for live updates and would forget held Tasks across a restart.
- **Health checks inside each agent module.** Every kind would repeat the environment, timeout and terminal code, and `gh` would need its own copy.
- **Open the command in TED’s terminal.** A pasted login code would pass through TED’s process (spec 2.5).

## Consequences

- A new agent kind adds a `health` spec and `authErrorFrom`; nothing else changes.
- Starting a Run goes through `Tasks`, which asks `health.ready` first; `/dev/runs` does not.
- The credential check (KRI-113) sets the `wrong-credential` state; the pause, banner and resume already handle it.
- No queue, working-Run limit or no-output clock exists yet, so “Paused Runs don’t count toward the limit” and “the clock stops” have nothing to act on until those land.
