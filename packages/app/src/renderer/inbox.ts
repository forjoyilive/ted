import type {
  AutomationRequest,
  Comment,
  Factory,
  FactoryLayout,
  InboxItem,
  PlanInboxItem,
  Priority,
  StageId,
} from '@ted/protocol'
import { emptyLayout, groupSections, groups } from './factory-layout.ts'
import { stageName, stageOrder } from './list-view.ts'
import { priorityLabels } from './task-fields.ts'

export interface InboxChip {
  factoryId?: string
  groupId?: string
  label: string
  count: number
}

export function waitingByFactory(
  items: readonly InboxItem[],
  questions: readonly Pick<AutomationRequest, 'factoryId'>[] = [],
  plans: readonly PlanInboxItem[] = [],
): Record<string, number> {
  const counts: Record<string, number> = {}
  const factoryIds = [
    ...items.map((i) => i.task.factoryId),
    ...questions.map((q) => q.factoryId),
    ...plans.map((p) => p.plan.factoryId),
  ]
  for (const id of factoryIds) counts[id] = (counts[id] ?? 0) + 1
  return counts
}

export function inboxChips(
  items: readonly InboxItem[],
  factories: readonly Factory[],
  questions: readonly Pick<AutomationRequest, 'factoryId'>[] = [],
  plans: readonly PlanInboxItem[] = [],
  layout: FactoryLayout = emptyLayout,
): InboxChip[] {
  const counts = waitingByFactory(items, questions, plans)
  return [
    { label: 'All', count: items.length + questions.length + plans.length },
    ...groups(layout).map((g) => ({
      groupId: g.id,
      label: g.name,
      count: g.factoryIds.reduce((sum, id) => sum + (counts[id] ?? 0), 0),
    })),
    ...factories.map((f) => ({ factoryId: f.id, label: f.name, count: counts[f.id] ?? 0 })),
  ]
}

export function inFactory(
  items: readonly InboxItem[],
  scope: ((factoryId: string) => boolean) | undefined,
): readonly InboxItem[] {
  return scope === undefined ? items : items.filter((i) => scope(i.task.factoryId))
}

export function nextSelection<T extends { request: { id: string } }>(
  before: readonly T[],
  now: readonly T[],
  selected: string | undefined,
): T | null | undefined {
  if (selected === undefined || now.some((i) => i.request.id === selected)) return undefined
  const at = before.findIndex((i) => i.request.id === selected)
  if (at === -1) return undefined
  const still = (item: T) => now.find((i) => i.request.id === item.request.id)
  const after = before
    .slice(at + 1)
    .map(still)
    .find((i) => i !== undefined)
  return (
    after ??
    before
      .slice(0, at)
      .reverse()
      .map(still)
      .find((i) => i !== undefined) ??
    now[0] ??
    null
  )
}

export const inboxGroupings = ['none', 'kind', 'age', 'stage', 'priority', 'factory-group'] as const

export type InboxGrouping = (typeof inboxGroupings)[number]

export const inboxGroupingLabels: Record<InboxGrouping, string> = {
  none: 'None',
  kind: 'Kind',
  age: 'Age',
  stage: 'Stage',
  priority: 'Priority',
  'factory-group': 'Factory group',
}

export type InboxKind = 'blocking' | 'question' | 'signoff'

export interface Grouped {
  kind: InboxKind
  at: string
  stage?: StageId | undefined
  priority?: Priority | undefined
  factoryId?: string | undefined
}

export interface InboxGroup<T> {
  key: string
  label: string
  rows: T[]
  old?: true
}

export function requestKind(
  request: Pick<Comment, 'kind' | 'failed' | 'purpose' | 'gate'>,
): InboxKind {
  const purpose = request.purpose?.kind
  if (
    request.kind === 'permission' ||
    request.failed !== undefined ||
    purpose === 'failure' ||
    purpose === 'failed-run'
  ) {
    return 'blocking'
  }
  if (
    request.kind === 'signoff' ||
    request.kind === 'review' ||
    request.gate !== undefined ||
    purpose === 'gate'
  ) {
    return 'signoff'
  }
  return 'question'
}

const priorityHeadings: readonly (readonly [string, string])[] = [
  ['urgent', priorityLabels.urgent],
  ['high', priorityLabels.high],
  ['medium', priorityLabels.medium],
  ['low', priorityLabels.low],
  ['none', 'No Priority'],
  ['no-task', 'Not from a Task'],
]

const kindHeadings: readonly (readonly [InboxKind, string])[] = [
  ['blocking', 'Blocking a Run'],
  ['question', 'Questions'],
  ['signoff', 'Sign-offs'],
]

export interface InboxOrder {
  groupsReversed: boolean
  oldestFirst: boolean
}

export const defaultInboxOrder: InboxOrder = { groupsReversed: false, oldestFirst: false }

export function groupInbox<T extends { grouped: Grouped }>(
  newestFirst: readonly T[],
  grouping: InboxGrouping,
  now: number,
  order: InboxOrder = defaultInboxOrder,
  layout: FactoryLayout = emptyLayout,
): InboxGroup<T>[] {
  const grouped = groupRows(
    order.oldestFirst ? [...newestFirst].reverse() : newestFirst,
    grouping,
    now,
    layout,
  )
  if (!order.groupsReversed) return grouped
  const last = grouped.at(-1)
  return last?.key === 'none' ? [...grouped.slice(0, -1).reverse(), last] : [...grouped].reverse()
}

function groupRows<T extends { grouped: Grouped }>(
  rows: readonly T[],
  grouping: InboxGrouping,
  now: number,
  layout: FactoryLayout,
): InboxGroup<T>[] {
  if (grouping === 'none') return rows.length ? [{ key: 'all', label: '', rows: [...rows] }] : []
  const pick = (
    headings: readonly (readonly [string, string])[],
    keyOf: (row: T) => string,
  ): InboxGroup<T>[] =>
    headings
      .map(([key, label]) => ({ key, label, rows: rows.filter((row) => keyOf(row) === key) }))
      .filter((group) => group.rows.length > 0)
  if (grouping === 'kind') return pick(kindHeadings, (row) => row.grouped.kind)
  if (grouping === 'factory-group') {
    const sections = groupSections(layout)
    return pick(
      sections.keys.map((key) => [key, sections.labelOf(key)] as const),
      (row) =>
        row.grouped.factoryId === undefined ? 'none' : sections.keyOf(row.grouped.factoryId),
    )
  }
  if (grouping === 'priority')
    return pick(priorityHeadings, (row) => row.grouped.priority ?? 'no-task')
  if (grouping === 'stage') {
    const known = (row: T) => {
      const stage = row.grouped.stage
      return stage !== undefined && stageOrder.includes(stage) ? stage : 'none'
    }
    return pick(
      [...stageOrder.map((stage) => [stage, stageName(stage)] as const), ['none', 'No Stage']],
      known,
    )
  }
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  const today = day.getTime()
  day.setDate(day.getDate() - 6)
  const week = day.getTime()
  const bucket = (row: T) => {
    const at = Date.parse(row.grouped.at)
    return at >= today ? 'today' : at >= week ? 'week' : 'older'
  }
  return pick(
    [
      ['today', 'Today'],
      ['week', 'Earlier this week'],
      ['older', 'Older'],
    ],
    bucket,
  ).map((group) => (group.key === 'older' ? { ...group, old: true as const } : group))
}
