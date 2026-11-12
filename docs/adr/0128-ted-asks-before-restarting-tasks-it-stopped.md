# After TED stops working Task Leads as it goes down, it asks before restarting them

When TED quits with “Stop them and quit”, or macOS ends its processes at log out or restart, the Task Lead Runs end as `stopped`. Restart recovery (ADR 0051) skips a stopped Run on purpose, so the Tasks sat until the human opened and resumed each one. On 2026-11-10 that was 129 Tasks for about seven hours. The human wants to be asked, not to have them restarted automatically.

- **The stop is an event.** `v1.TaskStoppedByTed { taskId, runId, cause, at }` is recorded only by the Tasks module, and only for a Task whose Task Lead Run was `working`:
  - `quit`: the `/shutdown` route calls `Tasks.stoppingForQuit` before `runs.stopAll()`.
  - `ended-outside`: the Run host writes `stopped: true` in its exit record when it gets SIGTERM. When `RunManager` reads such an exit for a Run it did not ask to stop, and the Run was working, it calls the `stoppedOutside` observer. At the daemon’s next start it reads such an exit before the Tasks module exists, so `RunManager` keeps those Runs and hands them to the first observer that takes them.
  - The host writes the time in its exit record (`at`), and an `ended-outside` event carries that time, or the Run’s last output time for a host that wrote none, so the event says when the Task Lead stopped and not when the daemon came back.
  - A Task at the Merge Stage is not recorded: Resume doesn’t apply there (`taskCanResume`), and the merge watcher and GitHub activity carry it on, as before.
  - While the stop is unanswered, `leadStopped` in `tasks/lead-lifecycle.ts` doesn’t hold a Task Lead Run for the Task (`store.tedStopPending`), so an agent kind becoming Ready again doesn’t restart it.
  - The human’s own Stop records `v1.TaskStopped` and never this event.
- **The offer.** `store.tedStops()` lists Tasks that can still be resumed (`canResume`) and whose newest entry among this event, its answer, a Stop, a Resume and a Retry is `v1.TaskStoppedByTed` for the Task’s current Task Lead Run. `GET /ted-stops` returns it; `ted-stops-changed` tells the app to read it again.
- **The answer.** `POST /ted-stops/answer` takes `restart` and `leave` Task IDs and is open only to the app’s key. `Tasks.answerTedStops` records `v1.TedStopAnswered { taskId, choice, at }` for each offered Task, and for `restart` calls `store.resumeTask` and the pump, the same path as Resume. The queue order, the working-Run limit and the full-disk hold apply.
- **The app.** `RestartStoppedDialog` shows whenever the offer is not empty: a checkbox per Task, all ticked, **Restart** and **Leave stopped**. Closing the dialog answers `leave` for every Task. When the window is hidden, `notifications.tedStops` sends one notification.
- **Autopilot never answers.** Nothing but the app’s answer restarts these Tasks.

## Considered Options

- **Restart them automatically, or when Autopilot is on.** The human chose to be asked every time.
- **A banner that stays until answered.** The human chose that closing the dialog leaves the Tasks stopped, with no banner.
- **List every Task that can be resumed.** That would include Tasks whose Task Lead was idle, and Tasks interrupted for other reasons. The event says which Tasks were working and why they stopped, and the dashboard needs it anyway.

## Consequences

- Time stopped by TED for a Task is from `v1.TaskStoppedByTed` to the next `v1.TaskResumed`, whether the restart came from the dialog or from the Task.
- A Run that was killed outright leaves no `stopped` exit record. It ends as `lost` and restart recovery resumes it without asking, as before.
- The offer waits until it is answered, across launches. A Task the human resumes, stops or archives leaves it.
- An unanswered Task whose host was ended from outside while TED keeps running (someone kills the host) is offered too, with the same wording.
