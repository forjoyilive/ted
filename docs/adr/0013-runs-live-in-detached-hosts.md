# Each Run lives in a detached host, and the daemon reads its log by byte offset

Every Run’s agent runs under its own small host process, which the daemon starts detached (`setsid`) so it outlives the daemon. The host reads `runs/<run-id>/launch.json` under `TED_HOME`, starts the agent with pipes, writes its first input line, and keeps the agent’s stdin open so the Run stays alive between turns. It appends one JSON record per line to `runs/<run-id>/host.log`: `start` (with format version `v`, `hostPid` and `agentPid`), `out` (one agent stdout line), `err` (one stderr line) and `exit` (code and signal). The host interprets nothing.

The daemon polls each live Run’s `host.log` from the byte offset it last committed, reads only complete lines, and commits the new offset, the Conversation lines and any state change in one LiveStore commit, which is one transaction. A daemon killed before a commit re-reads from the old offset, so no output is lost and none is stored twice. On start the daemon reattaches to every Run that isn’t finished.

The host holds an exclusive SQLite lock on `runs/<run-id>/host.lock` while it runs, the same OS file lock as the daemon lock (ADR 0009). The daemon checks it only after the `start` record, since the host takes the lock before writing that record. If the lock is free, the host is gone: the daemon reads the log once more, and if it holds no `exit` record, it marks the Run finished anyway.

## Considered Options

- **Start the agent detached with stdout to a file and stdin from a FIFO, with no host.** Rejected: when the daemon dies, the FIFO’s writer closes and the agent gets end of input and exits.
- **tmux or another terminal multiplexer.** Rejected: an extra dependency built around PTYs, and Ted reads structured output.
- **The host sends output to the daemon over a socket.** Rejected for now: output written while the daemon is down would need its own buffer, and the log file already is one.

## Consequences

- A host can outlive a daemon update and keep running against a newer daemon. `launch.json` and `host.log` are a contract between versions: fields may be added, never changed or removed.
- Hook events come through the agent’s own output (ADR 0014), so they are recorded in order even while the daemon is down.
- The Run manager holds the daemon’s idle timer (ADR 0009) while it follows a live Run, so the idle exit waits.
- Polling costs one `stat` per live Run every 150 ms. File watching can replace it later without changing the log format.
- A host that dies before it writes its `start` record leaves its Run showing as working. Failed Runs (spec 7.6) will handle this.
