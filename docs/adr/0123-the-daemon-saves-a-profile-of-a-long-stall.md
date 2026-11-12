# The daemon saves a CPU profile of a long stall by itself

This amends ADR 0114-the-daemon-records-its-own-slow-moments.

ADR 0114 counts event-loop stalls and lets the app record a CPU profile from Settings → Developer. On one machine the release daemon was blocked for 60 to 150 seconds more than ten times in a day; the app then says it can’t reach the daemon. The stall lines say how long, not what ran, and a profile has to be started by hand before a stall nobody can predict. Reading the code and replaying a copy of the store didn’t find the cause.

- **A rolling profile.** The daemon process (`main.ts`, not a daemon started in a test) keeps V8’s CPU profiler running at one sample per 10 ms, through the same in-process `node:inspector` session as ADR 0114, and starts it afresh every minute, throwing the old samples away.
- **Saved on a stall.** `watchStalls` in `cpu-profile.ts` runs a one-second timer. When the timer fires 5 seconds or more late, the profile is stopped and written to `TED_HOME/logs/profiles/stall-<time>.cpuprofile` (mode `0600`, plain folders only, newest five kept, separately from the app’s `daemon-` profiles), and one line with the stall’s length and the file goes to the daemon log. The sampler runs on V8’s own thread, so the profile covers the blocked time. A timer that is 10 minutes or more late is a machine that slept, and its profile is thrown away.
- **The app’s profile comes first.** `record` stops the rolling profile, records at its own 1 ms rate and starts the rolling one again, because V8 has one sampling rate.
- Nothing new can start or read a profile: there is no route, no setting and no inspector port. A profile holds function names, file paths and line numbers of TED’s own code and its libraries, and no arguments or data.

## Considered Options

- **Ask the human to record a profile when it feels slow.** A stall of this kind is over, or has the app unable to reach the daemon, before anyone can click.
- **Log a stack trace when a stall ends.** By then the blocking code has returned.
- **A setting to turn it on.** The cost is a sample every 10 ms and at most five files; a setting would be off on the machine that needs it.

## Consequences

- A long stall leaves a file that names what blocked. Open it in Chrome’s DevTools (Performance → Load profile) or any `.cpuprofile` viewer.
- The daemon runs with the profiler on all the time, at a hundredth of the app profile’s rate.
