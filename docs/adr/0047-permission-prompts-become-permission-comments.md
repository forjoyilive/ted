# Permission prompts reach TED through each CLI’s own channel and become `permission` Comments

Spec 7.8 sends every permission prompt to the human. Each agent kind already has a channel for this, and both put the prompt on the agent’s stdout, which the host logs to `host.log` as it does every line.

- **Claude Code** gets `--permission-prompt-tool stdio`. A prompt is a `control_request` with subtype `can_use_tool`; TED answers with a `control_response` (`behavior: allow` with `updatedInput`, or `deny` with a message) written to stdin. `control_cancel_request` withdraws it. `auto` passes `--permission-mode auto`, `bypass` passes `bypassPermissions`.
- **Codex** gets `sandbox_mode="workspace-write"` and `approval_policy="on-request"` for `auto`, and `danger-full-access` with `approval_policy="never"` for `bypass`. The driver in the host no longer declines approval requests: it holds each one until an input line `{"permission": {"id", "approved", "grant"}}` names it, then sends Codex the reply for that method. `serverRequest/resolved` withdraws one. MCP elicitations are still declined.
- **The daemon reads prompts from `host.log`.** The Run manager asks the agent module for prompts in each batch and commits them with the batch’s output, so a daemon restart can’t lose or repeat one. A prompt becomes a `permission` Comment (`v1.PermissionRequested`) from the Run, with a title, the agent’s reason as the body, the command, any other input fields as `details`, and the repo whose worktree the Run is in. The store keeps the agent’s request ID, the host’s agent generation and the input to send back, and doesn’t publish them.
- **Answering.** `POST /comments/:id/answer` takes `approve` or `deny`, with an optional comment, and is closed to Run tokens. The answer is committed first, then the reply is appended to the Run’s `input.jsonl`. A denial carries the comment as Claude Code’s deny message; an approval’s comment, and a denial’s comment to Codex, go to the Run as an ordinary message. No “always allow”: Codex gets `accept`, never `acceptForSession`, and Claude Code’s permission suggestions are ignored.
- **What an approval covers.** The card shows every input field that affects the call, untruncated, and the reply sends back exactly that input. For Codex `item/permissions/requestApproval`, TED builds the grant from the fields it shows (network on, read paths, write paths) and stores it with the Comment; a request with any other field is denied without asking.
- **Replies are tagged with the agent generation.** The host counts the agents it has started (one per `start` record). TED writes a reply as `{"forGeneration": n, "line": …}`; the host drops it if the agent it is meant for has been replaced, so a late answer can’t reach a restarted agent whose request IDs started again.
- **Withdrawn.** A Run that finishes, or whose agent restarts, withdraws its open permission requests in the same commit (`withdrawn` with `runStopped`). A request the agent cancels is `withdrawn` with `cancelled`. A Run outside a Task has no one to ask, so its prompts are denied at once.
- **Manual-mode fallback.** When Claude Code’s `system/init` reports a permission mode other than `auto` or `bypassPermissions` (auto mode unsupported or turned off by an admin), Claude Code is in manual mode and every prompt still comes to TED. TED records `v1.RunAutoModeUnavailable`, sets `Run.manualPermissions`, and the thread says so.
- **Statuses.** A prompt makes the Run waiting and the Task Waiting on you; the activity line reads “The Task Lead is waiting on your permission” (or a sub-agent). Answering the Run’s last open prompt sets it back to working.

Checked on Claude Code 2.1.319 on 2026-11-08 with real `claude -p --model haiku` runs: `--permission-prompt-tool stdio` with `--permission-mode manual` sent a `can_use_tool` request for a `curl` command and took the deny; `--permission-mode auto` ran the same command without asking and reported `permissionMode: "auto"` in `init`. Codex request and reply shapes are from `codex app-server generate-ts` on codex-cli 0.160.0.

## Considered Options

- **A `PermissionRequest` hook that calls `ted` and blocks.** Hooks time out, and a request can wait for hours.
- **An MCP permission tool.** Needs an MCP server per Run before `ted mcp` exists, for what stdio already gives.
- **Remember the request in the host, not in `host.log`.** The daemon would lose prompts across restarts.

## Consequences

- Codex `git commit` in a worktree asks for approval (its `.git` is outside the sandbox) and now reaches the human instead of being declined.
- A host started before this change doesn’t understand the `forGeneration` envelope. Such hosts were started without `--permission-prompt-tool stdio` and with Codex approvals declined in the driver, so no prompts reach TED from them.
- The machine token in `TED_HOME/daemon.json` is readable by any process running as the user, including agent shells. A Run that reads it can call routes closed to Run tokens, including answering permission requests. Moving it out of reach is a separate decision.
