# New conversation keeps the Coordinator conversation

Status: changed by ADR 0171-each-coordinator-chat-has-its-own-id and ADR 0178-agent-chats-are-archived-like-tasks. Saved conversations are archived Coordinator chats; Continue is now Unarchive.

**New conversation** used to stop the Coordinator and delete its conversation (ADR 0094). The user lost the chat, the receipts and the list of Tasks it had discussed, with no way back.

**New conversation now saves the conversation, and the Coordinator screen lists every saved one.** `Coordinators.reset` (`POST /factories/:id/coordinator/reset`) still holds saves and launches, waits for launches and actions and stops the live Run, but then commits `v1.CoordinatorConversationSaved`, which moves the stored Coordinator into the `coordinatorConversations` table and removes the live row, without deleting Runs, Run messages or folders.

- The saved copy keeps only Runs that started, ends on the last of them, and is stored `ready` with no launch, no error and no unsent messages. Messages the Coordinator hadn’t read are deleted in the same commit, and open confirmation cards are saved as canceled, so the Inbox (which reads only live Coordinators) never holds a card for a saved conversation. A conversation with no started Run is deleted as before.
- **Continue** (`POST …/conversations/:id/continue`) saves the live conversation the same way and, in the same commit, `v1.CoordinatorConversationContinued` and `v1.CoordinatorChanged` make the chosen one live again. Its last Run is stopped, so the next message starts a new Run with the saved history through the existing replacement path.
- **Delete** (`DELETE …/conversations/:id`) removes the folders with the same checks Factory removal uses, then `v1.CoordinatorConversationDeleted` deletes the row, its Runs, Run messages and drafts. Removing a Factory deletes its saved conversations the same way.
- Retention keeps a saved conversation’s Run output (`runOutputEnd` checks `store.coordinators.savedForRun`). Ted never removes a saved conversation on its own.
- Every route is the app’s: none sets `runToken` or `fileToken`. Reset, Continue and Delete hold the same per-Factory lock, so they never run at once.
- “Tasks in this conversation” lists the most recently added Task first. A Task keeps the place it got when first added.

## Considered Options

- **Keep every conversation live and let the user switch between them.** Rejected by the user in Clarify: one live conversation per Factory, and earlier ones are read until continued.
- **A menu of earlier conversations by the New conversation button.** Rejected by the user: they sit in a list on the left, like the Inbox.
- **Delete saved conversations after the Run output retention period.** Rejected by the user: they stay until deleted or the Factory is removed.

## Consequences

- Conversations deleted before this change can’t come back.
- Conversation search covers only the live Coordinator conversation.
