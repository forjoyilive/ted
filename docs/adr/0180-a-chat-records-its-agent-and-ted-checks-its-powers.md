# A chat records its Agent and TED checks its powers

Status: accepted (TED-492). Builds on ADR 0179-agents-are-defined-in-agent-files, ADR 0094-coordinators-have-bounded-factory-authority, ADR 0083-planning-chats and ADR 0171-each-coordinator-chat-has-its-own-id.

ADR 0179 put every Agent in Agent files with a fixed list of powers, but the files did nothing yet: New chat could start only the Coordinator or the Planner, and what a chat could do was still decided by which routes its Run could reach. The user now starts a chat with any Agent the Factory resolves (built in, from the Library or from `.ted/`), and TED decides what that chat may do from the Agent as it was when the chat started.

**Every Agent except the Planner runs in a Coordinator chat; the Planner stays in planning chats.** Manage Tasks needs the Coordinator chat’s receipts, confirmation cards and one Task action queue per Factory, which exist only there. The Coordinator chat also needed Ask the user anyway. The planning chat’s checkout and proposal code is shared as functions (`chats/checkout.ts`, `createProposalTasks`, `approvedShape`) instead. `pickAgent` in `chats/agents.ts` refuses the Planner on a Coordinator chat and anything but the Planner on a planning chat. The Planner can’t have Manage Tasks: `ted workflow check` reports `manage_tasks` on `planner` as an error and `resolveAgents` drops it. Every other mix of powers is allowed.

**The chat stores its Agent when it starts.** `Coordinators.start` and `Plans.start` take an `agentId`, resolve the Factory’s Agents with `Workflows.resolve` without a fetch and refuse an id that doesn’t resolve. The chosen Agent’s id, name, source layer, Provider, model, powers and instructions are one `v1.ChatAgentRecorded` event, committed with the chat’s first `v1.CoordinatorChatChanged` or with `v1.PlanStarted`, into the `chatAgents` table. Its rows go with `v1.CoordinatorChatDeleted`, `v1.CoordinatorRemoved`, `v1.PlanDeleted` and `v1.FactoryRemoved`. `store.chats.agent(chatId)` reads it. A chat from before this change has no row and reads as the built-in Agent of its kind, with the built-in powers and the built-in role text from TED’s own default files, never the current `.ted/` file.

- Every launch, restart and replacement Run builds its instructions from the stored Agent, so editing the Agent changes only chats started afterwards. This replaces ADR 0179’s rule that a restarted chat reads the Agent’s current instructions.
- The Provider and model come from the stored Agent’s `agent` and `model`, else from the Factory’s planner default; a Provider chosen in the New chat form still overrides them. The Run’s name is the Agent’s name.
- A chat whose Agent is no longer in the Factory’s Agent files can still be read, archived and deleted. A message to it or an answer to its requests is refused with a reason (`removedRefusal`). Chat views carry the stored Agent and `removed` as `chatAgent`.
- `GET /factories/:id/agents` lists the resolved Agents with id, name, source, Provider, model and powers, never their instructions or file path. It is closed to Run tokens.

**TED checks each power from the stored Agent it finds through the Run token.** The caller is the Run named by its token; TED finds its chat through `store.coordinators.forRun` (only the chat’s current, working Run counts) or the plan whose ID is the Run’s ID. No request body names a chat or an Agent. `requirePower` in `chats/powers.ts` answers `403` naming the missing power.

- `actor` and `admit` in `coordinators.ts` require Manage Tasks, which covers every `ted coordinator` route.
- `Plans.post` requires Ask the user for a round and Propose Tasks for a proposal.
- `Coordinators.ask` (`POST /coordinator/requests`, the only new route open to Run tokens) requires Ask the user for a question or round and Propose Tasks for a proposal.
- Read the code decides whether the chat gets a checkout (below).

