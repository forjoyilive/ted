# Controlled timers (KRI-256, stage 4)

## Scope and prioritization

`node_modules/.cache/ted-test-failures.json` was absent in TED-45’s worktree,
just as recorded for stage 2 in `daemon-decision-coverage.md`. No historical
failure ranking or before/after performance improvement is claimed. The initial
priority was the inspected merge/GitHub polling and nudge timers, followed by
steering, recovery, Automations and Linear sync. Full-suite load measurements
belong to KRI-256 stage 5; this Task runs affected files only.

## Production behavior

`src/clock.ts` provides a daemon-internal scheduler. Its default delegates to
Node timers and `Date.now()`. `DaemonOptions.clock` injects it into Tasks,
GitHub and Linear polling, Automations and idle exit. Automation-specific
`now` and `checkEveryMs` options remain supported. No route, setting or Run
capability controls the clock.

The existing durations, interval versus completion-relative scheduling, initial
poll behavior, `unref`, abort/wake/close handling and GitHub batching remain.
Elapsed CI/stall/recovery decisions use the injected clock; persisted event
and answer timestamps still use wall time. Tests advance from the actual
recorded Stage entry or answer, rather than treating a clock advance as an
async operation’s completion. Production always uses the system clock.

`test/support/manual-clock.ts` advances scheduled callbacks in deadline order.
It does not flush asynchronous work. Tests additionally await a relevant
Run/Task event, a completed background cycle rearming its timer, or a detached
host’s exit record. `test/support/event-wait.ts` subscribes before the initial
read, serializes reads, rechecks notifications arriving during a read, and
removes subscriptions and timeout guards on completion or failure. HTTP
subscribers use `DaemonClient.subscribe`. The real-time guard stays at 20 seconds
by default; no existing guard was tightened to speed up integration tests.

## Coverage retained and synchronization replacements

No test is deleted. All existing feature main paths remain end-to-end. Paths
below are relative to `packages/daemon/test/`.

| Area | Cases retained | Synchronization |
| --- | --- | --- |
| GitHub polling | Existing `github-watch.test.ts` cases, including fenced CI forwarding, deduplication and trusted reviews | New `github-watch-clock.test.ts` exercises full interval boundaries, host batching, urgent wake, kick, no overlapping requests, close with pending readers, and removal of all refs without a real daemon. Existing integration cases remain. |
| Nudges | `stop-resume.test.ts`: “is nudged once, then Ted asks with its last message and Nudge again”; “isn’t nudged while it waits on the human” | Advance the nudge clock, await the nudged turn and its rearmed timer, then advance to the second idle check. Advance through the negative time window with the human request still open. |
| Stop/resume | Existing stop and last-blocker cases in `stop-resume.test.ts` | The completed stop/unblock response and finished Run are the completion barriers before asserting no automatic restart; the subsequent explicit Resume still proves recovery. |
| Silent Run recovery | `failures.test.ts`: “thirty minutes with no output while Working counts as a failure” | Advance the injected silence clock and await the real recovery event. Queue-capacity assertions check the recorded failure and the other Task holding the only working slot; restart recovery waits for the detached host’s exit record; human-stop assertions wait for the Run to finish. |
| Steering | Existing queued-message, delete, interrupt and Codex boundary cases in `steering.test.ts`; queued Comment case in `thread.test.ts` | Keep the stub blocked on its explicit file gate while asserting no delivery, or await completed interruption/turn state before asserting absence. Then release the gate and verify actual delivery and order. Run state/text and Task state helpers recheck on daemon events. |
| Merge | All cases in `merge.test.ts` and `merge-gate.test.ts` | Initial CI/merge wait states and completed human responses replace sleeps. A held Request changes action waits until its timeout is armed behind the Task lock, then releases the fetch gate. Canceled merge advances and completes another GitHub poll before asserting no merge. CI-stuck timing advances from Merge entry and the Keep waiting answer. Stage and sign-off waits use daemon events. |
| Automations | Existing firing/finish, disk hold, idle hold and Bypass cases | Scheduled checks use explicit timer advancement with the existing Automation `now` seam. Clear the disk hold before advancing the next check. Advance idle time while the Automation holds the daemon, then disable it and advance a full exit delay. Finished Automation work is the barrier before checking Bypass Tasks stay in Backlog. History waits use daemon events. |
| Linear | Existing off/no-key and workspace-isolation cases in `linear-sync.test.ts` | Advance and complete a sync cycle for off/no-key; workspace isolation waits for subsequent actual sync requests instead of sleeping. New `linear-clock.test.ts` checks the first deadline, a slow non-overlapping cycle, completion-relative rearming and close during a cycle. The full Linear lifecycle integration case remains. |

`clock.test.ts` also checks timer ordering and cancellation, abortable waits,
real Node defaults, event-wait cleanup and notifications during an async read,
and nested idle holds with a full delay after the final release.

Polling remains for external file/process records with no daemon event and for
untouched integrations. The suite lock, process cleanup, 3 Electron workers and
6 node workers are unchanged. These timer changes do not replace the separate
full-suite quiet/busy measurements required by stage 5.

## Test Run isolation

The affected Automation question tests exposed inherited parent Run context:
inside Ted, the stub CLI received `TED_TASK=TED-45` and tried to comment on that
Task in its temporary daemon. Shared test setup now clears `TED_RUN_CAPABILITY`,
`TED_RUN_TOKEN`, `TED_RUN`, `TED_TASK` and `TED_PLAN` before any test Run starts.
The real Automation question/answer tests exercise this fix; test Runs receive
only their own context from their daemon. The Task Lead’s workflow commands
continue in the original environment.

## Verification

Typecheck and Biome lint pass. All 134 tests in these 13 affected files pass:
`clock.test.ts`, `github-watch-clock.test.ts`, `stop-resume.test.ts`,
`failures.test.ts`, `steering.test.ts`, `thread.test.ts`, `automations.test.ts`,
`merge.test.ts`, `merge-gate.test.ts`, `github-watch.test.ts`,
`linear-sync.test.ts`, `linear-clock.test.ts` and `idle.test.ts`.

The affected files remove 26 fixed waits. Recovery and Linear files were rerun
after correcting their new completion barriers; the two Automation questions
also passed after isolating the inherited Run context. The first sandboxed
attempt could not use process cleanup (`ps` returned `EPERM`) or filesystem
watchers; integration verification ran outside that sandbox using the existing
suite lock. Some runs waited behind another live suite. No full suite or
GitHub workflow was started, and elapsed times including lock waits are not
used as performance evidence.

## Integration with newer main changes

Merging main at `6b4435cb` retains the new load-monitor cleanup and Automation
draft options alongside the clock seam. The held-Task Merge Gate case exposed
a frozen setup retry: the watcher can reach Merge while Stage entry still holds
the Task, then arm its 100 ms busy retry. `toSignoff` accepts an optional manual
clock and advances an armed 100 ms retry after an unsuccessful Inbox read. The
real sign-off is still the completion barrier; advancement stops before the
case observes the held Task’s frozen 15-second human-response timeout. No test
is removed, no timeout guard is tightened, and production scheduling is unchanged.
