# Line comments are drafts the daemon attaches to the next Comment the human sends

The human writes line comments on a Task’s diff (spec §9.5). They stay drafts until the human sends their next Comment on the Task: a plain Comment, Request changes, a question answer with text, or Send and cancel merge. Approve never sends them. After Done they go with Follow up.

## Decision

- Line comments live in their own store table, written by new events: `v1.LineCommentDrafted`, `v1.LineCommentEdited`, `v1.LineCommentsDeleted` and `v1.LineCommentsSent`. A sent line comment points at the Comment it went with; for Request changes and answers, that is the request Comment that was answered. `Comment.lineComments` carries them.
- The daemon picks the drafts at send time. The app never lists draft IDs in a send, so a draft written in another window while a Comment is in flight can’t be lost or sent twice. Every path that posts a human Comment, or answers a request with the human’s words, passes `drafts(taskId)` to `store.postComment` or `answerRequest`; Approve, Deny and round answers don’t.
- The app sends only the repo, path, first and last row (old and new line numbers) and the text. The daemon finds those rows in the current diff, inside one hunk, and stores the quoted rows, the side, the line range and the HEAD commit itself.
- The Task Lead gets one message: the human’s text, then each line comment as path, line range, repo, commit SHA, the quoted rows in a `diff` fence and the text. Comments waiting for the next Run keep that block unflattened.
- “Outdated” is worked out on each read of `GET /tasks/:id/line-comments`: a new-side comment is outdated when the worktree file’s lines no longer match the quote, an old-side one when its removed rows are gone from the diff. Nothing about it is stored.

## Consequences

- Line comments never reach GitHub (KRI-72 would add that).
- Reading the worktree file follows no symlinks and stays inside the worktree; a symlinked file is never marked outdated.
- A Follow-up gets the drafts as a human Comment with no text on the new Task; its links don’t open a diff, since the lines belong to the original Task’s branch.
