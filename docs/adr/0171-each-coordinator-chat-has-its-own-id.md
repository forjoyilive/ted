# Each Coordinator chat has its own ID

Status: accepted. An ended chat is an archived chat since ADR 0178-agent-chats-are-archived-like-tasks; Continue is now Unarchive.

A Factory had exactly one live Coordinator. Its row in the `coordinators` table, its events, routes, locks and queue entries were all keyed by the Factory’s ID, and **New conversation** saved the live conversation into `coordinatorConversations` before starting a fresh one (ADR 0142). The Agents screen (TED-426) needs several Coordinator chats running side by side in one Factory, each with its own conversation, receipts and requests.

**Every Coordinator chat is now a row of its own, keyed by a chat ID, and a Factory can have any number of them open at once.** One state table, `coordinatorChats` (`id`, `factoryId`, `endedAt`, `data`), replaces `coordinators` and `coordinatorConversations`. A chat with no `endedAt` is open; one with an `endedAt` has ended.

- New records are three new events keyed by chat ID: `v1.CoordinatorChatChanged` (the same set, unset and list patch as `v2.CoordinatorChanged`, built by `store/coordinator-change.ts`), `v1.CoordinatorChatContinued` (clears `endedAt`) and `v1.CoordinatorChatDeleted` (deletes the chat, its Runs, Run messages, drafts and snooze rows).
- No stored event is rewritten. The old events’ materializers now write the new table, so the state rebuild the schema change causes maps them: `v1`/`v2.CoordinatorChanged` and `v1.CoordinatorRemoved` act on the chat whose ID is the Factory’s ID, `v1.CoordinatorConversationSaved` moves that row to the saved conversation’s ID as an ended chat, and `v1.CoordinatorConversationContinued` and `…Deleted` act on the row with their ID. The chat that was open at the update keeps working under the Factory’s ID, so its message drafts and snooze rows, which were keyed by the Factory, still belong to it. Every saved conversation becomes an ended chat.
- `Coordinators` in `coordinators/coordinators.ts` keys launches, stops, deletes and queue entries by chat ID. Its Task actions keep one queue per Factory (`serial`), so two chats acting on one Task meet only the existing stale-action checks: the Task version, the neighbours’ versions and a confirmation card’s refusal when its Tasks changed. A Coordinator Run’s authority still comes from the stored Run association (`store.coordinators.forRun`), so receipts and confirmation cards land in the calling Run’s own chat and the `ted coordinator` commands are unchanged.
- Starting a chat (`POST /factories/:id/coordinator-chats`) never touches the open ones. The app’s other routes take the chat ID: `GET /coordinator-chats/:id`, `…/chat`, `…/messages`, `…/stop`, `…/retry`, `…/continue`, `…/confirmations/:id` and `DELETE /coordinator-chats/:id`. None sets `runToken` or `fileToken`. The Factory-level `/factories/:id/coordinator…` routes are gone.
- There is no end action yet: a chat started after the update stays open until it is deleted. **Continue** reopens an ended chat under the same ID; the next message resumes its last Run or starts a replacement with its history, as before. **Delete** works on any chat: an open one is stopped first, then its folders are removed with Factory removal’s checks.
- A confirmation card’s Inbox entry carries its `chatId`, and its snooze row’s owner is the chat. `GET /coordinators` reports each Factory’s busiest chat (Working, then Queued, Failed, Paused, Ready) for the sidebar.
- Each chat stores its own agent, model and effort, copied at start from the Factory’s planner default.
- Retention keeps the Run output of open and ended chats (`forRun`, `endedForRun`) until the chat is deleted or the Factory is removed.
- The app’s Coordinator screen lists open and ended chats together, newest message first, with no status chip on a row and a dot when a chat waits for the user. **New chat** opens the start page in place of **New conversation**, and an ended chat opens read only with **Continue** and **Delete…**. The message draft of a chat is keyed by its ID; the start page has its own `coordinator-new` box per Factory.

## Considered Options

- **Keep the Factory-keyed row for the newest chat and add a table for the others.** Rejected: every reader would need two paths, and the newest chat would behave differently from the rest.
- **Write a migration event that copies old rows into the new table.** Rejected: the old events already say everything needed, and replaying them into the new table needs no new record.
- **Give the open chat at the update a new random ID.** Rejected: its drafts and snooze rows are keyed by the Factory ID, and a deterministic ID keeps them attached without rewriting anything.

## Consequences

- This partly supersedes ADR 0142: conversations are no longer saved by **New conversation**; ended chats come only from conversations saved before this change, until an archive action arrives (TED-427).
- Conversation search still covers only open chats.
