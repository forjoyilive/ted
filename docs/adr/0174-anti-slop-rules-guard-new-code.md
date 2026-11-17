# The anti-slop rules guard new code

Status: accepted (TED-460)

Agents write most of Ted’s code, and some patterns keep coming back: a `typeof` check where input should have been parsed once at its boundary, an `as` cast with no stated reason, `unknown` passed through parameters and returns, `Record<string, …>` used as a loose bag, and `vi.mock` instead of a real seam. Biome doesn’t catch these. The [anti-slop](https://github.com/dmmulroy/anti-slop) rules do, as a plugin for Oxlint.

`pnpm lint`, which the Lint Check runs, now runs Biome, then Oxlint with those rules, then a search for disable comments. The rules guard new code. Old code keeps the violations it has today (3,688 when this was written), recorded per file and rule, and is not rewritten here; TED-461, TED-462 and TED-463 lower the counts.

## What runs

- `oxlint.config.ts` turns Oxlint’s built-in rule categories off and runs only `oxc/no-accumulating-spread` and 16 anti-slop rules, at error. It covers every `.ts` and `.tsx` file Git doesn’t ignore: `packages/`, `scripts/` and the root config files. JavaScript files and the plugin’s own folder are left out.
- **Off for good:** `require-readable-spacing`, because Biome alone decides layout, and `no-shape-in-symbol-names`, because it misfires on real shapes such as a Factory icon’s.
- **Off for tests:** `require-safety-comment-for-type-assertion` doesn’t apply under any `test/` folder or to `*.test.ts(x)` files. A cast in a test builds a fixture; it doesn’t claim anything about production input.
- **Effect rules off:** the five `anti-slop-effect` rules reported 103 problems: 98 from `prefer-effect-match` and 5 from `no-service-constructor-imports`. Ted uses Effect only where LiveStore needs it (`packages/daemon/src/store/index.ts`). `prefer-effect-match` asks for Effect’s `Match` in place of every chained ternary over literals, which would pull Effect into code that doesn’t use it. `no-service-constructor-imports` flagged test helpers such as `makeOriginRepo` only because they start with `make`. Their plugin entry is copied but not registered.

## The counts file

`oxlint-suppressions.json` holds a count per file and rule, written by `oxlint --suppress-all`. Oxlint doesn’t document this feature, so it was tried before Ted relied on it (Oxlint 1.94.0):

- A new file with a violation fails.
- One more violation in a recorded file fails.
- Fewer violations than recorded also fails, with “There are suppressions that do not occur anymore”. `oxlint --prune-suppressions` lowers the counts to what is left and never raises one.
- The file as generated passes.

So the counts go down on their own and up only on purpose. A Task that fixes violations runs `pnpm exec oxlint --prune-suppressions` and commits the smaller file. `--suppress-all` with no path records every violation in the repo, new ones included, and Oxlint’s own error message suggests it, so AGENTS.md says not to. With a file named, `oxlint --suppress-all <file>` changes only that file’s counts; until the parse module (TED-461) exists, that is how new code that must read untyped data is recorded. A count that grows shows in the pull request’s diff. Biome leaves the file alone, so regenerating it never fights the formatter.

The fallback, had the feature not behaved this way, was an `overrides` entry turning each rule off for the files that violate it today. It wasn’t needed.

## No disable comments

A violation is fixed, or its file pattern is exempted in `oxlint.config.ts` with a reason. Oxlint can’t refuse disable comments: `reportUnusedDisableDirectives` reports only those that disable nothing, and a lint rule that reports disable comments is itself switched off by a file-wide `/* oxlint-disable */`. So `pnpm lint` ends with a `git grep` over `.ts` and `.tsx` files, tracked and untracked, for the text `oxlint-disable`, `oxlint-enable`, `eslint-disable` or `eslint-enable` anywhere on a line, and fails when it finds one. It doesn’t look for a comment marker first, because Oxlint honours a directive on its own line inside a multi-line block comment. A string that contains that text fails too; none does today. `respectEslintDisableDirectives: false` also stops Oxlint from honouring the `eslint-` forms.

## The plugin is Ted’s own copy

Anti-slop has no npm package; it is meant to be copied. Upstream’s `src/` at commit `13909c9` is in `tools/oxlint/anti-slop/` under its MIT licence (`UPSTREAM.md` there). Ted may edit it and doesn’t plan to follow upstream. Biome formats it but doesn’t lint it, and `pnpm typecheck` doesn’t include it. `oxlint` and `@oxlint/plugins` are pinned to the same exact version. The Task measured 1.78.0; 1.94.0, the newest when this was written, runs upstream’s 24 rule test files without a failure.

The plugin runs on the user’s machine and inside Checks. Its source imports only `@oxlint/plugins` and its own files. It reads the syntax tree Oxlint hands it and nothing else: no file system, process, network or dynamic code.

## Considered Options

- **Rewrite old code first.** Rejected: thousands of violations across most files. That work is split into its own Tasks.
- **Per-file `overrides` instead of the counts file.** Rejected: a file listed for a rule could gain any number of new violations of it.
- **An npm package or a Git dependency.** Rejected: there is no package, and a dependency that tracks upstream would change Ted’s rules without a review.
