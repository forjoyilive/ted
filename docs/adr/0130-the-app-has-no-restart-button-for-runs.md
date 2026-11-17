# The app has no Restart button for Runs

The app had a **Restart** action for a Run in four places: the Task’s actions menu, the Task’s right-click menu, each Run’s row under Runs and the bar above a Run’s chat. It restarted the agent in the same host and resumed the same session (ADR 0027, ADR 0043). It sent the agent no message and wrote no thread line, so the Run looked the same afterwards and the human couldn’t tell whether anything had happened (KRI-375).

**All four are removed.** The human gets a Task Lead going again with **Stop Task** and then the action that starts the Task again. A sub-agent’s Run can only be stopped from the app; its Task Lead starts another when it needs one (ADR 0049).

**The restart itself stays.** Ted still restarts a Run when the Task Lead’s model or effort changes (ADR 0027) and when idle Runs move to a new agent version (ADR 0067), through `RunManager.restart` and `Conversations.restart`. `POST /runs/:id/restart` and `DaemonClient.restartRun` stay too, because the daemon’s tests use the route to make a restart happen; the renderer no longer forwards it, so `restartRun` is gone from `forwardedRequests`.

A Start button for a stopped sub-agent was considered and left out: a stopped sub-agent is a finished Run, and continuing one from the app would need its own rules for the queue and for Validate’s one reviewer (ADR 0030, ADR 0108).
