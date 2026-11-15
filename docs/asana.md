# Connect Asana with your own OAuth app

In Settings → Integrations → Asana, connect one account for this TED installation. TED keeps app credentials and refresh tokens in your OS keyring. Once connected you can import Asana tasks as TED Tasks and keep them in step through Task Sync (below); automatic intake follows in a separate Task. Connecting and importing do not modify Asana tasks; only Task Sync writes to Asana, and only for Tasks allowed to sync.

## Register an app

1. Open [Asana’s developer console](https://app.asana.com/0/my-apps), create an app and give it a name you will recognize on the authorization screen.
2. In OAuth, register the exact callback for the edition you use:

   | Edition | Redirect URI |
   | --- | --- |
   | TED | `http://127.0.0.1:49174/asana/callback` |
   | TED Dev | `http://127.0.0.1:49175/asana/callback` |

   Use separate app registrations for TED and TED Dev. Their keyring services, home folders and callback listeners are separate. TED binds only the fixed IPv4 loopback address during authorization; if the port is busy, close another instance of that edition and retry. It never silently picks another port.
3. Under OAuth → Permission scopes, enable these scopes: `attachments:read`, `projects:read`, `stories:read`, `stories:write`, `tasks:read`, `tasks:write`, `users:read`, `workspaces:read`. Task Sync uses `stories:write` for its comments and `tasks:write` for completion. The scopes alone grant no permission to write any particular Task. Do not select Full permissions.
4. Under Manage distribution, choose Specific workspace and add the workspace of the account you want to authorize. Workspace-specific distribution is appropriate for personal/internal use. Follow your workspace’s app approval policy. A broadly distributed app has Asana’s additional distribution requirements; TED supplies no shared app registration or hosted authorization service.
5. Copy the client ID and client secret from OAuth and paste them into the **Client ID** and **Client secret** fields in TED’s Asana settings, then choose **Save**. Do not paste the secret into a Task, Run, Comment, screenshot or bug report. The app window passes it to the daemon, which stores it in the keyring; agents never receive it.
6. The settings show the same steps, the redirect URL for the edition you run with a **Copy** button, and an **Open Asana developer console** link.
7. Choose **Connect**, review the app name, account and permissions in your browser, and authorize. Return to TED for connected identity. If authorization is denied, canceled or times out after five minutes, connect again.

Asana’s current [OAuth guide](https://developers.asana.com/docs/oauth) requires a client secret for token exchange and S256 PKCE for localhost/127.0.0.1/native redirects. The [coding-client guide](https://developers.asana.com/docs/connecting-mcp-clients-to-asanas-v2-server) documents fixed HTTP loopback callbacks. The OAuth guide’s generic registration section still describes HTTPS and native out-of-band redirects. The exact TED callback must therefore be confirmed with a real registration using the smoke procedure below; automated stubs cannot prove Asana accepts a registration. If the console rejects it, stop and resolve that incompatibility. Do not substitute a hosted service, omit PKCE or use a secretless flow.

See also [permission scopes](https://developers.asana.com/docs/oauth-scopes) and [app distribution](https://developers.asana.com/docs/share-your-app).

## Storage and connection controls

A locked keyring must be unlocked before saving or using credentials. If no keyring is available, TED offers **Save in a file only you can read**. Only that explicit action enables plaintext fallback at `<TED home>/asana-credentials/oauth.json`, in a private directory with a user-only file. Keep the home folder private and protect backups of it. The normal Save never silently falls back. Dev uses keyring service `TED Dev`; release uses `TED`; both use the separate account `asana-oauth`. Linear’s keyring account is unchanged.

**Test connection** checks the active grant, app identity and all eight required scopes with Asana’s token introspection endpoint, then checks identity and refreshes an expired access token. Multiple tests share serialized credential operations and perform one refresh for an expired connection. Revoked credentials are removed locally and require reconnecting. A changed account identity is rejected until explicit reconnection.

**Reconnect as another user** disconnects the previous account before opening authorization. Canceling leaves TED disconnected. No previous account permissions are restored. **Disconnect** deletes account tokens locally, attempts remote revocation and retains app configuration. If Asana cannot confirm revocation, TED remains locally disconnected and tells you to remove the app manually in Asana → My settings → Apps. **Remove configuration** also removes the client secret. **Replace app** shows the fields again; saving a new client ID and secret disconnects the previous account, and **Cancel** leaves everything as it was.

After file-storage removal, TED retains a small credential-free removal marker so an old keyring record cannot become active again. If the keyring is unavailable, TED reports that credential deletion is pending and retries cleanup when the keyring returns; it never restores that old account.

Pending authorization holds the daemon alive until it settles. It does not survive a daemon restart. Close/cancel/timeout consumes the attempt and closes the temporary listener. State is unguessable and single-use; S256 binds each code to the daemon’s private verifier. Invalid, mismatched, duplicate and expired callbacks cannot connect an account. The normal daemon API retains app authority checks; Run tokens and the on-disk daemon token cannot configure, connect, test, cancel, disconnect or remove Asana.

## Import an Asana task and the work under it

Paste an Asana task URL in New Task, or run `ted task create --factory <key> --source <Asana task URL>`. TED reads that task and every task under it, at every depth, and shows the tree before creating anything: each item, who it is assigned to in Asana, what TED will do with it, and a line such as “6 Tasks: 3 assigned to you, 2 to others, 1 unassigned”. `ted task create … --dry-run` prints the same tree without creating it.

- The selected task becomes the parent Task and each unfinished task under it a child Task, whoever it is assigned to and whether or not it is in a project. A task you pick from the middle of a tree brings the tasks under it. Tasks complete in Asana create no Task and are listed on their parent for context; a selected task that is itself complete is still imported, marked Complete in Asana.
- Each Task keeps the item’s title, description (the Original request), assignee, completion and link. Its comments, with authors and times, and its files come along as they were at import; later changes in Asana don’t. Files stored outside Asana (Google Drive, Dropbox, links) stay as links in a TED note. Priority stays None unless you choose one; custom fields aren’t mapped.
- Any URL form for the same Asana task matches. Tasks already tracked in the Factory are reused, never overwritten or restarted: an open Task with no parent moves under its new parent, a Done Task counts as finished, and an archived one is left alone. An open Task already under a different parent stays there and is listed as a conflict.
- Importing a task that is already tracked is refused from the command line, as for any source. In New Task, TED instead offers **Add new children to the existing tree**, which creates only the unfinished items that aren’t in TED yet.
- When TED can’t read an item (no access, deleted, request failed), or an item conflicts, it creates the rest and asks you on the nearest imported parent; that Task doesn’t start until you answer. **Retry** reads Asana again and adds what it can. **Go ahead without them** lets the Task start and tells its Task Lead those items aren’t its work.
- One import creates at most 100 Tasks, 10 levels deep. A bigger tree is refused whole, with the count TED found; import one of its subtasks instead. For each item TED copies up to 20,000 characters of description, 40,000 of comments (at most 100 comments) and 20 files, and says on the Task when it copied less.
- TED creates the whole tree at once, after it has read everything and downloaded the files. If the import stops partway, nothing is created; run it again.

## Task Sync

Task Sync keeps an Asana task in step with the TED Task imported from it.

- **Who turns it on.** Every Task an import in the app creates has Task Sync from the start, including children added later with **Add new children to the existing tree** and those a **Retry** adds; the import preview says so. A Task imported from the command line or by an Automation, and any Asana Task imported before Task Sync existed, waits until you choose **Sync with Asana** in its menu in the app. Connecting Asana or a URL an agent supplies never turns it on.
- **Which account.** Task Sync belongs to the Asana account connected when it was turned on. TED writes only while that account is connected. While Asana is disconnected nothing is sent, and TED catches up when the same account connects again. If another account connects, the Task says Task Sync is paused until you choose **Sync with Asana** again.
- **What TED writes.** When TED opens a pull request, it comments on the Asana task within about a minute: “TED opened a pull request for this task: Fix checkout totals (owner/repo#12) https://github.com/…”, with the Task’s title, which TED gives the pull request. When every pull request of the Task has merged, TED completes the Asana task. It completes only the Task’s own item: a parent’s merge never completes items under it, and a parent whose Asana task has any incomplete subtask (imported or not) stays open, with the reason in the Task, until those are complete. An Asana task that is already complete gets its links and is otherwise left alone. TED never moves sections, sets custom fields, reopens tasks or completes a task for a Task archived without merging. Before each comment TED reads the task’s comments and skips a link already there, so a lost reply or a restart never posts it twice.
- **Completed in Asana.** The first read after Task Sync starts is a baseline, so a task imported already complete isn’t archived. Later, when someone completes the task in Asana, TED archives a Task with no parent, no Tasks under it, no live Run and not yet at Merge; otherwise it asks **Archive** or **Keep going** while work continues, naming any Tasks under it that Archive would also archive. The question goes away if the task is reopened or the Task finishes. Completion in Asana never marks unmerged work Done.
- **The Task Sync row** in the Task’s details shows where it stands: not syncing, syncing (waiting for merge), not completed yet (waiting for items under it), completed by TED, completed in Asana by someone else, or paused (another account, Asana not connected, or Task Sync turned off).
- **Turning it off.** The **Task Sync** switch in Settings → Integrations → Asana, on by default, stops every Asana read and write. Turning it back on catches up on links and completions that came due.
- **Requests.** TED checks Asana once a minute and sends at most 100 requests per check, waits as long as a `Retry-After` answer says, and tries any failed request again on the next check.

## Real-account smoke procedure (manual only)

Use a disposable Asana account/workspace and separate test app registrations. Never put a real credential into automated fixtures. Record only the edition, pass/fail result and safe error summary.

1. In Asana’s console, register the exact edition callback above and all eight scopes, and configure distribution. Confirm the console accepts the URL without rewriting it. This is the external compatibility check that stubs cannot supply.
2. Import a private configuration file, delete the temporary source, connect and confirm the displayed account. Deny a second attempt and confirm TED stays disconnected. Repeat with Cancel.
3. Authorize again, fully restart TED and confirm the same connected identity. Wait beyond the access token’s one-hour lifetime, then use Test connection: it should reconnect through refresh without browser authorization. Do not manually inspect or edit the keyring record to expire tokens.
4. Revoke the app in Asana. Test connection should require reconnecting and stop displaying a connected identity. Reauthorize and reconnect as another account. Confirm only that new identity appears and canceling another reconnect never restores the old one.
5. Disconnect while online, confirm TED is locally disconnected and verify the Asana authorization was removed. Reauthorize, take the network offline, then disconnect: confirm the manual revocation guidance and local disconnection. Restore the network and manually revoke the app.
6. Cancel an authorization and revisit its browser callback: it must not connect an account. Open Dev beside release with separate registrations and confirm neither callback or stored identity affects the other edition.
7. Remove configuration and confirm there is no connected account or stored client secret. Delete disposable registrations and credentials. Do not include callback query strings or tokens in reports.

### Task Sync with a real account (manual only)

Use the disposable workspace, a disposable repo for the Factory and Asana tasks you can delete afterwards. TED checks Asana once a minute, so allow a minute or two after each step.

1. In a disposable Asana project, make a parent task with two subtasks. Connect the account, paste the parent’s URL in New Task and confirm the preview says Task Sync is on. Create the Tasks. Each shows **Task Sync: Syncing** in its details.
2. Import a separate task with `pnpm ted task create --factory <key> --source <URL>`. Its Task Sync row says **Not syncing**. Choose **Sync with Asana** in its menu and confirm the row changes to **Syncing**. Nothing appears in Asana until a pull request opens.
3. Carry one child Task to Validate so TED opens its draft pull request. Within a minute or two the child’s Asana task has one comment with the pull request’s link. Restart TED (Quit, then open it again) and confirm no second comment appears.
4. Merge the child’s pull request through TED. Its Asana task becomes complete and the row says **Completed by TED**. The parent’s Asana task and the other child stay open.
5. Carry the parent to Merge and merge it while the other subtask is still open in Asana. The parent’s Asana task stays open and its row says **Not completed yet**. Complete the remaining subtask in Asana; within a minute or two TED completes the parent.
6. In Asana, complete the task behind an idle Task that hasn’t started and has no parent or children: TED archives it. Complete the task behind a working Task, or one with Tasks under it: TED asks **Archive** or **Keep going**, naming any Tasks under it. Reopen the task in Asana and confirm the question goes away.
7. Turn off **Task Sync** in Settings → Integrations → Asana and open a pull request for an allowed Task: no comment appears and the row says **Paused: Task Sync is off**. Turn it back on and confirm the comment appears. Disconnect Asana and repeat: the row says **Paused: Asana isn’t connected**, and the comment appears after you reconnect the same account.
8. Reconnect as a second disposable account. Allowed Tasks say **Paused** and nothing is written as either account. Choose **Sync with Asana** on one of them and confirm it resumes under the new account.
9. Archive an allowed Task without merging and confirm its Asana task is never completed. Delete the disposable tasks, repo and registrations afterwards.

## Validation and review

Automated coverage contacts loopback stubs only: `packages/daemon/test/asana.test.ts`, `packages/daemon/test/asana-security.test.ts`, `packages/daemon/test/asana-import.test.ts`, `packages/daemon/test/asana-import-plan.test.ts`, `packages/daemon/test/asana-sync.test.ts` (Task Sync against a fake Asana and a controlled clock) and `packages/app/test/asana.test.ts`. The stub verifies the S256 verifier, records token/identity/revocation requests, and simulates expiry, revocation, denial, redirects and network errors. Native app coverage stubs the file picker and browser launch. Tests are reserved for Validate under this Factory’s workflow.

Before merging, complete an independent code and credential/network security review of the final diff. Review app/Run authority, private-file import, edition/account isolation, callback integrity and listener cleanup, serialized refresh/account replacement, late-response invalidation, bounded requests with redirects forbidden, and absence of secrets in IPC results, events, Runs, logs and diagnostics. The design threat assessment and these instructions do not count as a completed review. Keep its findings and final disposition with the Task evidence.
