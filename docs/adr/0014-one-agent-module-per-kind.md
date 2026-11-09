# One module per agent kind; Claude Code runs as `claude -p` stream-json with state from hook events

All code that knows how a particular agent CLI starts lives in one module per agent kind under `packages/daemon/src/agents/` (spec 7.11, ADR 0004). A module has two functions. `launch` returns the command, args, environment, first input line and per-Run files for a new Run. `stateFrom` reads one line of the agent’s output and returns the Run state it signals, if any. The Run manager and host know nothing about any particular agent. Codex plugs into the same interface later.

Claude Code runs as:

```
claude -p --input-format stream-json --output-format stream-json --verbose
  --include-hook-events --replay-user-messages --session-id <uuid>
  --settings <TED_HOME>/runs/<run-id>/settings.json --permission-mode auto
```

- **Stream-json, not a PTY.** It gives structured output for the Conversation, takes a session ID TED picks, and needs no native module. Agent-orchestrator’s PTY handling is not ported.
- **The session ID is TED’s**, passed with `--session-id` and stored on `v1.RunStarted`, so it is known before the agent writes anything.
- **Hooks are only a signal.** `settings.json` configures each hook below with the command `true`, and `--include-hook-events` puts a `hook_started` record for each into the output stream. The state comes from `hook_event`:

  | Hook | State |
  |---|---|
  | `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure` | working |
  | `PermissionRequest` | waiting |
  | `Stop`, `StopFailure` | idle |

  Finished comes from the host’s `exit` record (ADR 0013), not a hook: the docs say `Notification` and `SessionEnd` never produce `hook_started`.
- **Per-Run flags only.** TED never writes to `~/.claude`. The CLI still keeps its own session files there, which `--resume` needs.
- The agent’s environment drops `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` (ADR 0004).

Checked on Claude Code 2.1.319 on 2026-11-08 with real `claude -p --model haiku` runs. `UserPromptSubmit` fires for every message written to stdin, `Stop` at the end of every turn, and `PermissionRequest:Bash` before a permission prompt. `hook_name` is the event name, followed by `:<tool>` for tool hooks. The user’s own hooks also produce `hook_started` records, which map the same way.

## Considered Options

- **Hook commands that call the daemon.** Rejected: hook events fired while the daemon is down would be lost, or the hook would block while `ted` starts a new daemon.
- **State from stream-json’s own `system/session_state_changed` (`running`/`idle`).** It works, but the spec says hooks, and the PTY and Codex transports need hooks anyway.

## Consequences

- With no permission handler, `claude -p` denies a prompt at once (`system/permission_denied`), so waiting lasts only a moment until spec 7.8 routes prompts to TED.
- The hook names and stream fields are not fully documented. A Claude Code update that changes them breaks Run state, and the stub agent in the tests won’t catch it.
