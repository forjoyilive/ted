# Ted’s copy of anti-slop

Source: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), commit `13909c9`, its `src/` folder. MIT licence, kept in `LICENSE` here; `vendor/eslint-stylistic/` carries its own.

This is Ted’s own copy. Change it when Ted’s rules need it; there is no plan to follow upstream. Changes since the copy:

- Formatted with Biome and its imports sorted (layout only).

`oxlint.config.ts` at the repo root registers `index.ts`. `effect/index.ts` is copied but not registered (ADR 0174). The `*.test.ts` files are upstream’s rule tests; Vitest doesn’t pick them up, and each runs with `node <file>`.
