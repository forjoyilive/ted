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
      { id: 'go-to-inbox', label: 'Go to Inbox', keys: ['⌘⇧I', 'G I'] },
      { id: 'go-to-all-tasks', label: 'Go to All Tasks', keys: ['⌘⇧A', 'G A'] },
      { id: 'go-to-dashboard', label: 'Go to Dashboard', keys: ['⌘⇧D', 'G D'] },
      { id: 'go-to-board', label: 'Go to Board', keys: ['G B'] },
      { id: 'go-to-list', label: 'Go to List', keys: ['G L'] },
      { id: 'go-to-map', label: 'Go to Map', keys: ['G M'] },
      { id: 'go-to-agents', label: 'Go to Agents', keys: ['G P'] },
      { id: 'open-factory', label: 'Open Factory 1 to 9', keys: ['⌘1–⌘9'] },
      { id: 'back', label: 'Back', keys: ['⌘['] },
      { id: 'forward', label: 'Forward', keys: ['⌘]'] },
      {
        id: 'close',
        label: 'Close the open Task, leave Settings, or clear the selection',
        keys: ['Esc'],
      },
      { id: 'settings', label: 'Settings', keys: ['⌘,'] },
      { id: 'shortcuts', label: 'Keyboard shortcuts', keys: ['?', '⌘/'] },
      { id: 'quit', label: 'Quit Ted', keys: ['⌘Q'] },
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
      { id: 'context-menu', label: 'Open actions menu', keys: ['⇧F10', 'ContextMenu'] },
      {
        id: 'select',
        label: 'Select or deselect the Task under the pointer, or the focused one (List and Board)',
        keys: ['X'],
      },
    ],
  },
  {
    title: 'Answering',
    rows: [
      { id: 'reply', label: 'Reply', keys: ['R'] },
      { id: 'approve', label: 'Approve, then ↵ to confirm', keys: ['A'] },
      { id: 'request-changes', label: 'Request changes', keys: ['⇧R'] },
      { id: 'snooze-request', label: 'Snooze the selected request (Inbox)', keys: ['H'] },
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
      { id: 'details-tab-details', label: 'Show the Details tab', keys: ['⌥1'] },
      { id: 'details-tab-code', label: 'Show the Code tab', keys: ['⌥2'] },
      { id: 'details-tab-changes', label: 'Show the Changes tab', keys: ['⌥3'] },
      { id: 'details-tab-files', label: 'Show the Files tab', keys: ['⌥4'] },
      { id: 'details-tab-runs', label: 'Show the Runs tab', keys: ['⌥5'] },
      { id: 'details-tab-apps', label: 'Show the Apps tab', keys: ['⌥6'] },
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

const displayOnly = new Set(['context-menu', 'open-factory', 'send-message'])

const byId = new Map(sections.flatMap((s) => s.rows.map((r) => [r.id, r.keys] as const)))

export function keysFor(id: string): readonly string[] {
  return byId.get(id) ?? []
}

export function imageNavigationKey(event: {
  key: string
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
}): 'previous' | 'next' | undefined {
  if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return undefined
  if (event.key === 'ArrowLeft') return 'previous'
  if (event.key === 'ArrowRight') return 'next'
  return undefined
}

// H is bound twice. The first match wins, so the Inbox's binding goes first;
// its command falls back to the Board's column move.
const first = new Set(['snooze-request'])

export const keyBindings: readonly { id: string; shortcuts: readonly string[] }[] = [
  ...sections
    .flatMap((s) =>
      s.rows.filter((r) => !displayOnly.has(r.id)).map((r) => ({ id: r.id, shortcuts: r.keys })),
    )
    .sort((a, b) => Number(first.has(b.id)) - Number(first.has(a.id))),
  ...Array.from({ length: 9 }, (_, i) => ({ id: `factory:${i + 1}`, shortcuts: [`⌘${i + 1}`] })),
]

export function sidebarResizeKey(event: {
  key: string
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
}): number | 'min' | 'max' | undefined {
  if (event.metaKey || event.ctrlKey || event.altKey) return undefined
  if (event.key === 'Home') return 'min'
  if (event.key === 'End') return 'max'
  const step = event.shiftKey ? 40 : 10
  if (event.key === 'ArrowLeft') return -step
  if (event.key === 'ArrowRight') return step
  return undefined
}

export function contextMenuKey(event: {
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}): boolean {
  return (
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))
  )
}
