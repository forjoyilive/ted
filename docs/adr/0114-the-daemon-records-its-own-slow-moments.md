# The daemon records its own slow moments

The daemon’s JavaScript runs on one thread. Twice in one week a hot path blocked its event loop for hundreds of milliseconds to seconds, and each time it was found only by sending the live daemon SIGUSR1 and attaching Node’s inspector. That opens a debug port without authentication on the process that holds the app’s key, and it shows only the seconds someone records. The daemon now says for itself which requests were slow and when it was blocked, and the app can record a CPU profile without any port.

## Slow requests

`server.ts` times every route from the moment its handler starts until the response is written, which for a route other than a `GET` includes the wait for `store.persisted()`. Authentication, reading a signed body and waiting for the store to open are not counted. A request that took 100 ms or more is counted and logged through `console.warn`:

```
slow request: GET /tasks/:id/runs 200 took 312 ms (handler 310 ms)
slow requests: GET /tasks/:id/runs 14 more in the last 10 s, slowest 880 ms
```

The first line is written for a route’s first slow request. Further slow requests on the same route in the next 10 seconds are held and written as one count, so one route writes at most six lines a minute.

The route is named by `routePattern` in `routes/route.ts`, which works only from the route’s regular expression: every capture group becomes `:id` (or `:action` for a fixed list of words) and everything from the query string on is dropped. Nothing from the request’s URL, headers or body reaches the log or the figures. A test checks that every route’s pattern is made only of fixed words, `:id` and `:action`.

A route that holds its response open on purpose sets `waits: true` and is not timed: `GET /events`, the Task shell output long-poll, `GET /sub-agents/:id/wait`, `GET /peers/watch`, `POST /browser/poll`, `POST /tasks/:id/browser` (which waits for the app to carry out the command) and `POST /diagnostics/profile`. Routes that are slow because they do real work (a Factory settings save waiting for its merge, a health check running `gh`) are timed and logged; they are rare and the line is true.

## Event-loop stalls

`slow-moments.ts` runs one unref’d 50 ms interval and measures how late each tick is. A tick 200 ms or more late is one stall of that length. Each tick reads the clock and `process.cpuUsage()`.

`monitorEventLoopDelay` was the other choice. It keeps a histogram, so it can give the longest delay in a period but not how many stalls there were or how long each one was, and those are the figures wanted. The interval needs nothing beyond timers, so it behaves the same under Electron run as Node. The cost is that a stall is measured up to 50 ms short.

After the computer sleeps or the process is stopped, the first tick can be late by the whole pause. A tick 5 seconds or more late during which the process used less than a tenth of that time in CPU is treated as the process having been suspended and is not counted. A real stall of that length that used almost no CPU (a long synchronous wait on a file or a child process) would be missed too.

```
event loop blocked for 412 ms
event loop blocked 14 times in the last 60 s: 6200 ms in total, longest 1800 ms
```

A stall gets its own line when no stall line was written in the last 10 seconds. Later stalls are held and written as one summary 60 seconds after the last line. A slow request and the stall that caused it both log.

## Figures

The monitor keeps counts by second for one hour, in memory only. `GET /diagnostics/slow` returns `SlowMoments` (`packages/protocol/src/slow.ts`): the thresholds, `lastMinute` and `lastHour` (stalls and slow requests as count, total and longest, and the ten routes with the most slow time), and `minutes`, sixty one-minute totals, oldest first, for a chart. It is a `GET` in `server.ts`, so it works while the store is opening and the `daemon.json` token may read it; a Run token may not. `ted dev slow` prints it.

## CPU profile

`POST /diagnostics/profile` records the daemon’s main thread with `node:inspector`’s in-process `Session` (`Profiler.start`, `Profiler.stop`), which listens on no port. It takes `seconds` from 5 to 120, default 30; the sampling interval is fixed at 1 ms. The route sets neither `runToken` nor `fileToken`, so only a request signed with the app’s key can start one (ADR 0054). The `ted` command uses the `daemon.json` token or a Run token and so cannot. The app’s control is **Record a CPU profile** in Settings → Developer.

One profile runs at a time; a second request is refused with `409`. The profile is written to `TED_HOME/logs/profiles/daemon-<UTC date>-<time>.cpuprofile` with mode `0600`. `logs` and `profiles` must each be a plain folder, checked with `lstat`, and the file is opened with `O_EXCL` and `O_NOFOLLOW`. After writing, the oldest files matching that name are deleted until five remain; other files in the folder are left alone. The folder is inside `logs`, so it counts under Conversations and logs in Settings → Storage.

A `.cpuprofile` holds, for each function V8 sampled, its name, script URL (a file path), line and column, plus sample counts and times. It holds no argument values, no source text and no heap contents. The paths name TED’s install folder, which can include the user’s name.

Recording a profile is not new work, so `store.newWorkHold()` does not apply and the route works while the store is opening or a data screen is up. If the inspector is missing or refuses, the route answers `501` with the reason. The packaged app turns the `nodeCliInspect` fuse off, which stops `--inspect` and SIGUSR1; the in-process session still works there. This was checked by recording a profile with the installed 0.1.8 app’s binary run as Node (Electron 45.2.3, Node 24.22.2).

## Considered Options

- **A `TED_*` variable to turn on `--inspect`.** Rejected: it is the debug port again.
- **Thresholds as machine settings.** Rejected: nobody has needed to change them. Tests pass `slow` to `startDaemon`.
- **Let the `daemon.json` token start a profile so `ted` can.** Rejected: any process that can read `daemon.json` could then make the daemon write files and slow it down, and ADR 0054 keeps every such action for the app’s key.
- **Write the figures to the store.** Rejected: they describe this daemon process and a write on every slow moment would add work at the worst time.

## Consequences

- A new route that holds its response open for an event, a timeout or another process sets `waits: true`.
- A route’s path stays a regular expression whose captures are whole path segments, so `routePattern` can name it. The test in `slow-moments.test.ts` fails otherwise.
- Nothing else logs a request’s URL.
- The figures are lost when the daemon restarts.
