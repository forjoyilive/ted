# Run starts store shared prompt text once

`v4.RunStarted` was the largest event kind: 35 MB over 1,281 events, about 27 KB each, because each held the whole prompt, and the state kept it in `runs.prompt`. Most of that text repeats. Every Task Lead prompt carries the preamble with its writing guidance (about 15 KB), a Stage file and the Factory notes. A sub-agent’s instructions were stored twice: in `v1.SubAgentRequested` and again inside its Run’s start event.

A new Run start is `v5.RunStarted`, which holds the prompt as `promptParts`, an ordered list whose items are one of:

- `{ text }`: text unique to this Run.
- `{ hash }`: a shared text in the `promptTexts` table, recorded by `v1.PromptTextSeen` (hash and text) in the same commit as the first Run start that uses it. The hash is SHA-256 of the text.
- `{ request }`: a sub-agent’s instructions, by the request’s ID. `v2.SubAgentRequested` stores the trimmed instructions in `subAgentInstructions` (keyed by the request ID, which is also the Run’s ID) as well as the request row, so they outlive the request row, which the Run start deletes. Rows go with the Task (`v1.TaskDeleted`, `v1.TaskReset`) or with `v1.SubAgentRequestDropped`.

`splitPrompt` in `packages/daemon/src/store/prompt-parts.ts` builds the parts from the prompt and the texts the caller says may be shared (at least 256 characters; `RunManager.start` adds the preamble, the sub-agent preamble and the writing guidance, and the Task Lead adds its Stage file and Factory notes), and keeps the prompt whole unless the parts join back to exactly the same text. `store.runPrompt(runId)` is the one way to read a Run’s full prompt, for `v1` to `v4` rows (`runs.prompt`) and `v5` rows alike. `Run` no longer carries `prompt` in `run-updated` events, lists or store reads; only `GET /runs/:id` fills it.

Shared texts are kept for good: there are few of them, one per version of each fixed text. Old `v4.RunStarted` events are not rewritten.

Measured with this repo’s prompts: a Task Lead start event went from 25.2 KB to 3.6 KB and its state row from 24.8 KB to 3.3 KB; a sub-agent start event went from 6.9 KB to 0.4 KB. The shared texts cost about 26 KB once.

## Considered Options

- **Split every prompt at its top-level headings and store each large section by hash.** Needs no hints from callers, but stores text unique to one Run in the shared table, where nothing deletes it, and can’t match a sub-agent’s instructions to its request.
- **Refer to `stageFileTexts` for the Stage file.** The prompt’s Stage text adds the Gate and Cleanup lines and trims the file, so it rarely equals a stored Stage file text.
- **Keep the texts in files outside the event log.** A rebuild must give the same state, and backups hold only the store.

## Consequences

- Anything new that reads a Run’s prompt calls `store.runPrompt`, never `runs.prompt`.
- A new fixed text that many Runs share is passed as a shared text to `RunManager.start`, or added to `fixedPromptTexts` in `workflow/workflow.ts`.
- The Stage file text can be in the log twice per version, once in `v1.StageFileTextSeen` and once in `v1.PromptTextSeen`.
