# KRI-80: can Ted hold queued Run-chat messages?

Answers gap NEW-3 (`docs/spec/ted-v1-gaps.md`) for spec §10.6. Tested 2026-11-08 on macOS with:

- Claude Code **2.1.319** (`claude --version`), model `haiku`.
- Codex **codex-cli 0.160.0** (`codex --version`), model `gpt-6-luna`, reasoning effort low.

Every experiment passes its settings as per-Run flags (`--settings`, `--setting-sources project`, `-c key=value`). Nothing was written to `~/.claude` or `~/.codex`.

## Verdict: Keep Delete

Both CLIs take a message as soon as it is written to them and keep it in their own queue, with no way to remove one message. So Ted must not hand a queued message to the CLI early. It doesn’t need to: each transport gives Ted a signal at the agent’s next step, and a message delivered at that signal still lands in the same turn. Ted keeps queued messages in its own store, delivers each at the signal, and **Delete** works until then.

## What every experiment does

The prompt asks the agent to run `sleep 4; echo one`, then `two`, then `three`, as three separate tool calls, and reply with one line. About one second into the first command, the driver sends “after the commands, reply with the single word PINEAPPLE”. The final reply shows whether, and when, the agent read it.

## Codex through `codex app-server`

| Question | Answer |
| - | - |
| When is a mid-turn message read? | `turn/steer` is accepted at once (the response returns in 10 ms). Codex adds it to the turn at the next tool-call boundary, after the running command finishes. Once sent, there is no request that removes it. |
| Signal for “next step” | `item/completed` for a tool item (`commandExecution`, `fileChange`, `mcpToolCall`, …) while the turn is active. Ted then calls `turn/steer` with `expectedTurnId`. If `turn/completed` comes first, Ted sends the message with `turn/start`. |
| Interrupt and send | `turn/interrupt` → `turn/completed` with `status: "interrupted"` arrives within 30 ms → `turn/start` with the message. The thread stays open. |

Evidence (`summarize_codex.py <file>` prints these timelines):

- `codex-steer.jsonl`: steer sent at 4.92 s during command one; the user message item appears at 7.81 s, right after command one completes; final reply `PINEAPPLE`, one turn.
- `codex-boundary.jsonl`: steer sent the moment `item/completed` for command one arrives (7.76 s); it is added at 7.80 s, before command two starts. Delivering at the signal loses nothing.
- `codex-late.jsonl`: steer sent at `item/completed` of the last command; Codex still adds it to the same turn and answers `PINEAPPLE`.
- `codex-hold.jsonl`: message held until `turn/completed`, then sent with `turn/start`; new turn answers `PINEAPPLE`.
- `codex-interrupt.jsonl`: `turn/interrupt` at 5.85 s, `turn/completed status=interrupted` at 5.88 s, `turn/start` at 5.88 s.
- Docs: https://developers.openai.com/codex/app-server (“`turn/steer` – append user input to the active in-flight turn”; “`turn/interrupt` – … the turn ends with `status: "interrupted"`”). Request and notification names were also checked against `codex app-server generate-ts` output for 0.160.0.

## Claude Code, `claude -p --input-format stream-json --output-format stream-json`

| Question | Answer |
| - | - |
| When is a mid-turn message read? | The CLI reads stdin at once and queues the message. With no `priority` (same as `"next"`), Claude reads it in the same turn as soon as the running tool calls finish. The only documented way to drop a queued message is `cancel_queued: true` on an interrupt, which stops the turn and drops every queued message. |
| Signal for “next step” | A `PostToolUse` hook passed in the per-Run `--settings`. If Ted holds a message, the hook tells the daemon a boundary is here and waits; the daemon writes the message to stdin, sees it echoed back (`--replay-user-messages`), and lets the hook return. The CLI then gives it to Claude at this same boundary. If no tool call comes before the turn ends, Ted writes the message after the `result` event. |
| Interrupt and send | `{"type":"control_request","request":{"subtype":"interrupt"}}` on stdin → `control_response` and a `result` (`error_during_execution`) at once → write the message. The process and session stay up. Alternative for **Send now**: write the message with `"priority":"now","origin":{"kind":"human"}`; Claude Code ends the turn, keeps a running shell command going, and starts a new turn with the message. |

Evidence (`summarize_claude.py <file>`):

