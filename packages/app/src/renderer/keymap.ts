export interface SheetRow {
  id: string
  label: string
  keys: readonly string[]
}

export interface SheetSection {
  title: 'Global' | 'Moving' | 'Answering' | 'Task actions' | 'Filter'
  rows: readonly SheetRow[]
}

const sections: readonly SheetSection[] = [
  {
    title: 'Global',
    rows: [
      { id: 'search', label: 'Search and commands', keys: ['⌘K'] },
      { id: 'new-task', label: 'New Task', keys: ['⌘N', 'C'] },
      { id: 'go-to-inbox', label: 'Go to Inbox', keys: ['G I'] },
      { id: 'go-to-all-tasks', label: 'Go to All Tasks', keys: ['G A'] },
      { id: 'go-to-board', label: 'Go to Board', keys: ['G B'] },
      { id: 'go-to-list', label: 'Go to List', keys: ['G L'] },
      { id: 'go-to-plans', label: 'Go to Plans', keys: ['G P'] },
      { id: 'open-factory', label: 'Open Factory 1 to 9', keys: ['⌘1–⌘9'] },
      { id: 'back', label: 'Back', keys: ['⌘['] },
      { id: 'forward', label: 'Forward', keys: ['⌘]'] },
      { id: 'close', label: 'Close the open Task, or leave Settings', keys: ['Esc'] },
      { id: 'settings', label: 'Settings', keys: ['⌘,'] },
      { id: 'shortcuts', label: 'Keyboard shortcuts', keys: ['?', '⌘/'] },
      { id: 'quit', label: 'Quit TED', keys: ['⌘Q'] },
    ],
  },
  {
    title: 'Moving',
    rows: [
      { id: 'next', label: 'Next', keys: ['J', '↓'] },
      { id: 'previous', label: 'Previous', keys: ['K', '↑'] },
      { id: 'column-left', label: 'Column to the left (Board)', keys: ['H', '←'] },
      { id: 'column-right', label: 'Column to the right (Board)', keys: ['L', '→'] },
      { id: 'open', label: 'Open', keys: ['↵'] },
    ],
  },
  {
    title: 'Answering',
    rows: [
      { id: 'reply', label: 'Reply', keys: ['R'] },
      { id: 'approve', label: 'Approve, then ↵ to confirm', keys: ['A'] },
      {
        id: 'accept-recommended',
        label: 'Accept all recommended, then ↵ to confirm',
        keys: ['⇧A'],
      },
      { id: 'request-changes', label: 'Request changes', keys: ['⇧R'] },
      {
        id: 'send-message',
        label: 'Send from a comment box or chat; ⇧↵ adds a new line',
        keys: ['↵'],
      },
      {
        id: 'send',
        label: 'Press a dialog’s main button; in a working Run’s chat, interrupt and send',
        keys: ['⌘↵'],
      },
    ],
  },
  {
    title: 'Task actions',
    rows: [
      { id: 'status', label: 'Start, Resume or Retry', keys: ['S'] },
      { id: 'set-priority', label: 'Priority', keys: ['P'] },
      { id: 'blocked-by', label: 'Blocked by', keys: ['B'] },
      { id: 'edit', label: 'Edit title and description', keys: ['E'] },
      { id: 'move-up', label: 'Move up in rank (Manual order)', keys: ['⌥↑'] },
      { id: 'move-down', label: 'Move down in rank (Manual order)', keys: ['⌥↓'] },
      { id: 'archive', label: 'Archive', keys: ['⌘⌫'] },
      { id: 'quick-open', label: 'Open a file', keys: ['⌘P'] },
      { id: 'shell', label: 'Open the Task’s shell', keys: ['⌃`'] },
    ],
  },
  {
    title: 'Filter',
    rows: [{ id: 'filter', label: 'Filter the Board or List', keys: ['/'] }],
  },
]

export function shortcutSheet(): readonly SheetSection[] {
  return sections
}

const displayOnly = new Set(['open-factory', 'send-message'])

const byId = new Map(sections.flatMap((s) => s.rows.map((r) => [r.id, r.keys] as const)))

export function keysFor(id: string): readonly string[] {
  return byId.get(id) ?? []
}

export const keyBindings: readonly { id: string; shortcuts: readonly string[] }[] = [
  ...sections.flatMap((s) =>
    s.rows.filter((r) => !displayOnly.has(r.id)).map((r) => ({ id: r.id, shortcuts: r.keys })),
  ),
  ...Array.from({ length: 9 }, (_, i) => ({ id: `factory:${i + 1}`, shortcuts: [`⌘${i + 1}`] })),
]
