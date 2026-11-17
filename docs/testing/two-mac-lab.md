# Two-Mac validation lab

> **Shelved.** Remote execution is on hold. The code is kept but hidden behind `TED_REMOTE_EXECUTION=on`, which only Ted Dev reads (see `docs/environment.md`). Don’t build new work on it or treat it as required.

> Validate doesn’t need this lab. Run its tests or scenarios only for a Task that works on remote execution itself and turns the flag on.

This opt-in runner deploys a committed candidate to a local controller Mac and a
distinct SSH-controlled execution Mac. SSH controls the lab only; it is not Ted’s
product execution transport. `lab-access` proves real host access, content identity,
native sandbox enforcement and owned process control. It does not prove remote Ted
execution, product reconnect behavior or GUI behavior.

The normal `scripts/validate-execution.ts` runner never reads lab inventory or
contacts these hosts. No product settings or routes are added. Later capability
Tasks extend these modules and the shared execution manifest.

## One-time setup

The user designates both accounts and roots and explicitly authorizes isolated lab
operations. The user enables Remote Login for the execution account, sets up an SSH
key and any LAN/VPN access, independently verifies the execution Mac’s ED25519 host
fingerprint, and pins it in a dedicated `known_hosts`. Never use `accept-new`, disable
host checking, forward an SSH agent, or copy private keys to the execution Mac.

The controller runs locally; it needs no SSH server. Read each Mac’s platform UUID
at its local Terminal with `/usr/sbin/ioreg -rd1 -c IOPlatformExpertDevice`. These
UUIDs and the independently pinned SSH host identity prevent loopback from being
reported as two Macs. Both identities are checked again by preflight.

Store configuration outside the checkout, for example
`$HOME/.config/ted-validation-lab/lab.json`, with mode 600. Substitute actual approved
values; the example is deliberately not a usable host inventory:

```json
{
  "version": 1,
  "labId": "ted-validation-lab-v1",
  "knownHosts": "/Users/controller/.config/ted-validation-lab/known_hosts",
  "identityFile": "/Users/controller/.ssh/ted-validation-lab",
  "reportDir": "/Users/controller/.cache/ted/execution-validation",
  "hosts": [
    {
      "role": "controller",
      "connection": "local",
      "home": "/Users/controller",
      "root": "/Users/controller/ted-validation-lab",
      "machineId": "11111111-1111-1111-1111-111111111111",
      "node": "/Users/controller/ted-validation-lab/runtime/node/bin/node",
      "pnpm": "/Users/controller/ted-validation-lab/runtime/pnpm/node_modules/.bin/pnpm"
    },
    {
      "role": "executor",
      "connection": "ssh",
      "address": "192.0.2.1",
      "user": "executor",
      "port": 22,
      "home": "/Users/executor",
      "root": "/Users/executor/ted-validation-lab",
      "machineId": "22222222-2222-2222-2222-222222222222",
      "node": "/Users/executor/ted-validation-lab/runtime/node/bin/node",
      "pnpm": "/Users/executor/ted-validation-lab/runtime/pnpm/node_modules/.bin/pnpm"
    }
  ]
}
```

Roots are dedicated `ted-validation-lab` children of the approved accounts’ homes.
They must be new or already carry this lab’s ownership marker, have no symlink
ancestors and be owned by that account. These are lab conventions, not public
product provisioning. Configuration, key paths and reports remain outside
deployments and disposable Task worktrees. The current lab’s concrete access
details and approval are in TED-110’s brief and its controller’s external config;
future Task Leads should read them there rather than rediscover or reprovision hosts.

## Repeatable commands

Run from a clean, committed candidate checkout with Node 24 available locally:

