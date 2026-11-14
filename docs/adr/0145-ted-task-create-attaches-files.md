# `ted task create` attaches files

Only `ted comment` could attach files, because only the app could upload with `POST /attachments` (ADR 0054, ADR 0073), and a Run could upload only to its own Task with `POST /tasks/:id/attachments`. An Automation Run has no Task of its own, and the user’s terminal uses the token in `daemon.json`, so neither could give a new Task its files. `POST /tasks` also took attachment hashes from any Run without checking where they came from.

**`ted task create --attach <path>`** (repeatable) uploads each file with `POST /attachments`, then names them by hash in `POST /tasks`. The files become the Task’s attachments, which the thread shows with the description, the same way as files added in the New Task form. The limits are those of `ted comment --attach`. A Follow-up or an Asana import refuses files.

**`POST /attachments` takes the `daemon.json` token and Automation Run tokens.** `Tasks.uploadForCreate` lets a Run upload only when `automationCaller` accepts it (an Automation Run whose firing is still started) and records the Run and hash in memory. At `POST /tasks`, a Run may name only files it uploaded itself; any other file is a 403. The `daemon.json` token can already create Tasks from the terminal, so uploading the files for them gives that token nothing new to reach beyond disk space, which the upload size cap limits.

## Considered Options

- **A separate upload route for Task creation.** Rejected. It would be a second copy of `POST /attachments` with the same storage and caps; the caller check in `uploadForCreate` is what differs.
- **Let any Run upload with `POST /attachments`.** Rejected, as in ADR 0073: only Automation Runs create Tasks, and the per-Run record is what stops one Run from attaching another Run’s or the human’s files by hash.
- **Keep `--attach` from the terminal out.** Rejected by the user in TED-310: the terminal can create Tasks, so it should be able to attach their files.

## Consequences

The upload record lives in memory, like `ted comment`’s, so a daemon restart between an upload and the create makes the Run upload again. The app is unchanged.
