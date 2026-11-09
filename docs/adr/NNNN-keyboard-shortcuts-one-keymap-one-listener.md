# Keyboard shortcuts: one keymap, one listener

KRI-157 wires every shortcut in spec 10.11 and adds the shortcut sheet (`?` or ⌘/).

**One keymap.** `packages/app/src/renderer/keymap.ts` lists each shortcut once: its section on the sheet, its label and its keys as display text (`⌘N`, `G I`, `⇧A`, `⌥↑`). The command registry (ADR 0069) reads its keys from there with `keysFor(id)`, the Task actions menu shows the same hints, and the sheet is drawn from the same list. `shortcuts.ts` turns the display text into key matches: `⌘` is Command on macOS and Control elsewhere, `⌃` is Control only, a letter needs Shift only when the text says `⇧`, and `G` then a letter is a sequence that waits 1.5 seconds for its second key.

**One listener.** `App.tsx` has a single `keydown` listener. It skips a key that a field or menu already handled (`defaultPrevented`), any key without ⌘ or ⌃ while the focus is in a text field, every non-⌘ key while a menu is open, and everything except ⌘K and ⌘↵ while a dialog is open. In Settings only navigation, ⌘K, ⌘↵ and the sheet work. It finds the command whose keys match and runs it. Commands that only make sense from the keyboard (moving, Esc, `/`, ⌘↵, Approve and the rest) are in `keyCommands`, and they act through `KeyActions` that `App.tsx` provides. Commands that open a choice (Priority) open the ⌘K box on that choice.

**Which Task.** Task shortcuts act on the open Task. With no Task open they act on the card or row that has the focus. Edit, Archive and Delete open their dialog over the Board or List. Blocked by opens the Task first, because its picker lives in the Task’s details.

**Moving is focus.** A Board card, List row or Inbox row carries `data-nav-item`, and a Board column `data-nav-column`. J/K and ↓/↑ move the focus within the column or list; H/L and ←/→ move it to the nearest card in the next column with cards. Enter opens what has the focus. ⌥↑/⌥↓ move the focused Task past one neighbour of the same Priority, only inside a container marked `data-rank-order` (the Board, and the List with Manual sort).

**Confirming.** `A` and ⇧`A` mark the first enabled button with `arm="approve"` or `arm="accept-recommended"` in the open panes. The button shows “↵ to confirm”; Enter presses it, and Esc or any other key or click cancels. ⌘↵ presses the last enabled `variant="primary"` button in the open dialog, never a danger one, so it can’t Delete.

`⌃\`` (open the Task’s shell) is on the sheet but does nothing until the embedded shell exists. ⌘Q stays with the app menu.