**A Coordinator chat can ask the user and propose Tasks.** Its requests are rows in `chatRequests` (`v1.ChatRequestPosted`, `v1.ChatRequestAnswered`), of kind `question`, `round` or `proposal`, reusing the `Round`, `Proposal` and `CommentAnswer` shapes. One request waits at a time; the Run replaces its own with `--supersedes`, and only by one of the same kind. A question’s text goes through `redactSecrets`. Open requests join `waiting()` as `source: 'coordinator'` with a `requestKind` and the Agent’s name, so they count in the Inbox and can be snoozed with the chat as owner. They are not held until the turn ends; the preamble tells the Agent to end its turn after asking, as the Planner’s does. Only the app answers them, through `POST /coordinator-chats/:id/requests/:rid/answer`, which never sets `runToken` or `fileToken`; the answer reaches the Run as a `from: 'ted'` message through the usual launch and resume path. They are not Task Comments, so the Coordinator’s `answer` action and `mayAnswer` never see them. Archiving the chat withdraws them. An approved proposal creates the Tasks in Backlog as the Coordinator (`coordinatorOperation`, so `v1.TaskCreatedByCoordinator`), under one parent Task when it has several rows (`childTasksCreated` from `'chat'`), lists them on the chat and leaves the chat open. Message drafts for the answer boxes are kind `coordinator-request`.

**Read the code gives a checkout under `TED_HOME/chat-code/<chatId>/`.** `checkOut` and `discard` moved from `plans.ts` to `chats/checkout.ts`. A Coordinator chat whose Agent has Read the code gets a fresh checkout of each Factory repo at its base branch when its first Run starts, made by `workingFolder` in `coordinators.ts` and stored on the chat; the checkout (or the single repo’s worktree) is the Run’s working folder. The folder name must be a chat ID and its parent must be the real `chat-code` folder. It is removed when the chat is archived (and made again at the next Run after Unarchive), deleted or its Factory removed, and at start TED removes every checkout whose chat isn’t open. Without Read the code a Coordinator Run works in its empty `TED_HOME/coordinators/<runId>/` folder as before, and a planning chat in an empty `TED_HOME/plans/<id>/`. Chat checkouts count as Worktrees in Settings → Storage.

**Read the code is a soft limit.** Ask the user, Manage Tasks and Propose Tasks are enforced by the daemon on every request. Read the code only decides whether TED makes a checkout. A chat without it gets no checkout, but its Provider’s own file tools could still read the clones and worktrees under `TED_HOME`, because TED doesn’t confine a chat Run’s file reads to its own folder. Treat it as “TED won’t hand this Agent the code”, not as a guarantee that it can’t read it.

**The preamble lists only what the powers allow.** `coordinatorInstructions(role, powers, where)` adds the `ted coordinator` commands and Task rules only with Manage Tasks, `ted ask` and `ted ask --round` only with Ask the user, `ted task propose` only with Propose Tasks and the checkout line only with Read the code; with none it says the chat has no TED commands. `plannerInstructions` drops the round section without Ask the user, the proposal section without Propose Tasks and the checkout lines without Read the code. TED’s own rules stay around the Agent’s text whatever its powers.

**`TED_CHAT` only steers the CLI.** Every Coordinator Run gets `TED_CHAT=<chatId>`. With it set, `ted ask "<question>" [--choice …]`, `ted ask --round` and `ted task propose` post to `POST /coordinator/requests` instead of a Task or a plan. The daemon ignores the value and decides who is calling from the Run token.

## Considered Options

- **One shared chat kind for every Agent.** Rejected as too large for this change: it would merge two stores, two sets of routes, the plan’s end-on-approval and the Coordinator’s receipts and cards. Sharing the checkout and proposal functions gets custom Agents the same powers without it.
- **Run custom Agents in planning chats.** Rejected: Manage Tasks would need the Coordinator’s receipts, cards and action queue rebuilt there.
- **Read the Agent’s files again at each launch.** Rejected: an edit to `.ted/` or the Library could widen a running chat’s powers without the user starting it again.
- **Hold chat requests until the turn ends, like Task requests (ADR 0141-requests-wait-for-the-end-of-the-task-leads-turn).** Rejected for now: a planning chat’s requests aren’t held either, and the preamble tells the Agent to end its turn after asking.

## Consequences

- Removing an Agent can’t strand a chat: it stays readable and can be archived or deleted.
- An old chat keeps the built-in Agent’s text from the TED version it runs on, since it has no stored copy.
- Read the code needs a sandbox for chat Runs before it can be a hard limit.
