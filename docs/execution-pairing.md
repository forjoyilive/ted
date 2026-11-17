# Connect an execution Mac

> **Shelved.** Remote execution is on hold. The code is kept but hidden behind `TED_REMOTE_EXECUTION=on`, which only TED Dev reads (see `docs/environment.md`). Don’t build new work on it or treat it as required.

This first version pairs Macs and reports readiness. It does not assign or run Tasks
remotely. One controlling TED keeps the Factory, Tasks, Workflow, Inbox and approvals.
An execution Mac has a smaller worker window. Its independent TED Factories, if any,
remain separate.

## Before pairing

Install the same TED release on both Macs. TED Dev pairs only with TED Dev.
Both Macs must be on the same local network and able to reach each other, using
Wi-Fi or Ethernet. Sharing internet access does not guarantee that devices can
connect; guest Wi-Fi can isolate them. Keep both Macs awake and the controlling TED
running. Cross-network VPN/internet setup and automatic discovery are outside this
first setup flow. No router port forwarding is needed.

macOS supplies the certificate tool at `/usr/bin/openssl`; both Macs need it for
pairing. The worker checks its native sandbox and reports a failure instead of
claiming support. Installed agents and agent sign-ins stay on the execution Mac;
this release labels model access unverified and never runs a paid request to check it.

## Pair in TED

1. On the main Mac, open **Settings → Machines**. Choose its local Wi-Fi/Ethernet
   address reachable from the other Mac and the listener port (default 47443).
2. Choose **Create pairing details**, then **Copy pairing details**. Details work
   once and expire after five minutes. Keep them private. While they are live, TED
   also listens for pairing on a second, randomly chosen port on the same address;
   the details name it, and it closes once they are used, cancelled or expire.
3. On the execution Mac, open **Settings → Machines → Use this Mac as a worker**.
   Alternatively launch TED with `--worker` to open directly into worker mode.
4. Paste the complete details, choose working Run capacity and choose
   **Connect to controller**. The details carry the controller’s certificate, and
   the execution Mac trusts exactly that certificate: a mismatch stops the TLS
   handshake before enrollment material is sent. Details from an older TED, which
   lack the certificate, are refused; create new ones on the main Mac. A Mac already
   paired keeps using the certificate it saved when it paired.
5. Compare the worker identity on both screens. On the main Mac, select the exact
   existing repos the worker may access and choose **Approve pairing**. Nothing is
   selected by default. Repos added later are excluded. Only the controller’s app
   authorization can approve; worker, file and Run credentials cannot.

Each screen has expandable setup, address, troubleshooting and lifecycle guidance.
To change the approved repo set, revoke and pair again with the new scope.
Re-pairing issues a new grant and never takes over old execution assignments.

## Background operation and the CLI

Closing an app-owned worker window keeps its execution process running. **Stop
worker** stops its connection but retains pairing; **Start worker** reconnects.
**Quit TED completely** stops the worker started by that app. An execution service
started independently through the CLI remains separate from the app and is stopped
with the CLI. Neither closing a window nor quitting a separate independent TED
installation gives another installation authority over its worker.

```sh
ted execution start
ted execution status
ted execution stop
```

Start reconnects with saved pairing if present; otherwise pair first. Stop ends the
standalone process and keeps its identity and pairing. Status shows public identities,
connection state, approved repos and reported readiness, never private keys or
pairing secrets. A stopped service may report that it is not running rather than a
live status. CLI control is refused inside a Run.

For CLI pairing, copy the controller’s details into standard input, then send EOF:

```sh
ted execution pair --capacity 2 < /path/to/private-pairing-details.json
```

The file is optional: any stdin source works. If you save one, use a private local
file and remove it after use; never commit it, include it in reports, or put its
contents in command arguments. Approval still happens in the main TED app.
For a foreground worker with no desktop window:

```sh
ted execution serve
```

It remains running until Ctrl-C, SIGTERM or CLI Stop. No login item or service
manager is installed. After logout or reboot, open TED in worker mode or run CLI
Start/Serve. The service can run while the remote app is closed. Sleeping or losing
the network makes it disconnected without deleting pairing. Unknown model access
and stale offline readings remain explicit. The controller allows a short heartbeat
gap; disconnected status can take up to ten seconds to appear.

Readiness includes each detected agent’s bounded local `--version` result, refreshed
at most once a minute. Failed, missing or oversized version output is shown as
unavailable with a reason. These probes use a filtered environment and do not make
model requests. Model access remains unverified.

Restart to update stops this app’s worker before handing the daemon over. A worker
started separately through CLI stays running. If installation fails, TED recovers
its daemon; reopen the worker window and select Start to reconnect with saved pairing.

## Revoke and reconnect

On the controller, choose **Revoke access** and confirm. TED durably revokes the
machine credential, immediately refuses further traffic and asks reachable execution
to stop. It does not wait for an unavailable Mac to acknowledge. Unavailable
assignments remain unresolved. Restarting either side cannot revive a revoked grant.
Fresh enrollment and user approval are required to pair again.

The worker’s certificate expires after one year; expiration requires fresh pairing
and approval in this version. The controller identity is stable across process
restart. Existing daemon HTTP routes and DaemonClient stay loopback-only; the network
connection accepts only enrollment, authenticated readiness messages and the typed
command exchange described below. There is no generic HTTP proxy or remote shell.

## Operations and disconnects

TED sends work to an execution Mac as typed operations. This version has one, a
test operation that only TED’s own validation sends; no Task runs on another Mac yet.
Both Macs write down every operation and result before they acknowledge it, so a
lost message or a restart of either side never runs an operation twice.

The worker window, `ted execution status` and the machine’s row under
Settings → Machines add a line when there is something to say:

- **Disconnected, with operations running or results waiting to send.** Work that
  was running may finish and its result is kept. Nothing new starts until the Macs
  reconnect. The controller keeps the Tasks assigned to that Mac and starts them
  nowhere else, however long the disconnect lasts.
- **Checking operations after reconnecting.** Both Macs compare their lists before
  anything new starts.
- **Stop requested, not confirmed.** A stop counts only when the execution Mac
  answers.
- **Unresolved.** After a crash the execution Mac could not tell whether an operation
  started, or it reported an operation the controller has no record of. TED holds
  it and never runs it again by itself. This version has no way to resolve it.
- **Not accepting new work.** The execution Mac holds 256 operations or 64 MiB the
  controller has not confirmed, or has less than 1 GB free. It keeps everything it
  stored and accepts work again once the controller confirms results or space is free.

## Troubleshooting

- If unreachable, check awake Macs, the main TED, local address and port, guest Wi-Fi
  isolation and local firewall rules. If macOS asks for TED’s Local Network access,
  allow it for this setup. Do not disable identity verification or expose TED publicly.
- Expired or used details need a newly created set from the main Mac.
- Wrong identity means stop and obtain fresh details directly from the intended Mac.
- A protocol/edition mismatch requires matching TED versions on both Macs.
- If the main Mac’s address changes, select the new local address, create fresh
  details and approve pairing again. Revoke obsolete grants. TED does not silently
  trust a replacement identity.
- Execution state lives in an edition-specific execution home, separate from
  independent TED storage. Do not copy the controller’s keys to another machine or
  copy a worker’s credential to a second worker.
