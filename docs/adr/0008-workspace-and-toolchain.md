# One pnpm workspace, TypeScript run directly by Node, Vitest and Biome

Ted’s code is one pnpm workspace with a package per part: `packages/protocol` (paths, the `daemon.json` format, API types and the HTTP client), `packages/daemon` and `packages/cli`, with the Electron app to follow as `packages/app`. Node 24 runs the `.ts` files directly through type stripping, so there is no build step in development; `tsc --noEmit` only typechecks. Tests use Vitest and lint and formatting use Biome. We chose this to keep the walking skeleton thin: one runtime, one lint tool, no bundler until packaging needs one.

Rules for building Ted:

- Write only erasable TypeScript (no `enum`, `namespace` or parameter properties); `erasableSyntaxOnly` enforces it. Relative imports name the `.ts` file.
- Everything Ted keeps goes under the folder `TED_HOME` names, which defaults to `~/.ted`. Tests always set `TED_HOME` to a temp folder and never touch the real one.
- CI runs typecheck, lint and tests on Ubuntu.

## Considered Options

- **ESLint with typescript-eslint.** Type-aware rules such as no-floating-promises, but more setup and slower. Rejected for now.
- **A build step (`tsc` or a bundler) from the start.** Needed later to ship inside Electron, not to develop. Deferred to packaging.
