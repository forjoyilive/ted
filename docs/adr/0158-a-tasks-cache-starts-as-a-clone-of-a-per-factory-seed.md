# A Task’s cache starts as a clone of a per-Factory seed

This adds to ADR 0091 and ADR 0096, which give every Task a private cache folder, `TED_HOME/sandbox/<TASK-ID>/cache`, that its sandboxed commands use as `XDG_CACHE_HOME`.

Each Task’s cache started empty, so each Task’s `setup` downloaded every package again. Measured on APFS with TED’s own repo, one Task’s cache took about 520 MB of real disk, and its `node_modules` only 11–17 MB more, because pnpm already clones store files into `node_modules` (`du` counts those blocks twice). A copy-on-write clone of a filled cache took almost no disk, and an install from it downloaded nothing.

## Decision

- **One seed per Factory**, in `TED_HOME/seeds/<factory-id>/seed`, with `seed.json` beside it holding the key it was filled for. Only `packages/daemon/src/tasks/cache-seeds.ts` writes there.
- **Starting a Task’s cache.** Before a Task’s sandboxed command runs (`prepareLaunch` in `tasks/local-lifecycle.ts` and `sandboxScope` in `tasks/tasks.ts`), `startCache` checks the cache folder. When it doesn’t exist and a seed does, TED clones the whole seed folder into a temporary sibling (`cp -c -R -P` on macOS, `cp -R -P --reflink=always` on Linux) and renames it into place. A failed clone leaves the folder missing, and the sandbox makes an empty one as before. The Task then writes only its own copy.
- **No clones, no seed.** TED keeps no seed unless `seeds/` and `sandbox/` are on one volume that clones: APFS on macOS (read from `mount`, because Node can’t force a clone there), or a forced `FICLONE` copy that works on Linux. Factories in Bypass don’t use the sandbox cache, so they get no seed.
- **Filling the seed.** After each `startCache`, TED works out the key: each repo’s setup command, `worktree.env`, `worktree.copy`, base branch and the blob IDs of known lockfiles (`lockfiles` in `cache-seeds.ts`, not only pnpm’s) on `origin/<base>`, read with `git ls-tree` in the clone. When the seed is missing or its key differs, TED fills a new one in the background: it takes a `CheckSlots` place, checks `store.newWorkHold()` and the sandbox, makes detached scratch worktrees of `origin/<base>` under `seeds/<factory-id>/fill-<id>/repos/`, copies `worktree.copy` files, and runs each repo’s `setup` in the OS sandbox with `seeds/<factory-id>/fill-<id>/cache` as its cache. On success it clones that cache to `next-<id>` and, under the same per-Factory lock that clones take, swaps it in as `seed` and writes `seed.json`. A Task start never waits for a fill: a Task with no seed sets up from an empty cache, and a stale seed is still cloned while a new one fills. A key whose fill failed isn’t tried again until the daemon restarts.
- **No Task writes the seed.** The seed is a plain folder inside `TED_HOME`, checked without following links, and is never inside a folder any sandbox can write: the fill’s sandbox writes its own `fill-<id>` folders, and the seed is a clone of their result, so a process the setup left behind can’t reach it. A Task’s sandbox can’t read or write `seeds/` because ADR 0091’s profile denies the rest of `TED_HOME`.
- **Storage and removal.** Seeds and Task caches count as **Sandbox caches** in Settings → Storage. Removing a Factory stops its fill and deletes its seed folder (`Tasks.removeFactorySeed`, called from `factory-removal.ts`). A fill clears `fill-`, `next-` and `old-` folders a stopped daemon left.

## Considered Options

- **A shared read-only cache for all Tasks.** pnpm and other tools write to their cache during an install, so a read-only one fails or needs a writable overlay; a clone gives each Task a writable copy that costs nothing until it changes.
- **Cloning only pnpm’s store.** The cache folder holds npm, yarn, pip, Go, Gradle and Xcode caches too; cloning the whole `XDG_CACHE_HOME` folder helps every Factory without knowing its tools.
- **Waiting for the seed at Task start.** That would delay a Task by a whole setup when the seed is stale; starting from the old seed or an empty cache keeps start times as they were.

## Consequences

- A new Task in a Factory with a current seed costs about its own changes on disk, not a full cache, and its setup reuses packages instead of downloading them.
- The first Task in a Factory, and the first after the lockfile or setup command changes, still sets up as before; the seed is ready for the next one.
- The seed is filled by the default branch’s setup, the same code every Task of the Factory runs at start, so it trusts nothing new; what it holds reaches every later Task of that Factory, so a fill’s cache is never a Task’s cache.
- Settings → Storage counts each cloned file in full, so Sandbox caches overstates real use; free space on the disk is the real measure.
- Automation checkouts keep their own caches and don’t use the seed yet.
