# Superseding a request is one commit that posts the new request and answers the old one

`ted ask --supersedes <id> [--choice …] "<text>"` posts a new request of the same kind as the old one and marks the old one superseded. Both happen in one store commit: a `v2.CommentPosted` for the new request and a `v1.CommentAnswered` on the old one whose answer is `{ kind: 'superseded', by: <new id> }`. A superseded request has an answer, so it leaves the Inbox and stops counting as waiting, and the thread shows it as a grey card with “Superseded by a newer question from the Task Lead”.

It goes through `POST /tasks/<id>/comments` with a `supersedes` field, open to Run tokens like the rest of that route. The daemon refuses it when the old request isn’t on the Run’s own Task (404), is a note (400), is a Gate request (409), already has an answer (409), or wasn’t posted by the caller (403). “Posted by the caller” means the same Run, or the caller is the Task Lead and the old request came from an earlier Run on the same Task. Until sub-agents exist every Run on a Task is a Task Lead Run, so a restarted Task Lead can replace its predecessor’s questions. The check-and-supersede runs under the Task’s move lock, so a human answer and a supersede can’t both land.

`ted comment --choice` and `ted outcome ask` now print the new request’s ID, which is what an agent passes to `--supersedes`.

## Considered Options

- **A new versioned event, `v1.CommentSuperseded`.** Rejected: the answer column already holds the whole answer as JSON (ADR 0032), and superseded is one more answer kind. The Inbox, the status and the card all read it from there.
- **Allow superseding Gate requests.** Rejected: a Gate request is posted by `ted outcome advance` and carries the Task brief and the approve label; replacing it with a free-form request would let an agent route around the Gate. The Task Lead changes a Gate request by asking the human to request changes, or by moving the Task, which withdraws it.

## Consequences

- When sub-agents land, “posted by the caller” must stop treating every earlier Run on the Task as a Task Lead Run.
- A red ✕ “denied” answer line waits for the permission request ticket, which adds that answer kind.
