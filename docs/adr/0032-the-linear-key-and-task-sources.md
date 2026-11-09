# The Linear key in the OS keyring, and Task sources

Status: accepted (KRI-104)

## Context

Spec 2.4, 6.2, 6.3 and 11.3: the human pastes a Linear issue URL into the New Task dialog, and TED fills in the title, Priority and branch from Linear with the Linear API key, the only secret TED stores. The key lives in the OS keyring, never in Electron’s `safeStorage`, and never reaches an agent. Without a key, or when the fetch fails, the Task is still created, with the link as its source.

## Decision

- `packages/daemon/src/linear/` owns the key and every Linear request. `keyring.ts` reads and writes service `TED`, account `linear-api-key` through `@napi-rs/keyring` (the macOS Keychain, or the Secret Service on Linux). On Linux the entry is pinned to the Secret Service, because the module otherwise falls back to the kernel keyring without saying so. A Secret Service that isn’t there or is locked is a `KeyringUnavailableError` with reason `no-keyring` or `locked`.
- `linear.ts` keeps the key only in the daemon’s memory and sends it only as the `Authorization` header to `https://api.linear.app/graphql` (requests don’t follow redirects). It never puts the key in `process.env`, a Run’s environment, a log line or the store. **Save** asks Linear who the key belongs to and refuses a key Linear rejects; an unreachable Linear still saves it. With no keyring, `PUT /integrations/linear/key` returns state `no-keyring` and stores nothing; only `inFile: true` writes `TED_HOME/secrets/linear-api-key` (file 0600, folder 0700), and only while the keyring can’t be used. **Remove** deletes the key from both places.
- The daemon checks a key once per daemon and on **Test**, and keeps the answer in memory, not as events: like GitHub health (ADR 0029) it is a fact about this machine now.
- A lookup checks the URL’s workspace against the key’s organization `urlKey` before asking for the issue, so a foreign workspace gets “This Linear key can’t read issues in <workspace>”. Found issues are kept for 10 minutes, so the dialog’s lookup and the create that follows make one fetch.
- A Task’s source is the new `v1.TaskSourceSet` event and `taskSources` table: the URL, plus the Linear identifier, title, suggested branch name and description when the fetch worked. `Task.source` carries them. `branchFor` uses the Linear branch name when `git check-ref-format` accepts it, otherwise `ted/<id>-<slug>`; clashes get `-2`, `-3` as before. The Task Lead’s first prompt gets the Linear title and description as context.
- `ted task create --source <url>` calls the same lookup first, prints why the fetch failed on stderr, and creates the Task either way.
- Tests never touch the real keyring or Linear: `TED_KEYRING_MODULE` loads `packages/daemon/test/fixtures/stub-keyring.ts` (state in `TED_HOME/stub-keyring.json`), and `TED_LINEAR_API` points at `stub-linear.ts`. `vitest.config.ts` sets both, with an address nothing listens on as the default API. The API URL must be `https`, or `http` on loopback.

## Considered Options

- **Electron `safeStorage` in the main process.** It works only in Electron’s main process, so the daemon and `ted` couldn’t read the key, and on Linux without a keyring it uses a hardcoded password.
- **Fall back to the file without asking.** Simpler, but a user who expects the key in a keyring would find it in a plain file. The spec asks for consent.
- **Let the client send the fetched issue with the create request.** Saves a fetch, but then any client could set a branch name and Linear fields TED never saw from Linear.
- **Store the lookup state on the Task.** A failed fetch is a moment’s fact; the Task keeps only what it was created with.

## Consequences

- Duplicate-source checks for Automations (spec 12.4) can match on `taskSources.url`.
- Linear keys for several workspaces (KRI-77) would need a key per workspace; today one key serves one workspace.
