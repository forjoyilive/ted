# Automations fire from the daemon and queue like any Run

Status: accepted (KRI-154)

## Context

Spec 12 (and 2.3, 3.1, 3.5, 7.4): an Automation is a schedule in a Factory that starts a Run each time it fires, outside any Task, usually to create Tasks. Its firings follow overlap, make-up and disk-hold rules, its Runs wait in the one queue (ADR 0030), and its Tasks must never duplicate one TED already tracks.

## Decision

**Store.** Automations are events and tables in the store, per machine, never committed: `v1.AutomationCreated`, `Edited`, `Switched`, `Deleted`, and one row per firing (`v1.AutomationFired`, with its trigger, the slot it stands for and whether it was skipped). A firing’s life is `v1.AutomationRunBegan`, `RunResumeQueued`, `RunRevived` and `RunEnded` (finished, failed or stopped, with the error and the first line of the final message). `v1.AutomationTaskCreated` links a Task to the firing that created it, committed with the Task; `v1.AutomationCommentPosted` and `Answered` hold an Automation Run’s notes and questions. `store/automations.ts` is the only code that reads and writes them (`TedStore.automations`). An Automation Run’s ID is its firing’s ID; Runs gained no field.

**Schedules.** `packages/protocol/src/schedule.ts` is pure and shared with the app: every N minutes or hours (counted from midnight in the zone), daily, weekdays, weekly on days, or custom, which is a 5-field cron (Vixie rules: day of month and day of week both set means either) or an RRULE (FREQ, INTERVAL, BYMINUTE, BYHOUR, BYDAY with ordinals for months, BYMONTHDAY, BYMONTH, UNTIL, optional DTSTART, from which INTERVAL counts, read as wall-clock time in the Automation’s zone; COUNT is refused). Wall-clock times are turned into instants with `Intl` in the Automation’s stored zone, so summer time moves the instant, not the clock time. The shortest interval is checked on the next 200 firings. `scheduleFromExpression` turns simple crons into the named kinds, so `ted automation create --schedule "0 9 * * 1-5"` reads “Weekdays at 09:00 · Europe/London”.

**Firing.** Each Automation keeps `handledUntil`, the last slot it acted on (creation, a schedule change and turning on set it to now). A timer, at most `checkEveryMs` (60 s) away, finds the slots between `handledUntil` and now. One slot no more than two minutes late is “Scheduled”; anything else (TED down, the machine asleep, a held disk) is one “Made up” firing for the latest slot. While the previous Run is Queued, Working or Paused, the firing is recorded as skipped and not made up; while it is Waiting on you (a `waiting` Run, or an open question from it), a new Run starts. While `store.newWorkHold()` is set nothing is recorded, so the slots stay due and fire once as Made up when the hold lifts. Run now and Retry are firings too, refused while new work is held or a Run of that Automation is still queued or working.

**Queue.** The Tasks module’s pump takes extra queue sources (`Tasks.addQueueSource`, `QueueSource` in `tasks/queue.ts`); the Automations module adds `automation` entries, which `queueOrder` already places after Planning Runs and before Tasks, entries for a paused agent kind are not runnable, and working Automation Runs (not Paused, not waiting) are slot holders in both counts. `RunSlots` holders and queue entries gained an `automation` variant.

**Runs.** A Run starts in `TED_HOME/automations/<id>/` (not a clone or worktree), with the stored agent, model and effort, `auto` permissions, `TED_AUTOMATION` and `TED_FACTORY`, and a prompt that names the `ted` commands it may use, lists the Tasks this Automation created with their state and source, then the stored prompt. When it goes idle with no open question and its agent kind isn’t paused, TED records it finished and stops it. A Run that ends without TED stopping it is resumed once (`RunManager.revive`); a second end, or a Run with no session, is Failed. Three failures in a row (Stopped by you neither counts nor resets) raise the warning banner `automation-failing` for that Automation in its Factory; a finished Run clears it. Retry works only on the newest failed Run, once.

**Run tokens.** `GET /automations…` are open to Run tokens; every change (`POST /automations`, `PATCH /automations/:id`, `/enable`, `/disable`, `/run`, `DELETE /automations/:id` and `POST /automation-runs/:id/retry`) is open to Run tokens only so that its handler can return 403 “Ask the human to change Automations”, which tells the agent what to do; each handler refuses a Run before it reads anything else. Creating, editing, enabling, Run now, Retry and deleting are app-only: they schedule or start agent Runs outside a Task, which ADR 0054 keeps from the file token every agent can read. The file token may only read Automations, preview a schedule and turn one off, so `ted automation create`, `edit`, `enable`, `run` and `delete` in a terminal are refused with a pointer to the app. This departs from spec 12.3, which lists them as commands for the human. `POST /tasks` is open to Run tokens only for a Run that is an open Automation Run, only in its own Factory. `ted comment` inside an Automation Run posts to `POST /automation-runs/comments`; the app answers through `POST /automation-requests/:id/answer`, which sends the answer into the Run’s live input.

**Duplicates.** `sourceKey` in `tasks/sources.ts` matches Linear URLs by workspace and identifier and other URLs by host and path (no query, no trailing slash). For every caller but the app, a source tracked in the same Factory by an open Task is refused with “Already tracked as NB-51 · Stage”, by a Task archived without merging is refused, and by a Done Task is refused with its merge date and commit. `--follow-up <id>` creates a Follow-up of a Done Task (the `followUpOf` link KRI-134 added, which starts the Task without Backlog) sharing its source, refused while another Task with that source is open.

**Sentry short IDs.** `ted task create --sentry-id <SHORT-ID>` (with `--source`) stores the Sentry issue’s short ID with the Task’s source as `v1.TaskSourceSentrySet`, committed with the Task, and a Follow-up shares it. TED, not the agent, writes the pull request body, so it adds `Fixes <SHORT-ID>` there itself.

## Considered Options

- **Cron library from npm.** None handles cron and RRULE in a named zone without large dependencies; the shared module is small and the app needs it for the form.
- **One firing per missed slot.** The spec makes up a gap once, however long.
- **Keeping Automation Runs out of the slot count**, like `ted dev run`. The spec counts them; they have a Factory and report their end, so the pump can’t get stuck on them.
- **Refusing duplicate sources in the New Task dialog too.** Left as before: the human may mean to track it twice; the rule is for `ted task create`.

- **Letting the file token change Automations**, so the spec’s `ted automation create` works in a terminal. Any agent could then read `daemon.json` and schedule its own Runs with any prompt, outside any Task.

## Consequences

- The Automations page (KRI-155) reads `GET /automations`, `GET /automations/:id` (history and requests), `GET /automations/templates` and `POST /automations/schedule-preview`, and listens for `automation-updated` and `automation-deleted`.
- Automation Runs always run in `auto` permissions, even when the Factory sets `bypass`. They run unattended on a schedule and read untrusted content (Sentry, Linear and GitHub issues), so a prompt injection there must not get Claude Code’s `bypassPermissions` or Codex’s `danger-full-access`. The Factory setting still covers Task Leads, sub-agents, reviewers and Planning Runs.
- Automation Runs have no Task, so their permission prompts are denied like any Run without a Task; their questions appear in `GET /automations/requests` and count as waiting in `activity()`, but the Inbox UI doesn’t show them yet.
- The commit in “merged 3 Nov, commit abc1234” is the last commit TED pushed for the merged pull request, not GitHub’s merge commit; after a squash merge a release won’t contain it.
- No Factory removal exists yet. Automations of a missing Factory are ignored everywhere; removal must delete them.
- The 30-minute no-output clock applies only to Task Leads; an Automation Run that hangs stays Working until stopped.
