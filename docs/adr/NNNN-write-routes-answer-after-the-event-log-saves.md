# A write route answers only after its events are in the event log on disk

`store.commit` in LiveStore returns once the event is in the client session’s in-memory state. The leader writes it to `eventlog@*.db` later, on a following turn of the event loop. A route that answered `201` straight after the commit could be killed (SIGKILL, crash) before that write, and the Task it reported as created was gone after a restart. A CLI test lost a just-created Task this way.

`TedStore.persisted()` resolves once the leader’s head has reached the session’s head at the time of the call, so every event committed before it is in the event log file. It gives up with an error after 10 seconds. `server.ts` awaits it after every non-`GET` route in the main route table and before it sends the answer, so routes don’t call it themselves.

This covers the daemon process dying. Whether the operating system has flushed the file to the disk before a power cut is a separate question this decision doesn’t answer.

## Considered Options

- **Call `persisted()` in each write route.** Rejected: every new route would have to remember it, and missing it fails silently.
- **Wait in `commit` itself.** Rejected: `commit` is synchronous, and so are most `TedStore` write methods that wrap it; making it async would change every one of them and every caller in the Tasks module and the Run manager.

## Consequences

- A write route that commits, then throws a `4xx`, doesn’t wait; nothing it reports depends on the commit.
- Writes the daemon makes on its own (a Run’s output, a background step after the answer) are saved on the leader’s schedule, as before. Code that must know a write is on disk before it does something outside the daemon calls `store.persisted()`.
- Routes before the store opens (`dataRoutes`) don’t wait; they don’t write events.
