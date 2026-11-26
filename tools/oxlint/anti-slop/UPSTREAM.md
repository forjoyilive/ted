# Ted’s copy of anti-slop

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), commit `13909c9`, its `src/` folder. MIT licence, kept in `LICENSE` here; `vendor/eslint-stylistic/` carries its own.

This is Ted’s own copy. Change it when Ted’s rules need it; there is no plan to follow upstream. Changes since the copy:

- Formatted with Biome and its imports sorted (layout only).
- Removed upstream’s `effect/` plugin, which Ted never registered.
- The rule tests run under Vitest: `shared/rule-tester.ts` hands Vitest’s `describe` and `it` to `RuleTester`.
- `no-module-mocking` also catches `vi` reached through a `vitest` namespace import or `globalThis`, mocking methods taken off `vi` or `jest`, and `importMock`, `requireMock`, `createMockFromModule` and `setMock`.

`oxlint.config.ts` at the repo root registers `index.ts`. The `rules/*.test.ts` files are the rule tests; `testFilePatterns` in `scripts/test-files.ts` includes them, so Vitest runs them with the rest of the suite.
