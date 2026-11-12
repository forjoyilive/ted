# Unsent message text is kept by the daemon

Text the human typed into a message or answer box and didn’t send was lost when they opened another Task or view, or quit TED. They want it to stay until they send or clear it, and to go when its Task is archived or deleted (KRI-268). The New Task dialog already keeps its text this way (`v2.TaskDraftSaved`).

- **One row per box.** A box is a `MessageBox`, `{ kind, id }`: `comment` and `follow-up` (a Task), `request` (a Comment), `plan-request` (a plan’s request), `run` (a Run chat; a Planning chat is its Run’s), `coordinator` and `new-plan` (a Factory). The `messageDrafts` table holds the text, the Comment box’s attached files and, for cards with more than one field, the card’s fields as one JSON string that only the app reads and checks.
- **Two events.** `v1.MessageDraftSaved` carries the row with the Task, plan and Factory it belongs to; `v1.MessageDraftCleared` deletes it. Saving empty text with no files and no fields clears. A save that changes nothing commits nothing.
- **Deleted with what it belongs to.** The row goes where the existing events update the state: `TaskArchived`, `TaskDeleted`, `CommentAnswered`, `PlanRequestAnswered`, `PlanDeleted`, `FactoryRemoved`, and the events that delete a Run (`CoordinatorRemoved`, `SideChatRemoved`, `AutomationPromptDraftRemoved`). Unarchiving restores nothing.
- **Refused saves.** `messageDraftOwner` in `routes/message-drafts.ts` finds the owner. A save for a missing or archived Task, an answered request or a missing Run or Factory answers `{ draft: null, refused }` and keeps nothing. The route looks the owner up after its last `await`, so a Task archived while the files were being checked keeps nothing.
- **Routes.** `GET` and `PUT /message-drafts/:kind/:id`, app only: the `GET` refuses any caller but the app, and the `PUT` sets neither `runToken` nor `fileToken`.
- **Attached files.** `store.filesInUse()` includes the files in saved rows, and deleting a Task removes its saved files with its others (`store.messageDraftFiles`). They are not in `store.taskFiles`, which decides what a Run may attach.
- **In the app.** `useMessageDraft(box)` in `renderer/message-drafts.ts` replaces the boxes’ own state. Components that name the same box share one session. The session (`message-draft-session.ts`) writes each change to the window’s local storage at once and to the daemon 500 ms after the last change, when the box closes, and at once when the message is sent; saves go one at a time, and the local copy is removed when the daemon has the same text. A box keeps its one session until its saves have finished, so a box closed and reopened does not get a second queue. A box keeps that session through its first read as well. Each time the daemon connection is up, `recoverMessageDrafts` opens the session of every box with a local copy left by a quit, all at once; each sends its copy and removes it once the daemon has it or refuses it, so archiving a Task deletes that text too. A box opened meanwhile joins the same session.

## Considered Options

- **Keep the text only in the window’s local storage.** The daemon could not delete it with the Task, request, Planning chat or Factory, and could not keep attached files from cleanup.
- **Delete the row from the daemon’s send routes.** There are many ways to send from one box (Comment, resume, follow-up, cancel merge, Run message). The app clears instead, right after the send succeeds.

## Consequences

- A saved text stays in the event log and in backups after it is deleted from the state.
- Typing adds at most one event per box every 500 ms.
- If TED quits between a send succeeding and the clear reaching the daemon, the sent text shows again as unsent.
- Files attached and never sent stay in `TED_HOME/attachments` after their Task is archived, as files uploaded and never sent already did.
- The thread Comment box and the Task Lead’s Run chat box are two boxes with their own text.
