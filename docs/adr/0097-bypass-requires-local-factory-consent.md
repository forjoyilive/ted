# Bypass requires consent for this Factory on this computer

KRI-165 closes a trust gap: a commit on the default branch could previously turn on Bypass on every computer running a Factory. Permission mode is now a machine-local, per-Factory choice, defaulting to Auto. Only a confirmed request signed by the app’s in-memory key enables Bypass; the repo and the Library cannot grant it. This supersedes ADR 0066’s permission-save confirmation and makes the mode used by ADR 0091 local.

A legacy `permissions` key remains valid YAML but is advisory. A repo asking for Bypass while this computer uses Auto raises a warning linking to Factory settings. Repo Auto does not override a local Bypass choice. We chose local authority over letting the repo lower permissions, so each computer’s human owns the whole choice.

The control saves immediately, independently of the settings pull request. Existing repo Bypass values and old Save confirmations do not migrate into consent. Removing a Factory clears its consent; another computer starts in Auto. Task Leads, sub-agents and reviewers use the local mode. Planning, Automation and Coordinator Runs retain their existing Auto behavior. New Checks and agent-started Apps use the same local mode for sandboxing; the separate confirmed exception for human-started Apps remains.

Permission changes apply to new processes, including agent restarts and recovery. Already running processes keep their access until stopped. RunManager rechecks consent rather than reusing a stored Bypass mode, recording the actual mode with the existing RunPermissionsSet event. A host consumes a prepared launch once; a SIGHUP without a fresh launch ends the host so daemon recovery must prepare the next process. Host protocol 4 replaces older hosts when idle, as ADR 0078 describes.

Permission saves and process handoffs are serialized per Factory through the daemon. A save overlapping a same-host restart waits until the next process starts (or its host and agent process group are killed on timeout); once Auto is saved, no earlier prepared Bypass launch can start. Old-host replacements prepare their launch after shutdown. Checks resolve consent separately for each process, releasing the handoff as soon as it spawns. App hosts acknowledge process start before releasing it too.

Every daemon start replaces a launch-authority nonce under TED_HOME. Agent and App hosts check the prepared nonce synchronously immediately before spawning. A prepared handoff from an earlier daemon fails closed, so a daemon restart cannot discard an in-memory permission lock and later replay its Bypass launch after Auto is saved. Existing child processes continue unchanged.

Hosts include the actual permission mode in each process start record. RunManager records that mode only after a successful handoff, and reconciles it from the durable host log when following a Run after daemon recovery. A failed restart preparation leaves the running process’s recorded mode intact.
