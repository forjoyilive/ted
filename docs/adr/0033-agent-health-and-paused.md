# Agent health is checked in one daemon module, and Paused is stored as facts

Agent health reuses what ADR 0029 built for GitHub and Git: `cli-env.ts` reads the login shell’s environment and finds binaries on its `PATH`, and `terminal.ts` opens a fix command in the user’s own terminal. `packages/daemon/src/health/environment.ts` keeps the environment the daemon read at start (and again on **Check again**) so Runs and agent checks share it, and `health/cli.ts` runs a CLI with a timeout and reads its version.

`agent-health.ts` checks each agent kind at start, every 10 minutes, on **Check again** (which also reads the login shell again), when a Run reports an auth error, and before each Run (a Ready result less than 30 seconds old counts). What each CLI prints stays in `agents/` (ADR 0014): each `Agent` has a `health` spec with its minimum version (KRI-81), the version and auth commands and how to read them, and its sign-in, update and install commands, plus `authErrorFrom(line)`. Those commands are fixed strings in the agent modules; `POST /agents/:kind/fix` takes only the agent kind, the same way `POST /integrations/fix` takes only a fix name. The check runs the binary with exactly the environment a Run gets (`RunManager.environment()`, minus the variables that agent removes), so a check and a Run never disagree about which binary or login they see.

A kind that isn’t Ready is paused in the store (`v1.AgentPaused`, `v1.AgentResumed`). A Task Lead that can’t start because its kind is paused is held (`v1.TaskRunHeld`, with the session to resume when an open Run stopped on an auth error; `v1.TaskRunReleased` when it starts). `TedStore` turns both into `TaskFacts.paused` and `TaskRun.paused`, so the status engine (ADR 0023) shows “Paused · Claude Code is signed out” with no new code in the app. When the kind is Ready again, the tasks module starts every held Task Lead (resuming the session when it has one) and sends a carry-on message to Runs that hit an auth error but stayed open.

The full health (version, path, account, fix command, paused Run count) lives in daemon memory and reaches clients through `GET /agents/health` and the `agent-health-changed` event. The banner (`agent-unavailable`, one per kind) shows for signed out, too old and wrong credential, and for not installed only when a Run is waiting on that kind. Its **Fix**, and `POST /agents/:kind/fix`, open the fix command in the user’s terminal and then check again every 5 seconds for 10 minutes, reading the login shell again while the agent is still not installed. The banner names the Agents section (`BannerAction.section`), so Settings shows its dot. TED never runs an update or a sign-in itself.

## Considered Options

- **Pause state only in memory.** Task status is computed inside `TedStore` from stored rows; an in-memory flag would need a second path for live updates and would forget held Tasks across a restart.
- **Health checks inside each agent module.** Every kind would repeat the environment, timeout and terminal code.
- **Open the command in TED’s terminal.** A pasted login code would pass through TED’s process (spec 2.5).

## Consequences

- A new agent kind adds a `health` spec and `authErrorFrom`; nothing else changes.
- Starting a Run goes through `Tasks`, which asks `health.ready` first; `/dev/runs` does not.
- The credential check (KRI-113) sets the `wrong-credential` state; the pause, banner and resume already handle it.
- The queue (ADR 0030) skips Queued Tasks whose Task Lead’s kind is paused, so the other kind moves ahead; those Tasks show “Paused · <reason>” with “Queued · 2nd” as the activity line. Runs of a paused kind don’t take a working slot. “N Runs paused” counts held Task Leads and open Runs, not Queued Tasks.
- No no-output clock exists yet, so “the clock stops” has nothing to act on until it lands.
