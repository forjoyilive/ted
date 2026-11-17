# Task edits keep every description version, and a live Task Lead gets the diff

Status: accepted (KRI-99)

## Context

Spec 6.1 and 6.4 let the human edit a Task’s title and description at any time. Each description edit is a new version, the first is kept as the **Original request**, a live Run gets the change as a Comment with the diff, and the thread shows an event line with **Show changes**. Spec 7.4 gives a new Run the original request next to the current description.

## Decision

- An edit is one `v1.TaskEdited` event with the new title and the new description, each null when unchanged. `TedStore.editTask` writes nothing when neither changed. The `taskDescriptions` table holds one row per version. A Task never edited has no rows; its first edit writes version 1 from the Task’s description and creation time, then version 2. `TedStore.descriptionVersions` returns version 1 alone for a Task never edited, so callers never handle the empty case.
- Only the app edits: `PUT /tasks/:id` is closed to Run tokens and to the file token (ADR 0054). An archived Task can’t be edited. The title can’t be blank; the description can.
- If the Task Lead Run is live, `Tasks.edit` sends it one message naming what changed, the description diff as `- `, `+ ` and two-space lines, and the full new description. It goes through `deliver`, like a Clarify depth change, and isn’t stored as a Comment, so the thread shows the edit once, as the event line. A Task with no live Run needs nothing held: its next Run’s prompt has the current description.
- The thread line is “You edited the description” (or “You renamed this Task to “…””); `thread.ts` computes the diff from the stored versions, so the task log holds only the version number and the new title. The diff uses `diffTexts` from `agents/diff.ts`, the same one Run chat edits use.
- A fresh Task Lead prompt adds an “Original request” section after the current description when version 1 differs from it.
- Changing Clarify depth by hand after Clarify (any Stage after Clarify, from `clarifyIsOver` in `@ted/protocol/task`) is refused with 409 and the reason; Task details shows the reason under the field, and the Task actions menu greys the item.

## Considered Options

- **Store the edit as a Ted Comment.** The thread would show it twice (as the Comment and as the event line), and a Comment can’t be withdrawn if the Run ends before reading it.
- **Put the full before and after texts in the task log.** It duplicates every version, and the log is read on every thread load.

## Consequences

- KRI-140’s Full brief can reuse `GET /tasks/:id/descriptions` for the description’s history.
- The Task Lead can’t rename a Task yet; when it can, it needs its own versioned event so the thread can say who renamed it.
