# Use the GitHub CLI’s login for all GitHub access

Ted makes every GitHub request (opening draft Task pull requests with `gh pr create --draft` and marking them ready with `gh pr ready`, watching pull requests, checks and reviews, turning on auto-merge, merging, closing pull requests, opening settings pull requests) by running the user’s installed `gh` as a child process. It never stores, reads or asks for a GitHub token, and never runs `gh auth token` or `--show-token`. Ted, not the agent, pushes Task branches. Git clone, fetch and push use the user’s existing git credentials, and Ted never changes the user’s git config. This keeps Ted from holding credentials, in line with ADR 0004, and settles the conflict between KRI-20 (a GitHub token in the Keychain) and KRI-52 (merging with `gh` under the user’s login).

## Considered Options

- **Read `gh auth token` into Ted’s own HTTP client.** Fewer processes and ETag caching, but Ted holds the token in memory. Rejected.
- **Ted’s own OAuth device flow or a GitHub App, with the token in the Keychain.** Smoother sign-in and no dependency on `gh`, but Ted becomes a credential holder, and a GitHub App needs installing in each organization. Rejected.

## Consequences

- `gh` is required to add a Factory and to merge.
- Polling starts a process each cycle; one batched GraphQL query per host keeps the cost down.
- When `gh` is signed out, Tasks at Merge show “Waiting for GitHub sign-in”, with an app-wide banner and one notification.
- GitHub Enterprise works wherever `gh` is signed in to that host.
- The Linear API key is the only secret Ted stores.
