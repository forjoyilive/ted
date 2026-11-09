# Steering holds queued messages in the daemon and delivers them at the agent’s next step

A message the human sends to a working Run (spec 10.6) is not written to the agent at once. Both CLIs take a message the moment it is written and can’t drop it (KRI-80, `docs/research/kri-80/`), so TED keeps it in its own store until the agent’s next tool-call boundary. That is what lets the human delete it. `runs/steering.ts` owns this; `runs/conversations.ts` calls it, and the routes are in `routes/runs.ts`.

- **Events.** `v1.RunMessageQueued` records a message sent while the Run works. `v1.RunMessageDelivered` marks it written to the agent; it carries `lead`, so the thread line “You steered the Task Lead in its Conversation” appears when the Task Lead gets the message, not when it is queued. `v1.RunMessageDeleted` removes a queued message. `v1.RunTurnInterrupted` records ⌘↵, **Send now** and ■ (with `hold: true` for ■), and draws “Interrupted by you” in the chat. A message sent to an idle or waiting Run is still written at once and recorded with `v1.RunMessageSent`.
- **One writer per Run.** Every delivery for a Run runs through one promise chain in `steering.ts`, and a message is marked delivered in the store before its line is written. **Delete** succeeds only while the store still says queued, so a message is either deleted or delivered, never both.
- **Codex.** The agent module reports a tool item’s `item/completed` as a boundary (`boundaryFrom`); the Run manager tells the steering module, which writes each message as `{"text", "steer": true}`. The host driver sends `turn/steer` with `expectedTurnId`, or `turn/start` when no turn is active or the steer is refused. `{"interrupt": true}` makes the driver send `turn/interrupt`; an interrupt that arrives before the turn has an ID is sent once it has one.
- **Claude Code.** The `PostToolUse` hook in the per-Run settings runs `[ -e "$TED_HOME/runs/$TED_RUN/queued" ] && ted run boundary`. The daemon keeps the `queued` file in the Run’s directory only while a message can be delivered, so a tool call costs a file check and nothing more. `ted run boundary` calls `POST /runs/:id/boundary`, open to that Run’s own token only; the daemon writes the messages to stdin as user messages and answers once Claude Code replays them (`--replay-user-messages`) or after 10 s, so the hook holds the CLI at that boundary until the message is in. Messages never go in as `additionalContext`. Interrupt is the stream-json `interrupt` control request, and a `result` line now marks the Run idle, since no `Stop` hook fires after an interrupt.
- **No tool call before the turn ends.** When a Run goes idle with messages still queued, the steering module delivers them, which starts the next turn.
- **⌘↵ and Send now** record the interrupt, send it, wait up to 10 s for the Run to stop working, then deliver that message first and any other queued messages after it. While this waits, the message doesn’t count for the `PostToolUse` gate.
- **■** stops the turn and sends nothing. Messages queued before it stay queued, with Send now and Delete, until the human sends them or sends a new message, which delivers them first in order. Delivering them when the Run goes idle would start the turn the human just stopped.

## Considered Options

- **Write queued messages to the CLI at once.** Rejected: neither CLI can drop one message, so Delete would be impossible (KRI-80).
- **Deliver through the hook’s `additionalContext`.** Rejected: Claude Code shows it as a system note, and the model may ignore it as not from the human (KRI-80).
- **Call the daemon from every `PostToolUse` hook.** Rejected: it starts a Node process on every tool call. The `queued` file keeps the common case to a shell test.
- **Send now with Claude Code’s `priority: "now"` message.** It ends the turn but keeps a running shell command going; one interrupt path for ⌘↵, Send now and ■ is simpler.

## Consequences

- `ted run boundary` exists for the hook; it isn’t in `ted help`. A Run that calls it itself only gets the human’s queued messages a little early.
- A Run that finishes with messages still queued shows them as “Not sent”.
- A tool call that an interrupt cut off shows “stopped” in the chat.
- The PTY transport (spec 10.6) is not built; when it comes, it uses the same `queued` file, hook and route, typing the message instead of writing stdin.
