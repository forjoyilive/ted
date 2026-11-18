# Simulators and emulators share one limit and build one at a time

On 2026-11-17 one Run started an Android emulator App and an iOS simulator App together. Each booted a device and ran a native build sized to all 12 cores; load reached 70 and the Mac swapped heavily (KRI-422). Nothing stopped it: `maxBootedSimulators` and `maxRunningEmulators` were counted apart (ADR 0085, ADR 0147), so setting both to 1 still allowed one of each, and the busy hold made a boot wait only when a device of the same kind was live (ADR 0166). A device App has no URL, so Ted marked it running as soon as its `run` command started, and the build after that ran outside any limit.

**One limit for both kinds.** `maxRunningDevices` (Settings → Limits, **Simulators and emulators at once**, 1 to 20, default 2) replaces the two limits. A running emulator takes room a simulator could use, and the shut-down choice, the permission ask and the busy hold count and list both kinds. A user who had set either old limit gets the two added together (an unset one counts as its old default, 3 or 2), capped at 20. The store works this out when it reads settings, so no event changes.

**One build at a time.** With `buildDeviceAppsOneAtATime` on (**Build one simulator or emulator App at a time**, the default), every simulator or emulator App start takes a build turn before it boots or launches, even on a device that is already live, because a rebuild costs the same. Another start waits in the first-come line, shows as Waiting with whose build it waits for, and `ted run-app` says so and waits. The turn ends when the App’s log has a line that is exactly `TED_APP_READY`, when the App ends or is stopped, when its device is shut down, or 15 minutes after it began. After a daemon restart, Ted restores the turn from device App instances that started, have no `builtAt` and haven’t ended, before reattaching to any App; a device App start waits for that to finish. The timeout still runs from each instance’s `startedAt`; if several builds remain, the newest holds the turn. Each instance saves its launch log offset as `readyFrom`, so a ready line from an earlier launch doesn’t end the restored turn. Off, starts go ahead together within the limit, as before.

**The pool is one module.** `createDevicePool` in `apps/device-pool.ts` holds the limit, the serial work queue, the line and the turn. `apps.ts` creates one and gives it to both `createSimulators` and `createEmulators`; each `createDeviceSlots` instance joins it as a member that lists its live devices and shuts one down by its slot ID. Everything else stays as ADR 0156 set it.

## Considered Options

- **Keep two limits and add only the build turn.** Rejected by the user: one number is easier to reason about.
- **Only a combined limit.** A limit of 2 is what an iOS and Android gate needs, and at 2 both could still build at once.
- **End the turn when the App stops.** Same as a limit of 1 for as long as the App runs.
- **End the turn after a fixed time.** Too long for a quick rebuild and too short for a cold Gradle build.
- **One `createDeviceSlots` driving both drivers.** Merges two records files and two public interfaces for nothing the pool doesn’t give.

## Consequences

- A Factory’s device App script should print `TED_APP_READY` once the app is built, installed and launched; the setup guide says so. Without it the next App waits until the first ends or 15 minutes pass.
- An agent that runs a device App’s script itself, outside `ted run-app`, is outside every rule here; Ted’s instructions to the Task Lead say to use `ted run-app` and start one at a time.
- A CPU share for App builds, like `TED_CHECK_CPUS` for Checks (ADR 0171), is `TED_APP_CPUS` (ADR 0193).
