# Adding a Factory checks access first, then clones in the background

The Add Factory form (spec 5.1) replaces `ted dev factory add` for the human. It has two daemon routes, both in `packages/daemon/src/factory-setup.ts` and both closed to Run tokens.

**Access check.** `POST /factories/check-repo` takes one row (a folder or a typed `owner/repo` or GitHub URL, and whether it is the primary row) and returns a `RepoCheck`. A folder is read with `git rev-parse --show-toplevel` and `git config --get-regexp` only; Ted never writes to it. Its remote is `origin` if that points at GitHub, else the only GitHub remote. Then `gh api repos/{owner}/{repo}` gives the canonical name, default branch and `permissions.push`; `repos/{owner}/{repo}/commits?per_page=1` answering 409 means the repo is empty; and for the primary row, `repos/{owner}/{repo}/contents/.ted?ref=<default>` answering at all means Ted settings exist. Each problem carries its text and a list of fixes (`open-factory`, `check-again`, `github-settings`, `choose-folder`); the app only turns fixes into buttons. `GhError` now carries the HTTP status so 404 and 409 can be told apart.

**Creating.** `POST /factories` re-runs every check, checks the key with `keyProblem` from `@ted/protocol/factory` (the form uses the same function live), and commits `v2.FactoryAdded` with every repo in order (`factoryRepos` table) and `showTutorial`. The clone URL is rebuilt from `owner/repo`, as `git@github.com:…` when the given remote used SSH and `https://github.com/…` otherwise, so a token in a folder’s remote URL never reaches the store. A chosen folder becomes the repo’s local folder.

**Cloning.** The Factory exists at once. `createFactories` clones each repo into `TED_HOME/repos/<owner>/<repo>` with `git clone --progress` into a `.partial-*` folder that is renamed when done, so a crash never leaves a half clone that looks finished. A repo another Factory already cloned is fetched instead and shows “Already cloned for …”. Progress lives in memory and goes out as `factory-updated` events; this module is a third emitter of live updates next to `TedStore` and `data.ts`, because progress is never stored. A failure marks the repo failed, raises the stops-work `clone-failed` Factory banner, and is retried every minute and by Retry. When every repo is in place Ted commits `v1.FactoryCloned`; that is the event the setup Task (KRI-145) waits for. A daemon that restarts during setup starts cloning again.

**Tasks while cloning.** New Tasks can be created and started. They wait in the queue: the pump skips entries whose Factory isn’t cloned, and `Tasks.wake` runs it again when cloning finishes. Workflow resolution treats a missing clone as no Factory layer.

**Local folder banner.** “Local folder for <name> not found” is now an ordinary `banners.raise` warning, checked when the Factories are listed, every minute and after Locate. Its button has `choose: 'folder'`: the app opens its folder picker and sends the chosen path with `POST /banners/:id/action`, and the daemon’s handler sets the folder. Any banner can ask for a folder this way.

## Considered Options

- **Cloning before answering the request**, as `ted dev factory add` still does. A large repo would hold the form open for minutes, and the spec wants the Factory and its Board at once.
- **Storing clone progress in the store.** It changes many times a second and is useless after a restart, when cloning starts again anyway.
- **Keeping the folder’s remote URL as the clone URL.** It may hold a token, and it would be stored in the event log.

## Consequences

- Tasks still use only the primary repo; multi-repo Tasks (KRI-126) read `StoredFactory.repos`.
- There is no connectivity monitor yet, so “retried when the connection returns” is a retry every minute.
- First launch doesn’t open the form by itself yet; the dialog is titled “Add your first Factory” and ticks Show the tutorial whenever there are no Factories. (ADR 0162 removed the tutorial for a guide card.)
