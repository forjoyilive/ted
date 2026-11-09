# Comments carry attachments; a Run uploads to its own Task and the app shows images and sandboxed HTML

Status: accepted. Builds on ADR 0022 and ADR 0054.

## Context

Spec §7.10 and §10.5 let an agent post a file with `ted comment --attach <path>` and let the human drop or paste files onto the comment box. Attachments are already stored by content hash under `TED_HOME/attachments` (ADR 0022), but `POST /attachments` is closed to Runs, and only a Task could point at files.

## Decision

**Store.** A Comment’s files are `v1.CommentAttachmentAdded` events (comment, Task, hash, name, size, media type, position), committed together with the Comment’s own `CommentPosted` event, so a Comment never appears without its files. They fill a `commentAttachments` table; a Comment carries `attachments` when it has any. `v1.TaskDeleted` clears the Task’s rows. A note may be files only; questions and rounds carry none.

**The human.** The app uploads each dropped, pasted or picked file with `POST /attachments` as soon as it is added, then names the files by hash in `POST /tasks/:id/comments`, `…/resume`, `…/cancel-merge` or `…/follow-up` (a follow-up’s files become the new Task’s attachments). The daemon checks each file exists before it records it, as for a new Task.

**Agents.** `ted comment --attach <path>` (repeatable) reads the files itself, uploads each with `POST /tasks/:id/attachments`, then posts the Comment. That route is open to Run tokens but only for the Run’s own Task, and the daemon remembers in memory which hashes each Task’s Runs uploaded. A Run’s Comment may name only those hashes or ones its own Task already has (its attachments or its Comments’), so a Run can’t pull a file from another Task into its own thread, or learn its path, by guessing a hash. The file token can’t use the route.

**Into the Run.** A human Comment’s text sent into the live Run, or listed under “Comments since the last Run” for the next one, ends with “Attached files:” and one `- <name>: <path>` line per file, the path under `TED_HOME/attachments`.

**Showing them.** `GET /attachments/:hash/:name` returns the bytes as base64 JSON, so the signed-response MAC (ADR 0054) covers it; it is closed to Runs. The renderer shows PNG, JPEG, GIF, WebP and SVG as `<img>` from a `data:` URL, which the CSP already allows. HTML goes in an `<iframe sandbox="" srcdoc>`: an opaque origin with no scripts, forms, popups or top navigation, which inherits the page’s CSP, so it can’t reach the app, `window.ted` or the network. Other files show as a chip with name and size. There is no artifacts gallery.

**Deleting.** Deleting a Task removes the files of its Task attachments and its Comments’ attachments that no other Task or Comment still names (`store.filesInUse()`).

## Considered Options

- **Open `POST /attachments` to Runs.** Any Run could then attach any file in the store by naming its hash, including a human’s file on another Task. Rejected for the per-Task route plus the upload check.
- **The daemon copies the agent’s file from a path.** The daemon would read whatever path a Run names, outside the Run’s sandbox. Rejected; the CLI, running as the agent, reads it.
- **A custom `ted-attachment://` protocol in the main process.** Would read `TED_HOME` from the app, outside `DaemonClient` (ADR 0009). Rejected.
- **HTML in a frame with `allow-scripts`.** The inherited CSP blocks inline scripts anyway, and an opaque-origin frame with scripts still has more reach than a report needs. Rejected for now.

## Consequences

- Which hashes a Task’s Runs uploaded is kept in memory; if the daemon restarts between `ted comment`’s upload and its post, the post is refused and the agent runs it again.
- A Run can still fill the disk with uploads it never attaches, up to 25 MB each; it can already write that much into its worktree. Unreferenced files wait for retention (KRI-121).
- Bytes read by the app travel as base64, a third larger than the file, up to about 34 MB for the largest attachment.
- The frame inherits the app’s CSP, which has no `style-src`, so an HTML file’s inline `<style>` and `style="…"` are ignored and it shows in the browser’s default look. Showing styled HTML would need a frame served from a separate origin; that is left for later.
