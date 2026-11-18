# An idle Task Lead is nudged three times before Ted asks, and the question offers a restart

Status: accepted (TED-572). Amends ADR 0046-stop-resume-and-the-idle-nudge.

Under ADR 0046 Ted nudged an idle Task Lead once and then asked the user “The Task Lead stopped without saying why”, with the single choice **Nudge again**. The question kept Ted from nudging forever, but its only choice was the nudge Ted could have sent by itself, and its text was whatever the agent said last.

**Three nudges with growing gaps.** `nudgeIfIdle` in `packages/daemon/src/tasks/tasks.ts` counts the `v1.TaskLeadNudged` events for the Task Lead’s Run since Ted last heard from the user: the latest Stage entry, human Comment or answer (`nudgesSinceHeard`, `TedStore.nudgesSince`). A nudge at the same moment as that point counts, so the nudge that follows a Nudge again answer is counted. While the count is under 3, Ted nudges. `watchIdle` arms the idle timer for `nudgeAfterMs` times 1, 5 or 15 (`nudgeSteps`) for the first, second and third nudge, so 1, 5 and 15 minutes by default, and `nudgeAfterMs` once all 3 are sent. The count comes from the log, so it survives a daemon restart and needs no new event. The other rules of ADR 0046 (no nudge at Merge once the Task Lead has advanced, none while Ted works for the Task or a request is open) are unchanged. `v1.TaskLeadNudged` is now recorded before the message is sent, because a short turn can end before `runs.send` returns, and the idle timer must see the new count.

**The nudge asks why.** `nudgeMessage` in `tasks/thread.ts` asks the agent, if it can’t go on, to end its reply with one line starting `Stuck because:`. The thread draws past `v1.TaskLeadNudged` lines from this constant, so earlier nudges show the new wording.

**The question.** After the third nudge, the next idle posts a `question` with purpose `idle-run`, titled “The Task Lead is stuck”. Its text is the rest of the last `Stuck because:` line in the agent’s latest message, then “It stopped again after 3 nudges without asking you anything.” Without that line, it quotes the latest message as before, or says the agent wrote no message. The choices are **Nudge again** and **Restart from the brief**. Replying in the thread wakes the Task Lead and closes the question, as before.

**Restart from the brief.** `request-answers.ts` calls `restartFromBrief` in `tasks/lead-lifecycle.ts`, which first refuses with 409, leaving the question open, when there is no live Task Lead, the Task Lead is working again, a restart is already being applied, the agent may not start, new work is on hold or the Provider isn’t ready. Only then does it record the answer. Like a Provider change, it stops the stuck Run and launches a fresh Task Lead Run with a pick-up note from `fromTheBrief` (“Picking up after getting stuck”), which carries the question’s text and the messages the old Run hadn’t read, but not the old conversation. If the launch fails after the answer was recorded, Ted posts the idle question again so the user keeps both choices. A Coordinator may answer with either choice, as it already could with Nudge again (ADR 0094).

## Considered Options

- **Remove the question and keep nudging up to a limit.** Rejected by the user: an agent that keeps stopping would use tokens without the user knowing.
- **Reuse `restartNow`.** Rejected: it restarts the same conversation to apply changed Task Lead settings and refuses when nothing changed.
- **Restart through Stop and Resume with a new fresh-Run event.** Rejected: the Task would show Stopped for a moment, wait at the end of the queue, and need a new versioned event, while the Provider change path already replaces a Task Lead in place.
- **A Stop the Task choice.** Left out by the user: the Task actions menu already has Stop.

## Consequences

- A third nudge comes about 21 minutes after the Task Lead first goes idle. By then an idle Task Lead is usually asleep (ADR 0172), and the nudge wakes it, which takes a few seconds.
- An open idle question posted before this change still answers with Nudge again.
- If the Provider stops being ready between the readiness check and the launch, the launch holds the Run as any start does, and the Task Lead that starts later gets the ordinary pick-up note, not “Picking up after getting stuck”. A Provider change has the same gap.