```sh
lab_config="$HOME/.config/ted-validation-lab/lab.json"

# Configuration validation only; no host contact or report writes.
node scripts/validate-execution-lab.ts --opt-in --config "$lab_config" \
  --action dry-run --scenario lab-access

# Once per lab: install Node 24.7.0 and pnpm 10.28.0 inside both owned roots.
node scripts/validate-execution-lab.ts --opt-in --config "$lab_config" --action bootstrap

# Identity, account, tools, native sandbox availability and actual free space.
node scripts/validate-execution-lab.ts --opt-in --config "$lab_config" \
  --action preflight --scenario lab-access

# Deploy, build, verify content/artifacts, probe, exercise processes and clean runs.
node scripts/validate-execution-lab.ts --opt-in --config "$lab_config" \
  --action acceptance --scenario lab-access
```

Bootstrap downloads official Node archives over HTTPS and checks hard-coded SHA256
digests from that version’s official SHASUMS256.txt. It installs pinned pnpm through
the bundled npm with scripts disabled and an isolated HOME/cache. It changes no
system tools or shell startup files. Downloads, extraction and dependency installation
use a fresh, exclusively created owned staging directory. Existing runtimes are
validated and preserved without writes; unsafe or incomplete ones are refused for
inspection. Interrupted staging is removed only through its own ownership marker.
Never remove an unmarked directory to force installation.

Preflight requires Node 24, pnpm 10.28.0, Git, a functioning native
`/usr/bin/sandbox-exec`, distinct pinned Mac identities, the designated accounts and
at least 5 GiB actual free space. The simulated free-space/load/online fixture files
are explicitly supplied only to test services; they do not replace physical preflight.

Deployment accepts only ordinary committed files whose bytes/modes match HEAD.
Dirty, symlink, submodule, traversal, personal `.env`, credential and secret paths
are refused. A SHA256 content manifest is verified on both hosts, before and after
build. Dependencies install with a frozen lockfile, isolated store and scripts
disabled. Both hosts build the renderer; their artifact hashes must match. Initial
acceptance needs no Electron binary or desktop login. A later GUI scenario must
prepare a logged-in test desktop and install its required native artifacts explicitly.

Each run lives at `<root>/runs/<run-id>`, with ownership metadata, source, dependencies,
isolated account/cache/temp and `ted-home`. Services receive a fresh explicit env
including stub Claude/Codex/Gh, keyring, integration endpoints, simulated
disk/load/online and GUI/login/priority overrides. Paths resolve on the launching
host. No Run credentials, personal sign-in, `.env`, Git/Gh credentials or agent API
keys are forwarded. `SSH_AUTH_SOCK` is used only by local SSH control, never deployed.

## Scenarios, process control and faults

For a retained deployment, use `--action deploy --scenario lab-access`; it prints a
run ID. With that ID, `verify`, `build`, `probe`, `start`, `observe`, `stop`, `restart`,
`connect`, `disconnect` and `cleanup` act only on that run on both Macs:

```sh
lab_run_id="COPY-THE-PRINTED-RUN-ID"
node scripts/validate-execution-lab.ts --opt-in --config "$lab_config" \
  --action start --scenario lab-access --run-id "$lab_run_id"
node scripts/validate-execution-lab.ts --opt-in --config "$lab_config" \
  --action observe --scenario lab-access --run-id "$lab_run_id"
node scripts/validate-execution-lab.ts --opt-in --config "$lab_config" \
  --action connect --scenario lab-access --run-id "$lab_run_id"
node scripts/validate-execution-lab.ts --opt-in --config "$lab_config" \
  --action disconnect --scenario lab-access --run-id "$lab_run_id"
node scripts/validate-execution-lab.ts --opt-in --config "$lab_config" \
  --action observe --scenario lab-access --run-id "$lab_run_id"
node scripts/validate-execution-lab.ts --opt-in --config "$lab_config" \
  --action cleanup --scenario lab-access --run-id "$lab_run_id"
```

