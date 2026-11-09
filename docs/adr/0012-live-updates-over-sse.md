# Live updates go over one Server-Sent Events stream per client

The daemon sends changes to clients over Server-Sent Events at `GET /events`, behind the same loopback guard as every other route (ADR 0009). The stream first sends a `ready` event, then one JSON `DaemonEvent` per change, such as `{ "type": "task-created", "task": … }`. The `DaemonEvent` type lives in `packages/protocol`; `DaemonClient.subscribe` reads the stream and resolves once `ready` arrives. Every 30 seconds the daemon also sends an SSE comment line, `: keepalive`, which clients skip. Without it, Node’s `fetch` fails a stream that sends nothing for 300 seconds, and the client stops receiving events.

A client subscribes first, then fetches the current state, then merges events into it by ID. Subscribing first means nothing that happens between the fetch and the subscription is lost; merging by ID drops the overlap.

`TedStore.subscribe` emits each event after its commit, so routes don’t emit events themselves. A later sync backend emits through the same seam.

An open stream counts as activity: the idle timer of a daemon started with `--exit-when-idle` stops while any stream is open and starts again when the last one closes.

## Considered Options

- **WebSocket.** Two-way, but needs a library or a hand-written framing layer, and clients only listen here. Kept for terminals, where input flows both ways.
- **Sending the whole Task list on every change.** Simpler for clients, but sends everything on every change and doesn’t fit Comments or Run output later. Rejected.

## Consequences

- Each new kind of change adds a variant to `DaemonEvent`. Clients ignore types they don’t know, so an older app keeps working against a newer daemon.
- A client that loses its stream has to subscribe and fetch again. Reconnecting after a daemon crash is KRI-119.
