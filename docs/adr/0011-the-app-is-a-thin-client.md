# The Electron app is a thin client, and only its main process talks to the daemon

The app’s main process holds the app’s only `DaemonClient`. The renderer runs with `sandbox: true`, `contextIsolation: true` and `nodeIntegration: false`, so it has no `require`, no `process`, no filesystem and no token. It reaches the daemon only through the preload bridge, `window.ted`, which has two functions: `request(name, ...args)`, which main answers from a fixed list of allowed requests, and `onEvent(listener)`, which receives the daemon’s events (ADR 0012). The renderer couldn’t call the daemon directly anyway: the loopback guard refuses any request with an `Origin` header (ADR 0009).

The preload is a fixed, generic forwarder in plain JavaScript (`preload.cjs`, checked by `// @ts-check`), so it doesn’t grow as features arrive. A new feature adds a name to main’s list of allowed requests and a typed function to the renderer’s `ted.ts`. Electron loads sandboxed preloads with its own loader, which doesn’t strip TypeScript types, so the preload can’t be a `.ts` file without a build step.

Vite builds the renderer, which needs a bundler anyway for TSX and npm imports. This is the exception to ADR 0008: code that runs in Chromium either gets a build step (the renderer) or stays plain JavaScript (the preload). The main process and the daemon still run as `.ts` directly.

The app starts the daemon through the same `withDaemon` as the `ted` CLI, in `@ted/daemon/launch`. It spawns `process.execPath` with `ELECTRON_RUN_AS_NODE=1`: under the app that is the Electron binary running as Node, as the spec requires (§2.1), and under the CLI it is plain Node, which ignores the variable. If a daemon is already running, the app connects to it.

On Linux, a process spawned from Electron’s main process inherits every descriptor Chromium opened without close-on-exec: sockets, pipes, and cache and resource files. Node’s `spawn` has no option to close them, and macOS already closes them for us. So on Linux the launcher lists its inheritable descriptors, each with its device and inode, in `TED_INHERITED_FDS`. The daemon closes them as its first action, but only where the number still points at the same file, so it never closes a descriptor its own runtime reused. Without this, the daemon held Electron’s output sockets open after the app quit, and anything waiting on them waited for the daemon.

## Considered Options

- **A TypeScript preload built by Vite as a second target.** Typed, but adds a second build config for a file that never changes. Rejected.
- **A preload with one typed function per daemon call.** Grows with every feature, in plain JavaScript. Rejected in favour of the generic forwarder.
- **`sandbox: false` so the preload can load `.ts`.** Gives the preload full Node access. Rejected.

## Consequences

- The app starts the daemon with `--exit-when-idle` like `ted` does; the app’s open event stream keeps it alive. Since KRI-116, closing the window keeps the app running and quitting ends the daemon (ADR 0028).
- Running the app needs a `vite build` of the renderer first. `pnpm app` does both.