The initial owned service is a stub with heartbeat/start counters and an ephemeral
loopback socket. `connect` creates an owned loopback relay to that exact owned
endpoint; `disconnect` stops only that relay. SSH remains usable. Acceptance checks
the service’s PID, generation token and start count stay unchanged through this
fixture disconnect. This is infrastructure evidence only. Later product adapters
must put the test product transport behind the owned relay and observe real product
counters to prove continued remote work and absence of duplicate/new work. Never
disconnect a whole Mac’s network or SSH, or claim the stub demonstrates Ted behavior.

Run selected implemented manifest scenarios on a retained deployment in Validate:

```sh
node scripts/validate-execution-lab.ts --opt-in --config "$lab_config" \
  --action scenario --scenario ownership --run-id "$lab_run_id"
```

The deployed candidate’s existing runner dispatches exactly the selected files,
reuses Vitest suite slots/cleanup and their wait budget, requires invariant observations, and returns
redacted reports. Scenario reports persist under `<root>/reports/<run-id>`, outside
the disposable deployment. The lab validates ownership and supplies a report allocator
to the shared runner; its normal report-directory policy is unchanged. Scenario
children use the approved account’s HOME for the machine’s shared test slots while
TED_HOME, credentials, integration stubs and caches remain explicitly isolated.
Unknown scenarios fail; unavailable/skipped scenarios never pass.
Normal suite/Stage restrictions still apply: do not invoke scenario tests during Work.
Do not remove or replace other Tasks’ manifest rows, including `local-lifecycle` and
`native-sandbox`. Tests of a capability must use its real product implementation.

`probe` arranges synthetic bare repos separately on each host before later scenarios.
Those absolute paths are reachable only on their owning host. A future cross-host
scenario must arrange a reachable fixture endpoint before using it; it cannot use
a controller-local file URL on the mini. SSH may arrange fixtures and faults but
must not perform product worktree, artifact or commit operations in place of Ted.

## Reports and recovery

Every contacting action publishes the existing versioned report/summary format in
the external report directory. Reports contain candidate revision/tree, content and
artifact SHA256 hashes, actual identities, observations, durations, errors, replay
argv and the run ID. Diagnostics are redacted and bounded; no raw homes, environment
dumps or credential stores are collected. Per-command stdout/stderr is bounded at
128 KiB on hosts and 512 KiB on the controller, and failure.txt is capped at 256 KiB.
Reports persist until explicitly removed by the user; each failed run retains only
bounded evidence. Failed runs never become passes through missing observations.

Acceptance collects results before cleanup, stops owned processes, verifies exit,
removes only the owned run directories and preserves the root/runtime and siblings.
Signals require the recorded PID, UID, start time, command path and generation token.
After a verified termination request, polling tolerates transient exit-state changes;
ownership is checked again before any forced signal. Cleanup attempts both hosts
even if one fails, and an already-removed run succeeds only after verifying no
marked processes remain.
Interrupted build descendants are found by exact run/home environment markers;
their full identities are rechecked before signals and never copied into reports.
If inspection or ownership fails, cleanup refuses and leaves scratch for recovery.

After an interrupted command, use its reported run ID with `observe`, `stop`,
`disconnect` or `cleanup`. These recovery commands remain usable from a dirty
checkout; new candidate deployment and scenario execution require a clean commit.
If a Mac is unreachable, restore SSH first and retry owned cleanup. Never substitute
`killall`, broad `pkill`, `rm -rf` on an unverified path, or deleting an ownership marker.
Cleanup executes independently of report writes, including when report storage is
unavailable at recovery startup. It still attempts both hosts and reports failure
to the caller when evidence cannot be published. A report/cleanup error is a
failure, not permission to broaden cleanup.

The module tests are `scripts/execution-lab.test.ts`. A Task that changes the lab
runs that file and `scripts/validate-execution.test.ts` in Validate, plus Typecheck/Lint;
no other Task needs them. Real two-Mac acceptance
must also run through the lab CLI; fake SSH tests cannot satisfy that requirement.

## Product commands checkpoint (TED-113)

