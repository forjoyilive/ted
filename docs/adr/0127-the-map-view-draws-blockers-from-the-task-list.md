# The Map View draws blockers from the Task list

A Task lists its own blockers in Task details, and nothing showed a chain of several Tasks. After a Split it proposal or a plan made five Tasks with blockers, the human opened each one to learn the order (KRI-350).

- **Map is a third Factory View.** Board, List and Map sit under a “Tasks” row in the Factory’s sub-menu. The row opens whichever of the three was last used in that Factory, Board the first time (`open-tasks` and `lastTaskViews` in `navigation.ts`). `G M` goes to Map.
- **What is drawn comes from one function.** `blockerMap(tasks, factoryId)` in `packages/app/src/renderer/blocker-map.ts` takes the Task list the app already holds and returns the cards with a column and a row, the links, and the Factory’s open Tasks with no links. A link is drawn for each blocker of a Task of this Factory that is not Done and not archived; an archived or deleted blocker is left out. A Done blocker is drawn muted. A blocker from another Factory is a card with its Factory’s name, and its own blockers are not followed.
- **Layout.** A Task sits one column to the right of the last Task it waits for. A blocker that waits for nothing sits in the column just before the first Task it blocks. Chains that share no Task stack top to bottom. TED places the cards; the human can’t move them. Every card is the same height: one title line, with the full title as its tooltip, and at most two rows of status chips.
- **Removing.** Hovering a line, or focusing its ✕ button, turns the line red and shows the ✕; one click calls `unblockTask`, with no confirmation. A message at the bottom offers Undo for six seconds.
- **Adding.** The human drags from the dot on a card’s right edge, the Task that must merge first, to the Task that should wait, and the app calls `blockTask`. Tasks with no links are in a side panel, closed by default, so they can be dragged from and onto. While dragging, `linkRefusal` gives the text for a Task that can’t take the link; the daemon still decides, and its message is shown if it refuses.

## Considered Options

- **A graph library** (dagre, React Flow). It brings its own styling, which the colour-token rule would have to be worked around, and a larger renderer bundle, for graphs of a handful of Tasks.
- **The browser’s drag and drop**, as the Board uses. It can’t draw a line that follows the pointer, so the drag uses pointer events.
- **Always drawing Tasks with no blockers.** In a busy Factory they bury the chains.
- **A daemon route that returns the graph.** The app already has every Task’s `blockedBy`, so a route would only repeat it.

## Consequences

- No daemon or protocol change. The Map updates from the same `task-updated` events as the Board.
- A Task of this Factory that blocks only Tasks of another Factory is not on this Factory’s Map; it is on the other one’s.
- When a link skips a column, its line can pass behind a card in between. The arrowhead and the hover colour show where it goes.
- Adding a blocker needs a pointer. From the keyboard, the human adds one with `B` on the Task, as before; the ✕ buttons are reachable with Tab.
