# Connect Asana with your own OAuth app

In Settings → Integrations → Asana, connect one account for this TED installation. TED keeps app credentials and refresh tokens in your OS keyring. This first slice supports connection only: importing, synchronization and automatic intake follow in separate Tasks. Connecting does not modify Asana tasks.

## Register an app

1. Open [Asana’s developer console](https://app.asana.com/0/my-apps), create an app and give it a name you will recognize on the authorization screen.
2. In OAuth, register the exact callback for the edition you use:

   | Edition | Redirect URI |
   | --- | --- |
   | TED | `http://127.0.0.1:49174/asana/callback` |
   | TED Dev | `http://127.0.0.1:49175/asana/callback` |

   Use separate app registrations for TED and TED Dev. Their keyring services, home folders and callback listeners are separate. TED binds only the fixed IPv4 loopback address during authorization; if the port is busy, close another instance of that edition and retry. It never silently picks another port.
3. Enable these permission scopes: `users:read`, `workspaces:read`, `projects:read`, `tasks:read`, `attachments:read`, `stories:read`, `tasks:write`, `stories:write`. These are the agreed permissions for future import and synchronization. They do not enable synchronization or grant permission to write any particular TED Task. Do not select Full permissions.
4. Under Manage distribution, make the app available in the workspace of the account you want to authorize. Workspace-specific distribution is appropriate for personal/internal use. Follow your workspace’s app approval policy. A broadly distributed app has Asana’s additional distribution requirements; TED supplies no shared app registration or hosted authorization service.
5. Copy the client ID and client secret into a temporary JSON file **outside every repo**:

   ```json
   { "client_id": "YOUR_NUMERIC_CLIENT_ID", "client_secret": "YOUR_CLIENT_SECRET" }
   ```

   Make it private with `chmod 600 /path/to/asana-app.json`. Do not paste the secret into a Task, Run, Comment, screenshot or bug report. The file must be a regular file owned by you, with no group/other permissions, symbolic link or hard links.
6. Choose **Import app configuration** in Asana settings and select that file. After successful import, delete your temporary copy. The native picker and Electron main process read it; the renderer and agents never receive its contents.
7. Choose **Connect**, review the app name, account and permissions in your browser, and authorize. Return to TED for connected identity. If authorization is denied, canceled or times out after five minutes, connect again.

Asana’s current [OAuth guide](https://developers.asana.com/docs/oauth) requires a client secret for token exchange and S256 PKCE for localhost/127.0.0.1/native redirects. The [coding-client guide](https://developers.asana.com/docs/connecting-mcp-clients-to-asanas-v2-server) documents fixed HTTP loopback callbacks. The OAuth guide’s generic registration section still describes HTTPS and native out-of-band redirects. The exact TED callback must therefore be confirmed with a real registration using the smoke procedure below; automated stubs cannot prove Asana accepts a registration. If the console rejects it, stop and resolve that incompatibility. Do not substitute a hosted service, omit PKCE or use a secretless flow.

See also [permission scopes](https://developers.asana.com/docs/oauth-scopes) and [app distribution](https://developers.asana.com/docs/share-your-app).

## Storage and connection controls

A locked keyring must be unlocked before saving or using credentials. If no keyring is available, TED offers **Import and store in a private file**. Only that explicit action enables plaintext fallback at `<TED home>/asana-credentials/oauth.json`, in a private directory with a user-only file. Keep the home folder private and protect backups of it. The normal import never silently falls back. Dev uses keyring service `TED Dev`; release uses `TED`; both use the separate account `asana-oauth`. Linear’s keyring account is unchanged.

**Test connection** checks the active grant, app identity and all eight required scopes with Asana’s token introspection endpoint, then checks identity and refreshes an expired access token. Multiple tests share serialized credential operations and perform one refresh for an expired connection. Revoked credentials are removed locally and require reconnecting. A changed account identity is rejected until explicit reconnection.

**Reconnect as another user** disconnects the previous account before opening authorization. Canceling leaves TED disconnected. No previous account permissions are restored. **Disconnect** deletes account tokens locally, attempts remote revocation and retains app configuration. If Asana cannot confirm revocation, TED remains locally disconnected and tells you to remove the app manually in Asana → My settings → Apps. **Remove configuration** also removes the client secret. Replacing configuration requires importing a valid new file and disconnects the previous account.

After file-storage removal, TED retains a small credential-free removal marker so an old keyring record cannot become active again. If the keyring is unavailable, TED reports that credential deletion is pending and retries cleanup when the keyring returns; it never restores that old account.

Pending authorization holds the daemon alive until it settles. It does not survive a daemon restart. Close/cancel/timeout consumes the attempt and closes the temporary listener. State is unguessable and single-use; S256 binds each code to the daemon’s private verifier. Invalid, mismatched, duplicate and expired callbacks cannot connect an account. The normal daemon API retains app authority checks; Run tokens and the on-disk daemon token cannot configure, connect, test, cancel, disconnect or remove Asana.

## Real-account smoke procedure (manual only)

Use a disposable Asana account/workspace and separate test app registrations. Never put a real credential into automated fixtures. Record only the edition, pass/fail result and safe error summary.

1. In Asana’s console, register the exact edition callback above and all eight scopes, and configure distribution. Confirm the console accepts the URL without rewriting it. This is the external compatibility check that stubs cannot supply.
2. Import a private configuration file, delete the temporary source, connect and confirm the displayed account. Deny a second attempt and confirm TED stays disconnected. Repeat with Cancel.
3. Authorize again, fully restart TED and confirm the same connected identity. Wait beyond the access token’s one-hour lifetime, then use Test connection: it should reconnect through refresh without browser authorization. Do not manually inspect or edit the keyring record to expire tokens.
4. Revoke the app in Asana. Test connection should require reconnecting and stop displaying a connected identity. Reauthorize and reconnect as another account. Confirm only that new identity appears and canceling another reconnect never restores the old one.
5. Disconnect while online, confirm TED is locally disconnected and verify the Asana authorization was removed. Reauthorize, take the network offline, then disconnect: confirm the manual revocation guidance and local disconnection. Restore the network and manually revoke the app.
6. Cancel an authorization and revisit its browser callback: it must not connect an account. Open Dev beside release with separate registrations and confirm neither callback or stored identity affects the other edition.
7. Remove configuration and confirm there is no connected account or stored client secret. Delete disposable registrations and credentials. Do not include callback query strings or tokens in reports.

## Validation and review

Automated coverage contacts loopback stubs only: `packages/daemon/test/asana.test.ts`, `packages/daemon/test/asana-security.test.ts` and `packages/app/test/asana.test.ts`. The stub verifies the S256 verifier, records token/identity/revocation requests, and simulates expiry, revocation, denial, redirects and network errors. Native app coverage stubs the file picker and browser launch. Tests are reserved for Validate under this Factory’s workflow.

Before merging, complete an independent code and credential/network security review of the final diff. Review app/Run authority, private-file import, edition/account isolation, callback integrity and listener cleanup, serialized refresh/account replacement, late-response invalidation, bounded requests with redirects forbidden, and absence of secrets in IPC results, events, Runs, logs and diagnostics. The design threat assessment and these instructions do not count as a completed review. Keep its findings and final disposition with the Task evidence.
