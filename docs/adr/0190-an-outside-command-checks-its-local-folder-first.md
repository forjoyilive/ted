# An outside command checks its local folder against GitHub first

Status: accepted (TED-551). Changes ADR 0183-outside-commands-run-only-after-the-user-allows-them.

An outside command runs in the repo’s local folder, whatever commit that folder is on. The Agent read its instructions from the chat’s copy, which follows the latest default branch. On 2026-11-17 the Release Agent ran `pnpm release build 0.1.26` in a `~/Apps/ted` that was 168 commits behind main. The old `scripts/release.ts` had no `build` word, so the command failed, and the chat concluded its own command was wrong.

**Ted checks the folder each time it plans an outside command.** `checkFolder` in `packages/daemon/src/chats/local-folder.ts` fetches the repo’s clone in `TED_HOME` (never the user’s folder) and compares the folder’s HEAD with `origin/<branch>`. The branch is the one the folder has checked out when GitHub has it, and the default branch otherwise. In the folder it runs only read-only git (`rev-parse`, `symbolic-ref`, `status --porcelain --untracked-files=no`, with `--no-optional-locks` and `core.fsmonitor=false`). It counts commits in a scratch git directory whose alternates are the clone’s objects and the folder’s objects (`commitGap` in `git.ts`), so commits that exist only in the folder are counted and nothing is written there. It also counts how far the chat’s own copy is behind the default branch. The result is a `LocalFolderCheck` (`packages/protocol/src/local-folder.ts`). When Ted can’t check (not a git repository, the fetch fails), the command runs as before with a line saying why.

**A folder that is safely behind is fast-forwarded; any other folder that is behind holds the command.** `localFolderAction` decides. Ted updates only a folder that is behind, is on a branch, has no uncommitted changes in tracked files and has no commits of its own. It runs `git fetch origin <branch>` in the folder, with a 60-second limit, then `git merge --ff-only <the commit it checked>` (`fastForwardFolder`). Git hooks run as they would for the user’s own pull, by the user’s choice in Clarify. When the folder can’t be updated, or the update fails, the command is held: the card shows even for a command set to Always allow (`allowedButHeld`), says why and how to fix it, and offers Run anyway. Ted never commits, stashes, merges, rebases or checks out in the user’s folder. Being ahead, having uncommitted changes while up to date, being on another branch or being on a branch GitHub doesn’t have is only noted. The update runs inside the one-outside-command-per-Factory rule (`OutsideCommands.update`). The check runs again when the user clicks Run. If Ted would now update to a different commit than the card showed, or would update when the card didn’t say so, or can no longer update when the card said it would, Ted records the new check on the card (`v1.ChatOutsideFolderChecked`) and refuses with nothing changed. The user clicks again on what the card now shows.

**The user and the Agent learn the same thing.** The card names the gap and its button reads Update and run when Ted will update. The chat line names the update, with the old and new commit and any changed dependency files, or the note. Ted runs no install. The message to the Agent starts with the same fact before the command output, and tells it not to change a command that failed in an old folder.

**New events, not new fields.** The check shown on a card is `v1.ChatOutsideFolderChecked` (the `outsideFolder` column on `chatRequests`, committed again when an update at Run fails); the check and update of a run are `v1.ChatOutsideFolderRan` (the `outsideFolder` column on `chatCommands`). Both are read through `parseLocalFolderState`. `v1.ChatOutsideCommandAsked` and `v1.ChatOutsideCommandRan` keep their shipped content.

## Considered Options

- **Warn only.** Rejected by the user: Ted should do what it safely can.
- **Commit or stash the user’s changes and run.** Rejected: Ted would choose what to commit, and putting stashed changes back can conflict and leave the folder half done.
- **Fetch in the user’s folder for the check.** Rejected: the check reads the folder’s objects through alternates instead, so only an update touches the folder.
- **Turn hooks off for the update.** Rejected by the user. A repo whose git config points `core.hooksPath` into the repo (husky does) runs repo code outside the sandbox when Ted updates the folder, as it would on the user’s own pull.

## Consequences

- Planning an outside command fetches the clone, so the card or the Always-allowed run can take a few seconds longer.
- A folder that is behind with local work no longer runs an Always-allowed command without a click.
- Always allow now also covers newer code: when the folder is clean and behind, an Always-allowed command is fast-forwarded to the latest commit on GitHub and runs outside the sandbox without a click, so whoever can push to that branch decides what runs. A security review raised this, and the user chose to keep it automatic, as their own `git pull` would do.
