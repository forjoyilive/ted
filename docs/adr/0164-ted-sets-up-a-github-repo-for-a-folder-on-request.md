# Ted sets up a GitHub repo for a folder when the user asks

Add Factory used to stop at a folder with no GitHub remote and tell the user to push it themselves. Now the repo row offers **Set up a GitHub repo…**: the user picks an owner (their account or one of their organizations), a name, a description and a default branch, and Ted makes a private repo and pushes the folder to it. This is the one place Ted writes to a folder the user chose, so the dialog’s help text no longer says Ted never does.

## What Ted does

`packages/daemon/src/github/repo-setup.ts` does it in steps the app runs one at a time through `POST /factories/github-setup/step`: `init` (`git init`), `ignore` (a new `.gitignore` holding only the paths the user ticked from the ones Ted offered), `commit` (“Initial commit”), `create` (a private repo through `gh api`, `user/repos` or `orgs/<owner>/repos`) and `push` (add the remote, push). Each step reads the folder again and does nothing when it is already done, so Try again resumes after a failure. `POST /factories/github-setup/plan` reads the folder’s state without writing to it, and `…/name` asks GitHub whether the name is free.

- All three routes are app-only: no `runToken`, no `fileToken`. They create a repo on the user’s account and write to the user’s folder.
- Git runs in the folder with `core.hooksPath=/dev/null` and `core.fsmonitor=false`, so no hook or file monitor in the folder runs. The commit uses the user’s own git identity, and the push uses the user’s own credentials, as clones do.
- The owner must be one `gh` lists for the signed-in user. Names, branches and paths are checked by the parsers in `packages/protocol/src/github-setup-parsers.ts`, and the `.gitignore` takes only paths Ted itself offered.
- A folder with a remote that isn’t on GitHub keeps it; the GitHub repo is added under the first free name of `origin`, `github`. A folder with uncommitted changes pushes only its commits.

## Considered Options

- `gh repo create --source --push`: one command, but its errors are text, so a taken name and a refused organization can’t be told apart, and it can’t resume.
- One request for the whole setup with progress events: needs a new `DaemonEvent` kind for a dialog that is open for seconds. Steps from the app give the same progress and make resuming natural.
