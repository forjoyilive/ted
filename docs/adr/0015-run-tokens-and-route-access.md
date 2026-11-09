# Run tokens are HMACs, and every route is closed to Run tokens unless marked open

Changed by ADR NNNN-the-app-holds-the-human-token-in-memory: the token in `daemon.json` may no longer call every route; the app holds its own token in memory.

Each Run gets `TED_RUN_TOKEN` = `<run-id>.<hex HMAC-SHA256 of the run ID>`, keyed with `TED_HOME/run-token.key` (32 random bytes, mode 0600, created once). The daemon checks a Run token by recomputing the HMAC. Run tokens survive daemon restarts, because a running agent keeps the token it started with, and nothing token-related goes in the event log, which will sync between machines later.

The loopback guard (ADR 0009) accepts either the daemon token from `daemon.json`, which may call any route, or a valid Run token. Each route in the table in `server.ts` declares `runToken: true` if a Run may call it. Every other route answers a Run token with 403 and “Not allowed from inside a Run”. `DaemonClient` sends `TED_RUN_TOKEN` in place of the `daemon.json` token whenever it is set, so `ted` inside a Run is limited even though it can read `daemon.json`.

Rules for building TED:

- A new route is closed to Runs until someone marks it open on purpose, following spec 2.3’s allowed list.
- A route open to Runs that acts on a Task must also check that the Task is the Run’s own, once Runs belong to Tasks.

## Consequences

- This prevents mistakes, not attacks (spec 2.3): an agent runs as the same user and can read `daemon.json` and the key.
- Open to Runs today: `GET /tasks`, posting a Comment on the Run’s own Task, and reporting an outcome as that Task’s Task Lead (ADR 0016).