- `claude-direct.jsonl`: message written at 2.62 s during command one; the CLI echoes it after `tool_result: one` at 5.74 s and Claude answers `PINEAPPLE` in the same turn (one `result`). Proves the CLI takes the message at once.
- `claude-gate.jsonl`: the message is held in a queue file (stand-in for Ted’s store). `gate_hook.py` signals the boundary at 5.71 s; the driver writes the message at 5.78 s; Claude gets it right after `tool_result: one` and answers `PINEAPPLE`.
- `claude-hook-delete.jsonl`: the held message is deleted before the boundary; the hook finds nothing and Claude never sees it.
- `claude-hold.jsonl`: message held until `result`, then written; next turn answers `PINEAPPLE`.
- `claude-interrupt.jsonl`: interrupt at 3.06 s, `control_response` with `still_queued: []` and `result` at 3.07–3.08 s, message written at 3.08 s and answered.
- `claude-now.jsonl`: `priority: "now"` message ends the first turn after its tool result (`result` at 5.34 s, `stop_reason: tool_use`) and a new turn answers `PINEAPPLE`.
- `system/init` advertises `interrupt_receipt_v1`, `interrupt_cancel_queued_v1` and `interrupt_send_now_v1`.
- Docs: https://code.claude.com/docs/en/agent-sdk/typescript (`SDKUserMessage.priority`: “`'next'`, or no `priority` field: Claude reads the message in the same turn, as soon as the tool calls it is running finish”; `SDKControlInterruptResponse` and `cancel_queued`), https://code.claude.com/docs/en/hooks.

## Claude Code, interactive PTY

| Question | Answer |
| - | - |
| When is a mid-turn message read? | Typing a message and pressing Enter mid-turn hands it to the CLI at once: `UserPromptSubmit` fires about a second later, while the tool is still running. Claude reads it at the next tool-call boundary, in the same turn. |
| Signal for “next step” | The same `PostToolUse` gate hook. Ted types the message and Enter while the hook waits, and confirms with the `UserPromptSubmit` hook. The `Stop` hook marks the end of a turn when no tool call comes first. |
| Interrupt and send | Press Esc, then type the message. The `Stop` hook does not fire on an interrupt, so Ted can’t use it to know the turn ended. Esc also cancels any `PostToolUse` hook that is running (hooks docs, “PostToolUse after an interrupt”). |

Evidence (event logs written by `log_hook.py`):

- `claude-pty-type.jsonl`: message typed at 9.34 s; `UserPromptSubmit` for it before the first `PostToolUse`; final message `PINEAPPLE`.
- `claude-pty-gate.jsonl`: held message typed only when the gate hook signals (16.59 s); final message `PINEAPPLE`.
- `claude-pty-interrupt.jsonl`: Esc at 13.43 s, message typed at 16.60 s, new turn answers `PINEAPPLE`. A first try of this run did not register the typed message; the second try (this log) did. Not investigated further.

## Do not deliver through `additionalContext`

`hold_hook.py` returns the held message as the `PostToolUse` hook’s `additionalContext`. Claude Code wraps that text in a system reminder, not a user message. In `-p` mode Haiku followed it (`claude-hook.jsonl`), but in the PTY run it refused: “The first tool result also carried an added note asking me to reply "PINEAPPLE." That didn’t come from you, so I ignored it.” (`claude-pty-hook.jsonl`). Ted should use hooks only as the signal and deliver the message as a real user message.

## Files

- `codex_steer.py`, `summarize_codex.py`: Codex driver (modes `steer`, `boundary`, `late`, `hold`, `interrupt`) and timeline printer. Account and MCP-status notifications were stripped from the Codex logs.
- `claude_stream.py`, `summarize_claude.py`: stream-json driver (modes `direct`, `hook`, `hook-delete`, `gate`, `now`, `interrupt`, `hold`) and timeline printer.
- `claude_pty.py`, `log_hook.py`: PTY driver (modes `hook`, `gate`, `type`, `interrupt`) and event logger.
- `gate_hook.py`, `hold_hook.py`: the two hook designs.
- `claude-help.txt`, `codex-app-server-help.txt`: `--help` output for the tested versions.

The committed transcripts were recorded with `--allowedTools Bash`. The scripts now allow only `Bash(sleep:*)` and `Bash(echo:*)`; a rerun of `claude_stream.py gate` with that rule gave the same result.
