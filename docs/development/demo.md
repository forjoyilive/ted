# Ted Dev demo

With dependencies installed, run `pnpm app --demo`. It builds the renderer and opens a separate Ted Dev instance with sample Factories, Tasks, Inbox requests, Runs, planning chats, Automations and settings problems.

The default demo home is `~/.ted-dev-demo`. It never seeds `~/.ted` (installed Ted) or `~/.ted-dev` (ordinary source development). Set `TED_HOME` to an empty isolated folder to override it. Within a Ted Task, use the Task’s `node_modules/.cache/ted-home` folder and remove the inherited Run identity for local trials, as the Factory notes describe.

`pnpm ted dev seed` builds the same data without opening a window. A completed seed is reused, including any changes you make while exploring. Quit the demo app and run `pnpm ted dev seed --reset` to rebuild it. Seeding and reuse refuse symlinks in the demo’s data; reset also refuses unrecognized nonempty folders. An interrupted or outdated seed requires explicit reset.

The first seed prepares the data through real Ted workflows and can take a minute, especially alongside other tests. Later launches and screenshot runs use the saved demo instead of preparing it again. Sequential, read-only UI checks can reuse that saved demo; tests that change its data need their own demo home so they do not affect another check. The seeder’s own tests use fresh homes to verify creation and explicit reset.

The demo uses local bare Git repos and the test stubs for agents, GitHub, the keyring and simulators. It needs no provider credentials or external services. Working examples wait for an explicit action; Automations are disabled after their sample history is collected. Quitting the demo preserves its detached stub Runs so reopening keeps the examples in place.

To capture the Board, Inbox, a Task thread and Settings in both themes:

```sh
pnpm --filter @ted/app exec node scripts/demo-screenshots.ts
```

Screenshots go in the demo home’s `screenshots` folder. Pass an output folder as the script’s first argument to choose another destination. The script uses a hidden Electron window and the shared seeder. Unlike `pnpm app --demo`, it downloads the Electron binary first when it’s missing, as `withApp` does. Its demo home follows `TED_HOME` too.
