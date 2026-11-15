# Asana app credentials are pasted in Settings

Setting up Asana used to mean writing the app’s client ID and client secret into a JSON file with `0600` permissions and importing it, so that only the Electron main process read the secret. Users found that hard to follow. Now Settings → Integrations → Asana has a Client ID field and a masked Client secret field, and Save sends them to the daemon.

- `configureAsana` is a forwarded request (`forwardedRequests` in `packages/app/src/daemon-requests.ts`), like `saveLinearKey` (ADR 0037). The daemon’s `PUT /integrations/asana/configuration` still validates it with `parseAsanaConfiguration` and stores the secret in the OS keyring, or in a private file only when the user chooses **Save in a file only you can read** because no keyring works.
- `connectAsana` stays out of the renderer: the main process still checks the authorization URL before opening it (`authorizeAsana` in `packages/app/src/asana.ts`).
- **Replace app** shows the fields again; the current account stays connected until a new client ID and secret are saved.
- The permission list the settings show is `asanaScopes` in `packages/protocol/src/asana.ts`, the same list the daemon requests and checks.

## Considered Options

- **Keep the file import beside the fields.** It kept the secret out of the renderer, but two ways in made the setup box longer, and the Linear key already goes through the renderer.

## Consequences

- The client secret is in the renderer’s memory while it is typed, as the Linear key is. Agents still never receive it.
