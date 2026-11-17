# Images and files on a Linear issue come with the Task

Status: accepted (KRI-248). Builds on ADR 0037, ADR 0073 and ADR 0090.

## Context

Ted copies a Linear issue’s title and description when the human pastes its link into New Task, and when an Automation runs `ted task create --source`. Images in the description are links to `uploads.linear.app`, and Linear signs them so they expire after about five minutes. By the time a Task Lead reads the description the link is usually dead, and files attached to the issue were never read at all.

## Decision

- **When.** `issueFor` in `packages/daemon/src/linear/linear.ts` downloads the files at the moment it fetches the issue, with the user’s key, so both paths get them. The New Task lookup caches the result for 10 minutes, so Create reuses the files the preview showed instead of fetching links that may have expired.
- **Which.** Every URL in the description on a Linear upload host (Markdown images and links, and bare URLs), then the issue’s `attachments` whose URL is on that host. Other attachments, such as pull request links, stay links. At most 20 files per issue; the rest go in the note below.
- **Where the key goes.** Downloads go only to `https://uploads.linear.app` or the origin of the configured Linear API URL (the stub in tests). Redirects are followed by hand, at most three, and only to those origins; any other target fails the download without a request to it.
- **Checks.** Each file is streamed to a temporary file in `TED_HOME/attachments` under the 25 MB attachment cap, then saved by content hash like any attachment (`Attachments.saveFile`). PNG, JPEG, GIF, WebP and PDF are named by their first bytes; SVG only if it starts like SVG. A file that says it is an image or PDF but isn’t, HTML, or a malformed type is stored as `application/octet-stream`, so the app shows it as a chip.
- **On the Task.** The files become the Task’s own attachments (`v1.TaskAttachmentAdded` in the Task’s creating commit), so the Task Lead gets their paths under “Attached files”, the details pane lists them and Original request shows the images. The Linear description stored on the Task’s source has each fetched link replaced by the file’s path; everything else in it is unchanged. A file whose download failed, was over the cap, or whose stored copy is gone by Create, is listed in one Ted note on the Task, and its link stays in the description and is listed in the note. A failure never blocks creating the Task.
- **New Task.** The lookup returns the files (`LinearIssue.files`) and the failures (`LinearIssue.unfetched`); the dialog shows the images under the source card and names what couldn’t be fetched.

## Considered Options

- **Download at Create only.** The New Task preview couldn’t show the images, and the links in a cached lookup may have expired by then. Rejected.
- **A Comment holding the files.** ADR 0073 records a Comment’s files with `v1.CommentAttachmentAdded`, but the files belong to the original request, which is what Task attachments are. Rejected.
- **Rewriting links at prompt time.** Needs a stored map from each link to its file, a new event. Rewriting once at creation keeps the shipped `v1.TaskSourceSet` event. Chosen.

## Consequences

- A lookup the human abandons leaves its downloaded files in `TED_HOME/attachments` unreferenced, like an upload for a Comment that was never sent.
- The rewritten description holds absolute paths under `TED_HOME`; moving `TED_HOME` leaves them stale, as it does the “Attached files” list.
- Pasting a link can take up to a minute while files download; downloads run four at a time with a 30-second limit each and 60 seconds in all.
