# Backups hold only the event log and share attachment files

This amends the **Backups** and **Restore** parts of ADR 0026.

On one machine `TED_HOME/backups/` reached 2.1 GB after five days. Three things made it bigger than it needed to be. Each pre-update and before-restore backup copied the whole `store/` folder, and about 65% of that was the state database, which belongs to the older state schema and is rebuilt from the event log after a restore anyway. Attachment files were copied a second time into `backups/attachments/` with a plain copy. And seven daily backups were kept, each a full copy of the event log. Separately, the hourly daily-backup check exported the whole event log into memory before it looked whether today’s backup already existed, and usually threw the export away.

## Decision

- **Pre-update and before-restore backups** hold only `store/ted-store.json` and the event log files (`store/ted/eventlog@<n>.db`, with any `-journal`, `-wal` or `-shm` beside it). Both are taken while the store is closed, so `copyStore` in `packages/daemon/src/backups.ts` copies the files with `COPYFILE_FICLONE`, as `store/compact.ts` already does for its working copy. Node clones with it on Linux file systems that can (Btrfs, XFS); on macOS its libuv makes a plain copy even on APFS, and refuses `COPYFILE_FICLONE_FORCE` with `ENOSYS`. It copies only plain files, checked with `lstat`, so a link in `store/` is never followed.
- **Restore** copies the backup’s `store/` into place with `COPYFILE_FICLONE` as before. A new backup has no state database, so the store opens as a rebuild (ADR 0026’s “when state rebuilds”). An older backup that holds a state database restores exactly as it did; a state file for another schema hash is removed after the open.
- **Attachment files** in `backups/attachments/` share disk with the originals: `shareFile` tries a forced clone, then a hard link, then a plain copy, so on macOS they are hard links. A hard link is safe only because attachment files are named by their hash and never rewritten; never hard-link a database file. Only plain files in `TED_HOME/attachments/` with a hash name are shared, and a restored attachment is cloned back with `COPYFILE_EXCL`, so it never writes through a link into the backup’s copy.
- **How many are kept:** `daily` 5, `pre-update` 3, `before-restore` 3.
- **The hourly check** passes `takeDaily` a function that exports the event log, and `takeDaily` calls it only after it finds no backup for today.
- **Pruning** deletes a backup folder only when its name matches the backup pattern, `lstat` says it is a directory and not a link, and its real path is the backups folder’s real path plus that name, the same checks `retention.ts` makes.

## Considered Options

- **Hard links for the event log.** LiveStore rewrites the event log in place, so a hard link would change with it. A clone, or a plain copy where clones aren’t available, keeps the backup fixed.
- **Leaving out the event log journal files.** The store is closed when these backups are taken and `checkStore` has already rolled back an interrupted write, so they are usually absent; copying them when present costs nothing and keeps the copy consistent if one is left.

## Consequences

- A pre-update or before-restore backup is about the size of the event log. On macOS it is a full copy until Node can clone there; cloning through `clonefile` would need another way to copy.
- `du` of `backups/` alone counts hard-linked attachment files in full although they take no new disk; the free space the disk reports is the real measure.
- Restoring a new backup always rebuilds the state database, which takes as long as an update that changes the schema.
