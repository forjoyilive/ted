# TED says why before macOS asks, and its own work never touches other drives

Users saw macOS permission prompts from TED that they couldn’t explain, such as a request to access files on a removable volume. macOS names the app that started a process, so a prompt that says “TED” can come from the daemon, a Run host, a Check, an agent, or a command an agent ran.

**TED’s `lsof` calls don’t check the disk.** Both `lsof` callers on macOS (`processPaths` in `packages/daemon/src/leftover-processes.ts`, ADR 0156, and `lockHolders` in `lock.ts`, ADR 0134) go through `openPaths`, which runs `lsof -b -n -P -w -a -u <uid> [-d …] -Fpn`. Without `-b`, `lsof` calls `stat` on files and on every mount point, including attached drives. `-b` can’t look up a named file, so `lockHolders` no longer names the lock files: it lists the user’s open files and matches the lock files’ real paths, which is also faster than the named lookup. Never call `lsof` without `-b` or with file names.

**Notifications wait for the user.** On macOS, the first new Inbox item no longer sends a notification. `createNotifications` calls `offer`, and the main process shows a banner under the Problems stack (“Get a notification when something needs you?”, Turn on and Not now) until it is answered. Nothing notifies before Turn on. Turn on records `asked` and shows a notification, which is what makes macOS ask. Not now records `declined` in `notifications.json`, and Settings → Notifications then shows a Turn on row. `notificationOffer` in `packages/app/src/notifications.ts` decides which of `offered`, `not-asked` and `done` the renderer shows. On Linux nothing changes: the first item notifies.

**Other requests TED can predict get a note where they start.** A repo’s local folder inside Documents, Desktop, Downloads or iCloud Drive gets a note in the Add Factory form and in Factory settings (`protectedFolderNote` in `renderer/add-factory.ts`). The administrator password dialog for installing the `ted` command names the folder it installs into.

**Requests TED can’t predict get one note.** An agent, or a command it runs, can read an attached drive or a protected folder at any time, and TED can’t see it coming. The Set up TED screen says so on macOS. TED doesn’t block it: agents keep the access their own sandbox gives them.

## Consequences

- Whether a prompt appears can’t be tested automatically. The tests check the `lsof` arguments, the offer logic and the notes; a person checks once on a Mac with an external drive attached.
- A user who never clicks Turn on gets no notifications, even for problems that stop work. The banner stays until they answer it.
