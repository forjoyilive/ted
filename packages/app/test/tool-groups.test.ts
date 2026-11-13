import type { ChatItem } from '@ted/protocol'
import { expect, test } from 'vitest'
import {
  type ToolItem,
  toolGroupSummary,
  toolGroups,
  toolKind,
} from '../src/renderer/tool-groups.ts'

const tool = (id: string, name = 'Bash', extra: Partial<ToolItem> = {}): ToolItem => ({
  kind: 'tool',
  id,
  tool: name,
  title: id,
  status: 'done',
  ...extra,
})
const agent = (id: string): ChatItem => ({ kind: 'agent', id, text: id })
const shape = (rows: ReturnType<typeof toolGroups<{ id: string }>>) =>
  rows.map((row) =>
    'group' in row
      ? `group ${row.group.items.map((item) => item.id).join('+')}${row.group.last ? ' last' : ''}`
      : 'item' in row
        ? row.item.id
        : `extra ${row.extra.id}`,
  )

test('runs of two or more tool calls group; a single call, messages and extras stay rows', () => {
  const rows = [
    { item: agent('a1') },
    { item: tool('t1') },
    { item: tool('t2') },
    { item: agent('a2') },
    { item: tool('t3') },
    { extra: { id: 'c1' } },
    { item: tool('t4') },
    { item: tool('t5') },
    { item: tool('t6') },
  ]
  expect(shape(toolGroups(rows))).toEqual([
    'a1',
    'group t1+t2',
    'a2',
    't3',
    'extra c1',
    'group t4+t5+t6 last',
  ])
  expect(
    shape(toolGroups([{ item: tool('t1') }, { item: tool('t2') }, { item: agent('a1') }])),
  ).toEqual(['group t1+t2', 'a1'])
  expect(shape(toolGroups([]))).toEqual([])
})

test('tool names from every agent map to a kind', () => {
  const kinds = {
    command: ['Bash', 'Shell', 'execute'],
    read: ['Read', 'read'],
    edit: ['Edit', 'Write', 'MultiEdit', 'delete'],
    search: ['Grep', 'Glob', 'Search', 'WebSearch'],
    other: ['TodoWrite', 'Task', 'Tool', 'fetch'],
  }
  for (const [kind, names] of Object.entries(kinds)) {
    expect(names.map(toolKind)).toEqual(names.map(() => kind))
  }
})

test('the summary counts kinds in a fixed order, adds up edits and counts unfinished calls', () => {
  const diff = (additions: number, deletions: number) => ({
    path: 'a.ts',
    additions,
    deletions,
    lines: [],
  })
  expect(
    toolGroupSummary([
      tool('t1', 'TodoWrite'),
      tool('t2', 'Edit', { diffs: [diff(3, 1), diff(2, 0)] }),
      tool('t3', 'Bash', { status: 'failed' }),
      tool('t4', 'Read'),
      tool('t5', 'Bash'),
      tool('t6', 'Write', { diffs: [diff(10, 0)] }),
      tool('t7', 'Shell', { status: 'stopped' }),
      tool('t8', 'Grep', { status: 'running' }),
    ]),
  ).toEqual({
    calls: 8,
    text: '3 commands, 1 read, 2 edits, 1 search, 1 other',
    additions: 15,
    deletions: 1,
    failed: 1,
    stopped: 1,
    running: 1,
  })
  expect(
    toolGroupSummary([tool('t1', 'mcp__linear__get_issue'), tool('t2', 'Read'), tool('t3', 'Tool')])
      .text,
  ).toBe('1 read, 2 other')
})
