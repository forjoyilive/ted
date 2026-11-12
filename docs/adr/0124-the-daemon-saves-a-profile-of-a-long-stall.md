# The daemon saves a CPU profile of a long stall by itself

This amends ADR 0114-the-daemon-records-its-own-slow-moments.

ADR 0114 counts event-loop stalls and lets the app record a CPU profile from Settings → Developer. On one machine the release daemon was blocked for 60 to 150 seconds more than ten times in a day; the app then says it can’t reach the daemon. The stall lines say how long, not what ran, and a profile has to be started by hand before a stall nobody can predict. Reading the code and replaying a copy of the store didn’t find the cause.

- **A watchdog thread.** The daemon process (`main.ts`, not a daemon started in a test) starts one worker thread from `watchStalls` in `cpu-profile.ts`. The daemon’s thread sends it a beat every 250 ms.
- **It profiles only a stall.** When no beat has come for 2 seconds, the worker connects its `node:inspector` session to the daemon’s thread (`connectToMainThread`) and starts V8’s CPU profiler there at one sample per 10 ms. V8 handles that request as an interrupt, so it starts while the thread is still blocked. When the beats come back the worker stops the profiler and posts the profile with the time between the last beat before and the first beat after.
- **Saved at 5 seconds.** A stall of 5 seconds or more is written to `TED_HOME/logs/profiles/stall-<time>.cpuprofile` (mode `0600`, plain folders only, newest five kept, separately from the app’s `daemon-` profiles), and one line with its length and the file goes to the daemon log. A shorter one is thrown away. A worker tick that is itself 2 seconds late means the machine slept, and that profile is thrown away.
- **The app’s profile comes first.** `record` tells the worker to pause, because V8 has one sampling rate.
- Nothing new can start or read a profile: there is no route, no setting and no inspector port. A profile holds function names, file paths and line numbers of TED’s own code and its libraries, and no arguments or data.

## Considered Options

- **Keep the profiler running and save the last minute on a stall.** Built first and measured: with the profiler on, a CPU-bound loop took 14.7 seconds against 3.7, so it can’t stay on.
- **Ask the human to record a profile when it feels slow.** A stall of this kind is over, or has the app unable to reach the daemon, before anyone can click.
- **Log a stack trace when a stall ends.** By then the blocking code has returned.

## Consequences

- A long stall leaves a file that names what blocked, missing its first 2 seconds. Open it in Chrome’s DevTools (Performance → Load profile) or any `.cpuprofile` viewer.
- A healthy daemon pays for one idle thread and four messages a second. While a stall is being profiled the blocked work runs slower.
- A stall spent entirely in native code (one long SQLite call, say) is profiled only from the moment JavaScript next runs.