```sh
TED_HOME="$PWD/node_modules/.cache/ted-home" node scripts/validate-execution-lab.ts \
  --opt-in --config "$HOME/.config/ted-validation-lab/lab.json" \
  --action acceptance --scenario product-commands
```

This runs the pairing checkpoint below with one change: the execution Mac connects
to an owned relay on the controller’s verified local address, which forwards to the
product TLS listener on the same Mac. After the worker restart check it:

1. assigns a synthetic Task to the paired Mac and issues one dummy operation that waits;
2. makes the relay swallow the controller’s answers, releases the operation and waits
   until the controller has saved the result while the execution Mac still holds it
   unconfirmed;
3. cuts the relay (only the product connection; SSH and the network stay up);
4. restarts the execution service, then the controller, each by itself;
5. restores the relay and waits for the confirmation;
6. reads the counter on the execution Mac, which must be one;
7. sends a command at generation 2 and then one at generation 1, which must be refused
   as stale with no side effect.

Expected invariants, besides the four pairing ones: `two-mac-command-once`,
`two-mac-service-restarts` and `two-mac-stale-refused`. The report records the
operation ID, both execution-service PIDs, the counter and the refusal, with no
credentials.

## Product pairing checkpoint (TED-112)

In Validate, deploy a clean committed candidate and run:

```sh
TED_HOME="$PWD/node_modules/.cache/ted-home" node scripts/validate-execution-lab.ts \
  --opt-in --config "$HOME/.config/ted-validation-lab/lab.json" \
  --action acceptance --scenario product-pairing
```

This selects a dedicated product adapter after the existing pinned-host preflight,
committed content verification, deployment and build on both Macs. It chooses the
controller’s explicitly assigned local route to the approved execution Mac. Before
pairing, it checks the OS route against the local interface/address inventory and
macOS hardware-port inventory. Only a Wi-Fi or Ethernet `enN` interface with the
selected address is supported; VPN/tunnel, bridge, unknown and unassigned routes
fail the checkpoint. Reports record the selected address, interface and hardware
port beside the TLS endpoint. The adapter binds only that private address and
connects the remote worker outbound over the product
TLS transport. SSH supplies deployment/process control and transfers enrollment
details as private stdin setup data; it does not implement enrollment, readiness or
revocation. Enrollment details are never returned in report observations or printed
as replay arguments. The synthetic controller app client keeps its fresh approval
key in memory; the worker never receives it.

The adapter observes wrong-identity refusal before enrollment, incompatible-version
refusal, matching pending identities on both Macs, app-authorized approval of a
synthetic repo, live readiness including a real native sandbox probe, worker process
restart with the same identity/grant, live revocation and refused restart. Agent
starts remain zero. Actual host UUIDs, public controller/worker identities, grant ID,
authorization results and observed process change are recorded without credentials.

Expected product invariants are `two-mac-pairing`, `two-mac-worker-restart`,
`two-mac-peer-refusal` and `two-mac-revocation`. Every observation must be present;
missing access, sandbox failure or an unavailable process is unresolved. This
checkpoint proves product pairing only, not remote Task execution or real GUI use.
The app test supplies separate unattended GUI evidence.

Acceptance cleans deployments on both Macs, even after failure. Cleanup recognizes
only the exact lab-run marker, UID, execution home and deployed product entry path,
or the existing ordinary fixture markers; it rechecks process identity before any
signal. If interrupted, use the normal `--action cleanup --run-id <printed-id>`
recovery with the same external config and scenario. Never delete an unmarked root,
forward an SSH agent or copy a private key into a deployment/report.


For the replacement-pairing repair, Validate runs the `pairing-replacement` shared
scenario once. It selects the daemon pairing, native app pairing and lab adapter
files (three files total), covering CLI Stop → Pair and app Quit → Pair with a
still-valid saved grant, fresh approval on a second controller, ordinary restart,
and supported-interface/refused-tunnel adapter boundaries. The physical
`product-pairing` checkpoint still needs a fresh report from the committed
candidate; adapter parser coverage does not substitute for either Mac.
