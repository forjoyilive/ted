import type { ChatItem } from '@ted/protocol'

export type ToolItem = Extract<ChatItem, { kind: 'tool' }>

export type ToolKind = 'command' | 'read' | 'edit' | 'search' | 'other'

export interface ToolGroup {
  id: string
  items: ToolItem[]
  last: boolean
}

export interface ToolGroupSummary {
  calls: number
  text: string
  additions: number
  deletions: number
  failed: number
  stopped: number
  running: number
}

const kinds: Readonly<Record<string, ToolKind>> = {
  bash: 'command',
  bashoutput: 'command',
  shell: 'command',
  execute: 'command',
  read: 'read',
  notebookread: 'read',
  edit: 'edit',
  multiedit: 'edit',
  write: 'edit',
  notebookedit: 'edit',
  delete: 'edit',
  move: 'edit',
  grep: 'search',
  glob: 'search',
  search: 'search',
  websearch: 'search',
}

const words: Readonly<Record<ToolKind, [one: string, many: string]>> = {
  command: ['command', 'commands'],
  read: ['read', 'reads'],
  edit: ['edit', 'edits'],
  search: ['search', 'searches'],
  other: ['other', 'other'],
}

const order: readonly ToolKind[] = ['command', 'read', 'edit', 'search', 'other']

export function toolKind(tool: string): ToolKind {
  return kinds[tool.toLowerCase()] ?? 'other'
}

export function toolGroups<T>(
  rows: readonly ({ item: ChatItem } | { extra: T })[],
): ({ item: ChatItem } | { extra: T } | { group: ToolGroup })[] {
  const grouped: ({ item: ChatItem } | { extra: T } | { group: ToolGroup })[] = []
  let run: ToolItem[] = []
  const close = (last: boolean) => {
    const [first] = run
    if (first !== undefined && run.length === 1) grouped.push({ item: first })
    else if (first !== undefined) grouped.push({ group: { id: first.id, items: run, last } })
    run = []
  }
  for (const row of rows) {
    if ('item' in row && row.item.kind === 'tool') {
      run.push(row.item)
      continue
    }
    close(false)
    grouped.push(row)
  }
  close(true)
  return grouped
}

export function toolGroupSummary(items: readonly ToolItem[]): ToolGroupSummary {
  const counts = new Map<ToolKind, number>()
  const summary: ToolGroupSummary = {
    calls: items.length,
    text: '',
    additions: 0,
    deletions: 0,
    failed: 0,
    stopped: 0,
    running: 0,
  }
  for (const item of items) {
    const kind = toolKind(item.tool)
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
    for (const diff of item.diffs ?? []) {
      summary.additions += diff.additions
      summary.deletions += diff.deletions
    }
    if (item.status === 'failed') summary.failed++
    if (item.status === 'stopped') summary.stopped++
    if (item.status === 'running') summary.running++
  }
  summary.text = order
    .flatMap((kind) => {
      const count = counts.get(kind) ?? 0
      return count === 0 ? [] : [`${count} ${words[kind][count === 1 ? 0 : 1]}`]
    })
    .join(', ')
  return summary
}
