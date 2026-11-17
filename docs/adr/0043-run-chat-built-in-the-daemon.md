# The Run chat is built in the daemon from the stored Conversation, and its tabs are stored per Task

A Run’s chat (spec 7.3, 10.6) is a list of items the daemon builds on request from the Conversation lines it already stores: `GET /runs/:id/chat` returns a Run summary (name, agent, model, effort, credential, tokens, state) and the items. Each agent module turns its CLI’s lines into neutral entries with a `chat` function next to `stateFrom` (ADR 0014): user messages, agent messages (Codex’s `item/agentMessage/delta` lines make a streaming message), and tool calls with their output and, for edits, diff lines. `runs/conversations.ts` then splits the Run’s first message into Ted’s instructions (the preamble) and the prompt, marks the human’s own chat messages, shows anything else Ted sent the Run (Comments, Stage messages) as “From Ted” rows, and marks the last message “writing…” while the Run works. The Codex parser and the line diff are ported from agent-orchestrator’s `chatdriver` (Apache-2.0); the ported files say so at the top.

- **Times come from the host.** The host now adds `at` to each `out` record in `host.log` (a new field, ADR 0013), and the daemon stores it with `v2.RunOutputRead`. Output from an older host gets the time the daemon read it.
- **Live updates.** Every commit of new Conversation lines emits the new `run-output` live update; an open chat reloads on it.
- **Messages typed into a chat** go through `POST /runs/:id/messages`, which writes them to the Run with `RunManager.send` and records `v1.RunMessageSent`. They are not Comments. When the Run is its Task’s current Task Lead, the event also writes a thread line, “You steered the Task Lead in its Conversation”, with a **View message** link; the line holds the Run’s ID, never the text.
- **Restart** (`POST /runs/:id/restart`) is refused while the Run works. On an idle or waiting Run it restarts the agent in the same host with the Run’s own flags, resuming the same session (ADR 0027), so it stays the same Run. The app no longer has a button for it (ADR 0130-the-app-has-no-restart-button-for-runs).
- **Stop Run** (`POST /runs/:id/stop`) is refused for a Task’s current Task Lead, which is stopped with its Task.
- **Tabs** are stored per Task with `v1.ConversationTabOpened` and `v1.ConversationTabClosed`, and every Task carries its `tabs`, so they survive restarts and the app keeps no state of its own (ADR 0011). Which tab is showing is not stored.
- All these routes are closed to Run tokens (ADR 0015).

## Considered Options

- **Port agent-orchestrator’s chat host and React chat components whole.** Its host is a Go ACP driver that talks to the agent itself, and its components rely on its own design system, motion library and data types. Ted already drives agents from its own host, so Ted ports the parsing logic and writes the components in its own CSS Modules.
- **Build chat items in the app.** The app would need to know each CLI’s output format, which belongs in `agents/` (ADR 0014), and the app holds no business logic (ADR 0011).
- **Store chat items as events while reading the log.** It duplicates what the Conversation lines already say, and a change to how items look would need new events.

## Consequences

- A long Conversation is parsed again on each reload. Tool output is cut to 8,000 characters and diffs to 400 lines per file to keep replies small.
- Claude Code runs without `--include-partial-messages`, so its messages arrive whole and “writing…” marks the last message of a working turn rather than streaming it word by word.
- Interrupt, queued messages and the ■ button come with Steering (KRI-108); **Stop Task** in the Run bar is wired by KRI-101. Sub-agent names and the full Runs section come with KRI-109; until then every Task Run is named “Task Lead”.
- Agent messages show as plain text, not Markdown.
