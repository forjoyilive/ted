# Stopped planning chats stay open and can resume

A planning chat ended as Stopped when the user pressed Stop, and also when its Run ended because TED quit, shut down or stopped the Run. Stop withdrew its open round or proposal, the Plans list put it under Past beside Finished chats, and only **Plan more from here** could take it further, as a new chat with a text copy of the old one. **Retry**, which resumes the same planner session, was for Failed chats only (ADR 0083). Chats were lost to an app restart, and Stopped chats’ conversations were deleted 7 days after they stopped.

**A Stopped or Failed chat stays under Open.** Only Finished chats go to Past. **Mark finished** (`POST /plans/:id/finish`, app only) ends a Stopped or Failed chat as Finished: one commit holds `v1.PlanEnded` with `finished` and a `withdrawn` answer for each open request. A running chat must be stopped first.

**A Stopped chat resumes like a Failed one.** `POST /plans/:id/resume` (app only; it replaces `/retry`) accepts both. It checks the repos out again and records the existing `v1.PlanRetried`, whose materializer clears the outcome whatever it was, so no new event is needed. A chat can resume when its Run has a session, or when it Failed before it had a Run (it then starts fresh, as Retry did). A Stopped chat with no Run can’t resume. `Plan.canResume` says so, and the app shows **Resume** (**Retry** for a Failed chat) only from it. A chat that can’t resume offers Plan more from here instead, which now also starts from a Failed chat. Resume waits for a Stop still in progress (the Run stopping and its checkout cleanup), so it never checks out the repos while that cleanup can still remove them. TED never resumes a chat on its own.

**Stopping keeps open requests when the chat can resume.** Stop, a Run that ends while TED stops it, and a failure withdraw the open round or proposal only when the chat has nothing to resume. The kept request stays in the Inbox. Answering a round or asking for changes on a Stopped chat records the answer, queues TED’s message to the planner on the Run (`v2.RunMessageQueued` with `from: 'ted'`), then resumes the chat; steering delivers the message once the planner is back, so it survives a daemon restart. Approving a proposal needs no planner and finishes the chat as before. A message typed into a Stopped chat goes through `resume` with `message` and is queued the same way, as the human’s.

**A planning chat’s Run output is kept for as long as the chat exists**, Finished chats included. Only deleting the chat removes it. `runOutputEnd` answers `keep` for every Run that is a plan.

## Considered Options

- **Resume as a new chat (Plan more from here).** Rejected in Clarify: the user wants the same conversation to carry on.
- **Keep only chats TED stopped open.** Rejected in Clarify: a chat the user stopped on purpose may still be wanted.
- **A new event for resuming a Stopped chat.** Not needed. `v1.PlanRetried` already says what resuming does.
- **Hold a pending answer in memory and add it to the resume prompt.** Rejected: a daemon restart between the answer and the resume would lose it. The Run’s message queue is already stored and delivered by steering.

## Consequences

- A chat started from a Task’s size check still tells its Task when it stops. Resuming it doesn’t tell the Task again, the same as Retry before. An approved proposal from the resumed chat still narrows the Task through `Tasks.planApproved`.
- Planning chats’ Run folders grow until the user deletes the chats.
