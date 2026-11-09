# Search runs in the daemon; commands live in one registry in the app

KRI-156 adds the ⌘K box (spec 10.10). It does two jobs: it finds Tasks, Comments and Factories across every Factory, and it runs commands.

**Search is a daemon route.** `GET /search?q=…&factory=…` (`packages/daemon/src/search.ts`, `routes/search.ts`) reads the store and returns `SearchResults`: Tasks, Comments and Factories, each capped (`searchLimits`). The app only renders the result. Matching folds case and accents (`foldText` in `@ted/protocol/search`) and needs every word of the query somewhere in one field. A Task matches on its ID, its ID plus title, its current description, an earlier description version (the first is labelled Original request) or its latest brief. Comments match on title and body, from humans, agents and TED. Ranking: an exact ID first, then open Tasks before Done before archived, then the current Factory, then which field matched, then the most recently changed. It is a plain scan over the store, with no index; that is fast enough for one machine’s Tasks, and an index can come later without changing the route. Like every GET it is closed to Run tokens. Planning chats and Automations don’t exist yet; their tickets add result groups.

**Commands are one registry.** `packages/app/src/renderer/commands.ts` exports `globalCommands` and `taskCommands(task)`. Each `Command` has a label, a scope, the shortcuts the spec gives it (display text only, such as `⌘N` or `G I`), and either `run` or `choices` (Set Priority, Set Clarify depth, Open a Factory open a second list in the palette). The keyboard shortcut sheet (KRI-157) reads the same list, so a command and its shortcut are named in one place. Task commands reuse the Task actions menu: the status action comes from `statusAction`, and the commands that open a dialog (Archive, Delete, Edit, Follow up, Blocked by) send the same window events the menu listens to (`ted:archive-task`, `ted:delete-task`, `ted:edit-task`, `ted:follow-up-task`, `ted:pick-blocker`). Plan and New Automation are left out until those features exist.

**No results** offers Create Task “…”, which opens New Task with the typed text as its description, since the description is the required field.

**⌘F** opens a find bar over the panes. It walks the text in the panes and marks matches with the CSS Custom Highlight API, so the page’s DOM is never changed. The shell keeps its own find.

## Considered Options

- **Searching in the renderer from the Task list it already has.** Rejected: Comments, description versions and briefs are not loaded for every Task, and the app holds no business logic (ADR 0011).
- **SQLite full-text search.** Not now: the store is event-sourced through LiveStore, and an FTS table would need its own materializer. The plain scan is enough for v1.
