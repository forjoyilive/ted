# The Board reads its columns from the daemon

The Board (KRI-97) shows a column per Stage of the Factory’s resolved Workflow. The app can’t resolve a Workflow itself (ADR 0011), so the daemon answers `GET /factories/:id/board` with `FactoryBoard`: Backlog, every Stage in the Workflow’s `order`, then Done, each with `enabled` and `gate`. `Tasks.board` resolves the Workflow without fetching, like `task-defaults`, and `boardStages` in `workflow/resolve.ts` builds the list. The route is closed to Run tokens.

**Columns.** `boardColumns` in `packages/app/src/renderer/board.ts` shows the enabled Stages. A turned-off Stage keeps a dashed “Turned off” column while it holds Tasks; a Stage the Workflow no longer lists at all, but which still holds Tasks, gets one too, in its built-in place. The renderer asks again when the Factory changes or when its Tasks start or stop occupying a Stage, so a column appears as soon as a Task needs it.

**Order and the start column.** Cards are in Manual order (Priority, then rank; ADR 0040), except that the first Stage after Backlog lists its Queued Tasks first. A drag in that column stays inside the card’s own part: Queued cards move among Queued cards, and a card being started lands among them. Its neighbours are then sent to `POST /tasks/:id/move` as the List does. The drop slot’s “Queued · 4th” comes from the place of the Queued neighbour in `GET /slots`, or, with none, from how many queued entries share or outrank its Priority.

**Drops between columns.** Only Backlog → the start column (`/start`, then `/move`) and a Queued Task that never had a Run back to Backlog (`/backlog`, then `/move`). Done takes no drops; its compact cards are KRI-134.

**Filter.** The Board uses the List’s filter menu without Stage and Archived. Its filters live in the app for the session, per Factory, and aren’t saved as a machine setting.

## Considered Options

- **Send the Workflow’s stages on every Factory.** `GET /factories` would have to resolve every Factory’s Workflow on each read, and the list changes far less often than the Board is opened.
- **Interleave Queued cards with the others by Priority.** Spec §10.8 puts Queued cards at the top of Intake, and the Figma frame shows them there. Mixing them would also make a drag’s neighbours disagree with what the human sees.
- **Save Board filters in `listViews`.** That setting is shaped for the List (sort, group, columns); a Board entry would carry fields it ignores.

## Consequences

- A Workflow edit shows on the Board the next time it asks: on opening the Board or when a Task moves into a Stage it has no column for.
- Board filters reset when the app restarts.
