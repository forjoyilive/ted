# GitHub and Git health through one `gh` runner, with Fix in the user’s terminal

Status: accepted (KRI-114)

## Context

ADR 0007 has TED reach GitHub only through the user’s `gh` login. Spec 9.1, 11.3 and 2.5 add that TED checks `gh auth status --json hosts` at start, every 10 minutes and after any auth error, shows the result per host in Settings → Integrations, raises an app-wide banner when `gh` is missing, too old or signed out, and runs every Fix command in the user’s own terminal. Later tickets (pull requests, watching, merging) need a way to call `gh` that keeps those rules.

## Decision

- `packages/daemon/src/github/gh.ts` is the only code that starts `gh` for GitHub requests. `createGh` gives `run`, `api` (REST, body on stdin) and `graphql` (query and variables on stdin). Every call sets `GH_PROMPT_DISABLED=1` and `GH_NO_UPDATE_NOTIFIER=1`, and `GH_HOST` when a host is given. The only `auth` subcommand it runs is `auth status --json hosts`; it refuses anything else under `auth`. A test greps every package’s sources for `auth token` and the show-token flag.
- A rate-limited call blocks further calls to that host for a backoff that starts at 1 minute and doubles up to 15 minutes. When a host has been rate limited for 15 minutes, the runner raises the `github-rate-limit` warning (“GitHub rate limit · checking again at 14:05”); the next call that works clears it. An auth error makes the daemon check health again at once.
- `packages/daemon/src/integrations.ts` owns the checks. A check reads `gh --version` against the minimum (2.81.0, from KRI-81), then `gh auth status --json hosts`, and `git --version` plus the global `user.name` and `user.email`. The hosts shown are the hosts in the Factories’ clone URLs, or `github.com` when there are none. A host is signed out when gh has no account for it or its state isn’t `success`; HTTPS without the `workflow` scope is an amber row and raises no banner.
- The result isn’t stored. The daemon keeps the last one in memory, sends it to clients as the `integrations-checked` event, and raises or clears one stops-work banner, `github-cli`, whose text counts Tasks at Merge or says “needed to add a Factory”. Its Fix runs in the daemon (`banners.onAction`) and its `action.section` names the Settings section, so the Integrations row gets the red dot. `BannerAction.section` is new and optional.
- Fix commands come only from a fixed list (`gh-install`, `gh-update`, `gh-login`, `gh-refresh`, `gh-setup-git`, `git-install`); a client names the fix and, for the `gh` sign-in commands, a host that must look like a hostname. On macOS the daemon writes a `.command` file (0700, in `TED_HOME/tmp/`, deleted by itself when it runs) that sets the login shell’s `PATH` and runs the command, and opens it with `open -a Terminal`. On Linux it starts the first of `$TERMINAL`, `x-terminal-emulator`, `gnome-terminal`, `konsole` and `xterm`. After a Fix, the daemon checks every 5 seconds for 5 minutes or until that problem is gone; the Integrations page also checks again when the window regains focus.
- The daemon reads the user’s login-shell environment (`$SHELL -l -i -c env`, 10-second timeout, falling back to the usual bin folders) at start and on every **Check again**, and finds `gh` and `git` on its `PATH`.

## Considered Options

- **Store health as events.** Health is a fact about this machine at this moment; replaying old checks after a restart would show stale states until the next check, which runs at start anyway.
- **Let clients send the command to run.** Simpler, but any client with the daemon token could then run any shell command in a terminal. A fixed list keeps Fix to the commands the spec names.
- **Poll every 5 seconds from the Settings page only.** A Fix from the banner, outside Settings, would leave the banner up until the 10-minute check.

## Consequences

- Later GitHub code takes `integrations.gh` from the daemon’s services and gets backoff, the rate-limit banner and re-checks on auth errors for free.
- The `gh` row in Settings → Integrations and `ted doctor` show the same health; `ted doctor` checks again before printing.
- Tasks at Merge don’t yet show “Waiting for GitHub sign-in”; that needs the GitHub state as a `TaskFacts` input once Merge exists.
