# An Asana tree is read whole and created in one commit

The user can import an Asana task and every unfinished task under it as a parent Task and its child Tasks (TED-179). A tree can be large, Asana answers page by page, files take time to download, and the daemon can stop at any point. A tree that is half made, or that looks finished while work is missing, would let a parent start as if its children were all there.

- **Read everything first.** `readAsanaTree` (`asana/tree.ts`) lists every subtask, page by page, then reads each unfinished item’s details, comments and attachment list, and downloads its Asana-hosted files into `TED_HOME/attachments`. Nothing is written to the store while it reads. Items already tracked in the Factory are listed but not read again.
- **Plan in one place.** `planAsanaImport` (`tasks/asana-import.ts`) decides what each item becomes: a new Task, an existing Task kept or moved under its new parent, finished context (complete in Asana or Done in TED), an archived Task left alone, a conflict (an open Task under another parent), or an item TED couldn’t read. The preview and the import use the same plan.
- **Create in one commit.** `store.createTaskTree` commits every new Task, its source, attachments and parent link, the parent links of existing Tasks, the TED notes, the missing-work question and the consumed New Task draft together. A stop before the commit leaves only unreferenced files; a stop after it leaves a whole tree. A retry reads Asana again and matches items by Asana task ID (`sourceKey` gives `asana:<gid>` for every URL form), so it never makes a second Task for an item.
- **Missing work holds the parent.** Items TED couldn’t read, subtasks it couldn’t list and conflicts go into one `question` Comment on the nearest imported parent, with `asanaMissing` (`v1.CommentAsanaMissingAsked`). While it is open the store adds a blocker link of kind `asana` to that Task, so it doesn’t start. **Retry** imports again from that Task’s Asana item with `addToTree` and closes the question in the same commit; **Go ahead without them** answers it and tells the Task Lead in a TED note. Only the app answers it; Autopilot and the Coordinator don’t.
- **Limits refuse the whole import.** More than 100 Tasks to create, more than 10 levels or more than 1,000 items listed refuses the import and says how many TED found. Per item TED copies 20,000 characters of description, 40,000 of comments (at most 100) and 20 files, and says in a TED note and the preview when it copied less.
- **Files without the token.** Only attachments Asana hosts are downloaded, from their signed `download_url`, over HTTPS to a named host, with redirects refused and no Asana token sent. Other attachments stay as links in a TED note.
- **A tracked root.** The CLI and Automations keep the existing refusal for a tracked source. The app doesn’t make a second root; it offers to add the new unfinished items under the existing Tasks (`addToTree`, app key only).

## Considered Options

- **Create Tasks as items are found and match them by task ID on retry.** A stop partway leaves a parent with some of its children and no sign that others are missing.
- **Keep an import record that a retry continues from.** It adds a second source of truth next to the Tasks, and a retry would still have to read Asana again to see what changed.

## Consequences

- An import holds the request open while it reads Asana and downloads files, and a large tree takes as long as its pages and files do.
- The preview reads Asana too, without downloading files, so the plan can change between the preview and the import; the import uses what it reads then.
- Asana content is a snapshot taken at import. Later changes in Asana don’t reach the Tasks; TED-180 adds sync.
