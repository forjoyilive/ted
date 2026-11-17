# Commits, Task IDs and worktree paths in a Task’s messages are links

Messages in a Task’s thread named commits, Tasks and files as plain text, so the human could not follow them (KRI-314). The human chose links that open inside Ted: a commit’s diff, the Task, and the file in Ted’s file view.

- **Found when drawing.** `references` in `packages/app/src/renderer/references.ts` finds candidate commit hashes (7 to 40 hex characters), Task IDs and paths in a string. Nothing is stored on a Comment, so old messages get links too.
- **A link only when it leads somewhere.** `TaskReferences` (`components/References.tsx`) is set once in `TaskPanes` and decides: a Task ID links when the app holds that Task and it isn’t the open one; a path links when it is in the Task’s file list (exactly, with the repo’s name in front, or as the ending of one file only); a hash links when the daemon says it is a commit. Anything else stays plain text. Outside a Task there is no `TaskReferences` and `Markdown` and `EventLine` draw as before.
- **Markdown and thread lines.** `Markdown.tsx` adds the links with a rehype step, in text and in inline code that is one reference; never inside a link or a fenced code block. `EventLine.tsx` draws its plain text through `ReferenceText`.
- **Commits come from the daemon.** `GET /tasks/:id/commits?ids=…` answers which of up to 50 hashes are commits in the Task’s repos, and `GET /tasks/:id/commits/:hash` returns one commit’s subject, author, date and file diffs against its first parent. Both are app-only. A hash must match `isCommitId` before it reaches git and goes after `--end-of-options`; both reads go through `inScratch` in `git.ts`, so the clone’s replace refs, grafts and config don’t apply and nothing is written.
- **The commit view** (`CommitView` in `DiffViews.tsx`) opens over the thread as a `commit` entry in `middle-pane.ts`, read-only, with no line comments. A path with `:line` opens `FileView` at that line.
- **Instructions.** `workflow/defaults/writing.md` tells agents to leave out session numbers, process IDs, log names and paths outside the repo, to attach the file instead, and to name commits, Tasks and repo files so Ted can link them.

## Considered Options

- **The daemon finds the links and stores them with each Comment.** Only new messages would get links, and it needs a new event.
- **Link a commit to GitHub.** A commit that isn’t pushed has no page there, and the human asked for the diff inside Ted.
- **Load the Task’s file list for every open Task.** The list is read only once a message names something that looks like a path.

## Consequences

- A commit links only while the Task has a worktree on disk; after the worktree is removed its hashes are plain text.
- The app asks about each candidate hash once per Task and connection. A hash that wasn’t a commit when asked stays plain until the Task is opened again.
- A word of 7 or more hex characters (“defaced”) is looked up like a hash; it links only if it really names a commit.
- The commit view shows a merge commit against its first parent only, and at most 200 files.
