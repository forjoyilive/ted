# Ted Dev demo

With dependencies installed, run `pnpm app --demo`. It builds the renderer and opens a separate Ted Dev instance with sample Factories, Tasks, Inbox requests, Runs, planning chats, Automations and settings problems.

The default demo home is `~/.ted-dev-demo`. It never seeds `~/.ted` (installed Ted) or `~/.ted-dev` (ordinary source development). Set `TED_HOME` to an empty isolated folder to override it. Within a Ted Task, use the Task’s `node_modules/.cache/ted-home` folder and remove the inherited Run identity for local trials, as the Factory notes describe.

`pnpm ted dev seed` builds the same data without opening a window. A completed seed is reused, including any changes you make while exploring. Quit the demo app and run `pnpm ted dev seed --reset` to rebuild it. Seeding and reuse refuse symlinks in the demo’s data; reset also refuses unrecognized nonempty folders. An interrupted or outdated seed requires explicit reset.

A seed leaves the demo’s stub Runs running, so the app opens with them in place, and marks the demo as quit, so a stub Run’s `ted` call can’t start the daemon again; the demo app’s Quit does the same. Opening the app clears the mark. To stop everything a demo home has running (its daemon, Run hosts, stub agents and Apps) while keeping its data, quit the demo app and run `pnpm ted dev stop`. A demo whose Runs were stopped needs `pnpm ted dev seed --reset` before the app opens it again.

The first seed prepares the data through real Ted workflows and can take a minute, especially alongside other tests. Later launches use the saved demo instead of preparing it again. Sequential, read-only UI checks can reuse that saved demo; tests that change its data need their own demo home so they do not affect another check. The seeder’s own tests use fresh homes to verify creation and explicit reset.

The demo uses local bare Git repos and the test stubs for agents, GitHub, the keyring and simulators. It needs no provider credentials or external services. Working examples wait for an explicit action; Automations are disabled after their sample history is collected. Quitting the demo preserves its detached stub Runs so reopening keeps the examples in place; `pnpm ted dev stop` ends them.

## Sample data in the release

The installed Ted offers the same data as **Try with sample data** on Set up Ted. The main process (`launchSampleData` in `packages/app/src/main.ts`, `openSampleData` in `packages/app/src/sample-data.ts`) seeds `~/.ted-sample` in a process of its own when it isn’t ready (`packages/daemon/src/dev/seed-sample.ts`, run on the Ted executable with `ELECTRON_RUN_AS_NODE=1`, with `--reset` for an incomplete seed), then opens a second Ted on that home. The person’s own Ted and its home are never touched, and the sample window shows a notice with **Set up Ted for real**, which quits it.

The sample home alone turns the sample on: in the release, `tedEnv` and `filterTedEnv` give the inputs in `sampleInputs` (`packages/protocol/src/sample.ts`) only when `TED_HOME` is exactly `identity().sampleFolder` in the home folder, with values computed from that home, never from the environment (see `docs/environment.md`). The stand-ins are the test stubs; packaging ships only the ones named in `sampleFixtures` in `packages/app/scripts/stage.ts`, and `packages/app/test/stage.test.ts` fails when the sample uses or imports one that isn’t listed. Each stand-in, and `node` for the sample projects’ Checks and Apps, runs through a shell launcher in the home’s `bin` folder on the runtime that prepared it (`prepareDemoBinaries`), because the release has no `node` of its own. The sample instance checks for no updates and never touches login items or notifications.

## New Inbox requests on demand

The seeded requests all exist before the app opens. To get a fresh one while the demo is open, run:

```sh
pnpm ted dev ask question      # or permission, or sign-off
```

It picks a demo Task whose Task Lead is waiting and has no open request, has that Task Lead post the request, waits until it reaches the Inbox and prints the Task. `--task <ID>` picks the Task. A sign-off goes only to a Task in Intake, Clarify or Design with its sign-off on. The command needs the demo app open and never starts a daemon itself.

After you answer, the Task Lead posts a note naming your answer and carries on: a question or permission request continues its Stage, and an approved sign-off moves the Task to the next Stage. When no Task can take a request, answer an open one or rebuild the demo with `pnpm ted dev seed --reset`.

## Pairing a phone with the demo

The demo keeps `TED_RELAY_URL`, so the “Ted Dev” phone app can pair with it:

1. Start a local relay, for example `pnpm relay` in ted-mobile.
2. Quit the demo app if it is open, then run `TED_RELAY_URL=http://127.0.0.1:8787 pnpm app --demo` (use your relay’s URL).
3. In the demo’s Settings, pair the “Ted Dev” phone app, and under Notifications turn on **Send a notification for: Inbox items**. The demo starts with it off.
4. To check a notification that arrives while you are away, run `sleep 150; pnpm ted dev ask question` and leave the Mac alone. Ted counts you away after 2 minutes without keyboard or mouse input, so the question reaches the phone as a notification. Answer it there; the Task Lead’s note appears in the Task thread.

## Screenshots

To capture the Board, Inbox, a Task thread and Settings in both themes:

```sh
pnpm --filter @ted/app exec node scripts/demo-screenshots.ts
```

Screenshots go in the demo home’s `screenshots` folder. Pass an output folder as the script’s first argument to choose another destination. The script uses a hidden Electron window and the shared seeder. Unlike `pnpm app --demo`, it downloads the Electron binary first when it’s missing, as `withApp` does. Its demo home follows `TED_HOME` too. When it finishes or fails, it stops everything the demo home has running, as `pnpm ted dev stop` does, so its next run seeds the demo again (`--reset`), replacing what the home held, including earlier screenshots in its `screenshots` folder. If the demo app is open on the same home, the script leaves its processes running and says so.
