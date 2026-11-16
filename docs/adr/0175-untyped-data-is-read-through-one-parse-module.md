# Untyped data is read through one parse module

Status: accepted (TED-461)

The anti-slop rules (ADR 0174-anti-slop-rules-guard-new-code) reject `unknown` parameters, returns and type aliases, `typeof` checks and `Record<string, unknown>`. Those are exactly what TED’s hand-written parsers use, so until now new code that read untyped data could pass `pnpm lint` only by being recorded in `oxlint-suppressions.json`.

TED now has one module for it, `packages/protocol/src/parse.ts`, imported as `@ted/protocol/parse`. It imports no Node modules, so the daemon, the CLI, the app’s main process and the renderer can all use it.

## What it holds

- **Types.** `Json`, `JsonArray` and `JsonObject` (`{ readonly [key: string]: Json | undefined }`) replace `Record<string, unknown>`. `Untyped` names a value nothing has read yet. It is the parameter type of a boundary parser: `jsonRoute` in the daemon and `readParsedFile` in the CLI type parsers as `(value: unknown) => T`, and a parser taking `Json` would not fit them without changing both.
- **Checks that never throw:** `isString`, `isNumber` (finite), `isInteger` (safe integer), `isBoolean`, `isObject` (not null, not a list), `isArray`, `isOneOf` and `parseJson` (`undefined` for text that isn’t JSON). These serve readers that skip or collect bad values: Provider CLI output (`agents/codex.ts`), Asana, Linear and GitHub responses (`asana/tree.ts`), YAML nodes (`workflow/check.ts`, which collects errors), JSON stored in the database and messages in the app.
- **Readers that throw:** `reader(fail)` returns `object`, `string`, `number`, `integer`, `boolean`, `list`, `oneOf` and `optional`. Each default message names the field (`<field> must be text`), and each takes a message of its own so a parser keeps its wording. `fail` decides the error: a request parser passes one that throws `RequestValidationError(400, …)`; the default throws `ParseError`, which carries the field name.

`packages/protocol/src/failure-parsers.ts` is the first parser moved onto it and the pattern for the rest. It accepts, rejects and reports exactly as before and has no entry left in the counts file. The other parsers keep their recorded violations until a Task moves them.

## What it is exempt from

`oxlint.config.ts` turns these rules off for `packages/protocol/src/parse.ts` only:

- `no-unknown-parameters`, `no-runtime-typeof` and `no-unknown-returns`: looking at a value of unknown type is the module’s whole job.
- `no-unsafe-dictionary-type`: `JsonObject` is the index type that replaces the loose ones.
- `no-unknown-type-aliases`: `Untyped` is an alias for `unknown`.

`require-safety-comment-for-type-assertion` still applies; the module needs no cast.

`no-unknown-parameters` looks only for the `unknown` keyword, so `Untyped` passes it anywhere. That is on purpose for boundary parsers, and AGENTS.md says `Untyped` is only for a function that reads its input through this module. A reviewer checks for that.

## Considered Options

- **A schema library such as Zod or Valibot.** It would add a runtime dependency to `@ted/protocol`, which the renderer bundles, and replace hand-written parsers whose exact error messages the CLI and app show. TED keeps its parsers hand-written, each with an explicit return type and an all-fields test; the module only removes the repeated `typeof` and cast code inside them.
- **Parsers taking `Json`.** Cleaner types, but every `jsonRoute` and `readParsedFile` caller would change, which is daemon and CLI work outside this Task. It can follow once more parsers have moved.
- **Exempting each parser file.** The rules would then guard nothing in the files where untyped data comes in.
