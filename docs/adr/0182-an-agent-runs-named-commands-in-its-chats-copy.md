# An Agent runs named commands in its chat’s copy

Status: accepted (TED-430). Builds on ADR 0180-a-chat-records-its-agent-and-ted-checks-its-powers, ADR 0179-agents-are-defined-in-agent-files, ADR 0091-agent-started-checks-and-apps-run-sandboxed, ADR 0103-a-machine-limit-on-checks-running-at-once and ADR 0171-ted-tells-a-check-how-many-cpus-it-may-use.

A chat whose Agent has Read the code gets a copy of the Factory’s repos, but its preamble tells it not to run repo code, and its Provider’s own shell runs under the chat’s permission rules, outside Ted’s sandbox. A reviewer or triage Agent often needs one thing more: run the tests or the typecheck and read the result. TED-430 lets an Agent list the commands it may run, and Ted runs them itself, the way it runs a Check.

**A new power, Run commands in the copy (`run_commands`), and a `commands` map per Agent.** `agents.yaml` maps each command name to a command string, or to `{ command, repo }` where `repo` names a repo of the Factory (the primary repo when left out). Names use the Agent id form, an Agent has at most 20, and a command is at most 2,000 characters. A layer’s `commands` replaces the inherited map as a whole, like `powers`. The power needs Read the code, because the commands run in the chat’s copy: `ted workflow check` reports `run_commands` without `read_code` as an error, the settings parser refuses it, and `resolveAgents` drops it. Any Agent may have it, in either chat kind. The Agent settings editor edits a command’s name and command; it keeps a `repo` it read and doesn’t offer one.

**The chat stores the commands with its Agent.** `v1.ChatAgentRecorded` is shipped, so the commands are a second event, `v1.ChatAgentCommandsRecorded`, committed in the same commit and only when the Agent has commands. It fills a new `commands` column on `chatAgents`; `store.chats.agent` returns them. A chat from before this change has none. Editing the Agent’s commands changes only chats started afterwards, as ADR 0180 decided for powers.

**The agent sends only a name; Ted finds the chat and the command.** `ted agent run <name>` posts `POST /chat-commands` with `{ name }`. The route is open to Run tokens and doesn’t time the request (`waits: true`). Ted finds the chat from the Run token, as `Coordinators.runCommand` (`currentChat`) and `Plans.runCommand` (`ownPlan`) do for every chat action, checks `run_commands` and `read_code` on the stored Agent with `requirePower`, and takes the command text from the stored Agent. A name the Agent doesn’t list is refused with `403`. The agent can’t add arguments. The request answers within 100 seconds; a command still running returns its ID, and `GET /chat-commands/:id` waits again, only from the same chat, until the CLI has the result. The CLI prints the output and exits with the command’s exit status.

**It runs like a Check, always in the sandbox.** `createChatCommands` in `chats/commands.ts` owns the run: one command at a time per chat (a second call waits for the first), `store.newWorkHold()` respected, a `CheckSlots` place with `TED_CHECK_CPUS`, `$SHELL -lc`, `checkEnv` with the repo’s `worktree.env`, low priority, and the Checks’ 10-minute timeout. It runs through `runTaskCommand` in the sandbox with the chat’s worktrees as the only writable repo folders, their clones readable, `TED_HOME/sandbox/chat-<chatId>/` for `tmp` and `cache`, and the Workflow’s `sandbox_sockets`. Chats stay in Auto, so a Bypass Factory doesn’t lift the sandbox here. When `sandbox.problem()` reports a problem, Ted raises `sandbox-unavailable` and refuses. No seed fills the cache.

**Setup runs once per copy, at the first command.** Each repo’s `setup` runs in the sandbox before the first command, through `runScratchSetup` in `tasks/scratch-setup.ts`, which the Automation checkout uses too. A marker in the chat’s sandbox folder records which copy was set up (each worktree’s inode and creation time), so a failure runs setup again next time and a copy made again after Unarchive or a plan’s Resume is set up again.

**Output goes back as data.** The agent gets the last 32 KB of the output, through `redactSecrets`, between `<<<COMMAND OUTPUT <nonce>>>>` lines with a fresh nonce and a line that calls it data. Each run is one `v1.ChatCommandRan` event (ID, chat, Factory, Run, name, outcome, exit code, start, end, and a redacted 4 KB tail) in a `chatCommands` table, deleted with the chat (`v1.CoordinatorChatDeleted`, `v1.CoordinatorRemoved`), the plan (`v1.PlanDeleted`) and the Factory (`v1.FactoryRemoved`). The Run chat shows each run as a `command` item (“Ted ran `test`”, its exit code and time, the output inside), and a running one from memory.

**Archiving and deleting end what a command left.** `discard` in `chats/checkout.ts` ends every process whose working folder or executable is inside the chat’s checkout or its sandbox folder (`endProcessesInside`, matched against folders built from real paths without following links) before it removes them, and removes the sandbox folder with `removeInside`. Coordinators and plans already call `discard` on archive, delete, Factory removal, plan end and the start-up sweep. Stop on the chat, archive and delete also abort a running or waiting command.

## Considered Options

- **Let the agent run the command in its own shell.** Rejected: that shell runs under the chat’s permission rules, outside Ted’s sandbox, with the agent’s own text as the command.
- **Arguments from the agent.** Rejected for now: a fixed command string keeps the Agent’s author in control of what runs. Narrower commands can be listed under separate names.
- **Run setup when the chat starts.** Rejected: most chats never run a command, and setup can take minutes.
- **Add `commands` to `v1.ChatAgentRecorded`.** Rejected: shipped events aren’t edited.

## Consequences

- A command can still read what the sandbox allows a Check to read; it can write only the chat’s copy and its own sandbox folders.
- Commands of an old chat, and of a chat whose Agent later gained commands, don’t exist until the user starts a new chat.
- An Always allow for other commands the agent runs is TED-434’s.
