# Attachments are uploaded as raw bytes and kept by content hash; a Task records its fields in one versioned event

The New Task dialog uploads each dropped or picked file as soon as it is added. The renderer reads the file’s bytes and passes them through `window.ted` to the main process, which sends them to the daemon with `POST /attachments`: the raw bytes as the body, the file name URI-encoded in an `x-ted-name` header and the media type as `content-type`. The daemon streams the body to a temporary file while hashing it, refuses anything over 25 MB with 413, and renames the file to `TED_HOME/attachments/<sha256><ext>`, where the extension is kept only if it is 1 to 10 letters or digits. The name is cut to its last path part with control characters removed; an odd media type becomes `application/octet-stream`. The same bytes uploaded twice land in the same file. The route is closed to Runs.

Creating a Task names its attachments by hash and name. The daemon checks the file exists before it records the link, so a Task can never point at bytes that were never uploaded. The Task Lead’s first message lists each attachment’s path, so the agent can read it.

A Task made by the dialog is recorded with `v2.TaskCreated`, which adds description, Priority, Clarify depth, Task Lead (agent, model, effort) and whether Start now was checked, committed together with one `v1.TaskBlockerAdded` per blocker and one `v1.TaskAttachmentAdded` per file. `v1.TaskCreated` keeps its materializer for Tasks already in the log. Start now is stored so that the Blockers ticket can start a blocked Task when its last blocker merges (spec 6.5); until then a Task with a blocker always waits in Backlog.

## Considered Options

- **The daemon reads the dropped file from its path.** Electron exposes paths only through `webUtils` in the preload, which stays unchanged (ADR 0011), and it would let a client name any file on disk for the daemon to copy. Rejected.
- **Base64 inside the JSON create request.** Inflates the body by a third, needs the 1 MB JSON limit raised for every route, and uploads all files at Create instead of while the human types. Rejected.
- **Fields added in later events after `v1.TaskCreated`.** Would emit `task-created` before the Task is complete and spread one human action over several commits. Rejected.

## Consequences

- Bytes are never deleted yet; retention and storage settings (KRI-121) decide when unreferenced attachments go.
- Attachments in Comments (KRI-111) reuse `POST /attachments` and the same folder.
