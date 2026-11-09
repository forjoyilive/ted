# Banners are raised and cleared through one daemon module and kept in the store

Any part of the daemon that detects a machine or Factory problem raises it through `Banners` in `packages/daemon/src/banners.ts`: `raise({ problem, factoryId?, subject?, severity, text, action? })` and `clear({ problem, factoryId?, subject? })`. The banner’s id is `problem:factoryId|app[:subject]`, so raising the same problem again updates it in place and keeps when it was first raised. Clearing a problem that isn’t raised does nothing, so an owner can call `raise` or `clear` every time it checks, with no state of its own.

Banners live in the store (`v1.BannerRaised`, `v1.BannerDismissed`, `v1.BannerCleared`), so they survive a daemon restart and every client sees the same list. `TedStore` emits `banner-raised` when a problem starts, `banner-updated` when its text changes or it is dismissed, and `banner-cleared` when it clears. Notifications (spec 3.8) listen for `banner-raised` with severity `stops-work`; that event fires once per problem start and never on clear.

An action either opens a place in the app (`opens`: app Settings, a Factory’s settings, a Task), or runs in the daemon: the client calls `POST /banners/:id/action` and the daemon runs the handler registered with `banners.onAction(problem, handler)`. A warning’s × calls `POST /banners/:id/dismiss`, which hides it for 24 hours; the daemon refuses it for a stops-work banner. Clearing a problem drops its dismissal, so it shows again if it comes back. All three banner routes are closed to Runs.

The app reads `GET /banners` and the three events, puts banners with no Factory above the middle pane and a Factory’s banners under its page header, and works out ordering, folding beyond two, the sidebar ⚠ and the Settings dot from that list. `ted status` and `ted doctor` print every banner, dismissed or not.

## Considered Options

- **Banners in daemon memory, recomputed by each owner.** A restart would lose a clone failure until the next attempt, and live updates would bypass `TedStore`, against ADR 0012.
- **A new DaemonEvent kind per problem.** Every later ticket would touch the protocol, app main and renderer. One generic banner shape keeps each new problem to a `raise` and a `clear` in the module that detects it.
- **A daemon-run action for every banner.** Most actions only open a Settings section; sending those through the daemon would add a round trip and a handler for nothing.

## Consequences

- A ticket that adds a problem picks a `problem` name, calls `raise` where it detects it and `clear` where it resolves, and registers an `onAction` handler if its button does work in the daemon. Nothing in the app changes unless the action opens a new kind of place.
- A stale banner stays until its owner checks again; an owner whose problem can disappear while the daemon is down must check at start.
