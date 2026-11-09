# A Task Lead change restarts the agent inside the same host, at the Run’s next idle point

Each Task now holds a Task Lead field, `{agent, model, effort}`, filled at creation from the resolved `lead` (spec 4.5) and stored with the new event `v1.TaskLeadSet`. Each Run records the model and effort it was started with (`v3.RunStarted`). The human changes the field with `PUT /tasks/<id>/lead`, `ted task lead`, or the Task details pane.

- **When a change applies.** `tasks/` compares the field with the live Task Lead Run whenever that Run changes (the new `run-updated` live update) and when the daemon starts. Nothing is stored about a pending change: a field that differs from the Run *is* the pending change. It applies only at an idle point: the Run is idle, or it waits because its model is unavailable. A turn in progress is never interrupted.
- **Model or effort change: the same Run, resumed with new flags.** The glossary says a Run stays the same Run when TED restarts the agent underneath it. So the Run manager writes a new `launch.json` (with `--resume <session>` for Claude Code, `thread/resume` for Codex, and the new flags), commits `v1.RunRestarted`, and sends the host `SIGHUP`. The host stops forwarding input, ends the agent with `SIGTERM`, re-reads `launch.json`, starts the agent again, and writes another `start` record to the same `host.log`. The daemon waits for that record before it sends the Run anything. A launch with empty input sends nothing, so the resumed agent waits for its next message.
- **Agent change: a fresh Run.** The old Run is stopped and a new Task Lead Run starts in the same worktree from the Task Lead prompt for the current Stage. Spec 7.3 says “from the brief”; the Task brief doesn’t exist yet (KRI-89), so the prompt holds the preamble, the Stage file, Factory notes and the Task.
- **Effort levels.** Claude Code takes `--effort` with `low` to `max`; `ultra` becomes `max`, and Claude Code itself drops a level the model doesn’t support. Codex gets `effort` and `model` on every `turn/start`; the driver first asks `model/list` and drops an unsupported level to the highest level the model lists below it.
- **Model unavailable.** Each agent module recognises its CLI’s error (`agents/`, ADR 0014): Claude Code’s assistant message with `error: "model_not_found"`, Codex’s `error` notification whose message carries `model_not_found`. The Run manager records `v1.RunProblemFound`; the Run shows `waiting` with `problem: model-unavailable` until it is restarted, even if the agent reports idle. `tasks/` posts a `question` Comment authored by TED (`v1.TedCommentPosted`). **Use the default model** (`POST /tasks/<id>/lead/use-default-model`) restarts this Run without `--model` (Codex keeps a resumed thread’s saved model, so its driver names the `isDefault` model from `model/list` instead) and marks it `usesDefaultModel`, so the field keeps the requested model and no later comparison restarts it again. **Change setting** is an ordinary field change. Either way the restarted agent is told its last message got no answer and to carry on.

Checked on 2026-11-08: Claude Code 2.1.319 with `--model claude-nonexistent-9` answers with that assistant message and stays open; codex-cli 0.160.0 with an unknown model starts the thread, then fails the turn with that `error` notification; `model/list` lists `supportedReasoningEfforts` per model.

## Considered Options

- **Stop the host and start a new one in the same Run directory.** The old host writes `exit`, which the daemon reads as the end of the Run; telling that apart from a real exit needs state that survives a daemon restart.
- **A new Run for every flag change.** Simpler, but the glossary and spec 7.3 keep it the same Run.
- **Change Codex’s model and effort per turn without a restart.** Codex allows it, but Claude Code doesn’t, and one path for both kinds is easier to reason about.

## Consequences

- `host.log` may hold several `start` records. Stopping a Run kills the agent named in the last one. A host from before this change dies on `SIGHUP` instead of restarting; the daemon then marks its Run finished.
- An agent named in a setting that isn’t installed still starts and fails; Paused for that case comes with agent health (KRI-112).
- `reviewer` and `planner` defaults are resolved by `resolveAgentChoices` but nothing uses them yet (KRI-128, Planning Runs).
- The question Comment is plain text. Answer buttons in the thread come with requests in the Inbox (KRI-89, KRI-91); until then the Task details pane shows **Use the default model**.
