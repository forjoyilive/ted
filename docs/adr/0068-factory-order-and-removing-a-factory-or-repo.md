# Factory order lives in the store; removing a Factory or a repo deletes local data in the daemon

The Order part is superseded by ADR 0166-factory-groups-are-one-layout-saved-on-this-mac: the order is now part of the Factory layout, saved through `PUT /factories/layout`. `PUT /factories/order` still works and saves a layout with the given order and the groups kept.

Spec 5.6 lets the human rename, reorder and remove Factories from the sidebar row menu, and remove a secondary repo from Factory settings.

**Order.** `v1.FactoriesReordered` stores the full list of Factory ids in the `factoryOrder` table; `listFactories` sorts by it, and a Factory missing from the list (one added since) follows in creation order. Each `Factory` carries its `position`, and the app sorts by it, so ⌘1 to ⌘9 open the Factory at that place. `PUT /factories/order` is app-only and refuses a list that doesn’t name every Factory exactly once. Rename keeps using `v1.FactoryRenamed`; the key and Task IDs never change.

**Remove Factory.** `POST /factories/:id/remove` is app-only and takes the typed key, which the daemon checks again, and `closePullRequests`. `factory-removal.ts` runs the steps in order: wait for any clone of the Factory, then `Tasks.removeFactoryTasks` archives each Task (closing its open pull requests when asked) and deletes it through the same path as Delete Task, which stops its Runs, runs `teardown`, removes worktrees and deletes its Comments, Runs and Conversations. New Tasks in that Factory are refused meanwhile. Then the Factory’s Run now scratch worktrees and banners go, `v1.FactoryRemoved` deletes the Factory, its repos, order row, deleted-Task numbers and Workflow layer, local folder settings that no other Factory uses are cleared, and `Storage.removeUnusedClones` deletes the clones of its repos that nothing else uses, with the same checks as Settings → Storage. Branches and `.ted/` stay on GitHub. `GET /factories/:id/removal` gives the dialog its counts.

**Remove a secondary repo.** An open Task is one that is neither archived nor Done; it uses a repo when the repo is in its Repos field or it still has a worktree there. While any open Task uses the repo, `GET /factories/:id/repos/:name/removal` lists those Tasks for the dialog, and preview and save refuse the edit. Otherwise the edit drops the repo’s Apps with it, drops Checks whose `repo:` names it even when the app sends the Checks list, and once the change reaches the default branch `syncRepos` drops the repo from the store and deletes its clone if nothing uses it.

## Considered Options

- **Order as a machine setting.** Rejected: it would duplicate Factory ids outside the events that create and remove them.
- **Removing the Factory record first and cleaning up in the background.** Rejected: deleting a Task needs its Factory to resolve `teardown`, so the record goes last.
