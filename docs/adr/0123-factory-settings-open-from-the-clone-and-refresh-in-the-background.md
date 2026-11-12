# Factory settings open from the clone and refresh in the background

This amends ADR 0061-factory-settings-save-through-a-pull-request and ADR 0066-factory-settings-sections-and-scratch-worktrees.

Opening Factory settings ran `git fetch --prune origin` before it answered, and so did every reload of the page: a `drift-changed` event, a local-folder change, twice after a save. The page showed only a skeleton until the fetch ended. Each open also read `.ted/` out of git twice, about 13 git processes, and parsed TED’s default layer and the Library several times.

- **The view answers from the clone.** `GET /factories/:id/settings` reads `origin/<default branch>` as the clone has it and never waits for the network. Once the commit’s files are cached it costs one `git rev-parse`, and one more after the background fetch.
- **A background fetch follows.** After the view is built, `Workflows.refresh` fetches the clone unless a fetch of that clone succeeded less than 60 seconds ago (`backgroundFetchEveryMs` in `workflow/fetches.ts`). In that case it waits and fetches once when the 60 seconds end, or ends with any fetch of that clone that succeeds sooner; one timer per clone, which doesn’t keep the daemon running and is canceled when the daemon closes. If `origin/<default branch>` then names a different commit from the one the view was built from, it resolves the Workflow again and `factory-settings.ts` emits `factory-settings-changed` with the Factory’s ID. The page reloads on that event.
- **A reload keeps unsaved edits.** A page with no unsaved edits shows the new settings. A page with unsaved edits keeps its draft and the version it loaded; Save is then refused with “The TED settings changed on GitHub after this page loaded”, as it was before for a change made after the page loaded.
- **Anything that writes or runs still fetches first.** Save and Save and merge fetch before they compare versions, and again after a merge. `mergeInherited` and Run now fetch before they read. These fetches ignore the 60 seconds.
- **One fetch per clone at a time.** `workflow/fetches.ts` runs every fetch `Workflows` makes. A caller that needs fresh data (`fresh`) never joins a fetch that was already running, because that fetch may have read the remote before the caller’s change; it waits for it and starts another, and callers that wait together share that one. The background fetch (`soon`) joins whatever is running, and so does its waiting fetch when the 60 seconds end.
- **The view has three modes.** `?refresh=first` fetches before answering, as the view did before; nothing in the app uses it, and tests that need TED to fetch now do. `?refresh=never` starts no fetch; the page uses it after a local-folder change and after a save, where the remote has nothing new to say.
- **`.ted/` is read once per commit.** `Workflows.source` hands the settings code the commit, the files and the inherited layers that `resolve` already read. The files of a commit are read once (`git ls-tree`, then the blobs in parallel) and kept until the commit changes.
- **Layers are parsed once.** TED’s default layer is read and checked once per process. The Library’s files are read on every resolve, and the checked layer is reused while the files’ text is the same, so a Save through `library-settings.ts` and an edit made outside TED both replace it on the next read without waiting for the watcher. Each resolve gets its own copy of the layers’ settings.
- **Linear intake choices are kept for `cacheMs`.** `linear.intakeChoices()` keeps one answer per API key for 10 minutes and drops it when the key is saved, tested or removed. Setting a Factory’s intake scope reads them fresh.

## Considered Options

- **Keep the fetch and cache the view.** The first open after a while would still wait for the network, which is the case the human notices.
- **Fetch on a timer for every Factory.** It fetches for Factories nobody is looking at.
- **Reuse `drift-changed` or `factory-updated` for the reload.** `drift-changed` fires only when a drift count changes, and `factory-updated` wakes the queue and the Automations for a change that is only on the settings page.
- **Drop the Library layer only when the watcher fires.** The watcher waits 150 ms and can fail to start, so a Stage entry just after an edit could use the old Library.

## Consequences

- The page can show settings up to 60 seconds older than GitHub’s when a fetch succeeded recently, and for as long as fetching fails. Save, Save and merge, `mergeInherited` and Run now are never that stale.
- The banners, the drift counts and the Factory’s stored repos, which a resolve updates, now follow a remote change when the background fetch ends rather than before the view answers.
- Two Stage entries for the same clone at the same moment fetch one after the other instead of side by side.
- A test that pushes to the remote and wants the view to show it asks with `?refresh=first`, or waits for `factory-settings-changed`.
- Editing a file in `workflow/defaults/` while TED Dev runs has no effect until the daemon restarts.
