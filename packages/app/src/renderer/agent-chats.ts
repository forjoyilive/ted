import type { Coordinator, CoordinatorChatSummary, Plan } from '@ted/protocol'
import {
  chatArchivedLabel,
  chatWaitingLabel,
  coordinatorRetryable,
  coordinatorStatusLabels,
  coordinatorStoppable,
  planMenuResumable,
  planStoppable,
  planWaiting,
} from '@ted/protocol/agent-chat-view'
import { useCallback, useState } from 'react'
import type { StatusGlyph, StatusTone } from './components/StatusChip.tsx'
import { planEnded, planStatusChip, planTasksLabel } from './plans.ts'

export { chatRequestLabels } from '@ted/protocol/agent-chat-view'

export type AgentChatRef = { agent: 'coordinator'; id: string } | { agent: 'planner'; id: string }

export interface AgentChatRow {
  ref: AgentChatRef
  factoryId: string
  agent: string
  title: string
  chip: { label: string; tone: StatusTone; glyph?: StatusGlyph }
  lastAt: string
  waiting: boolean
  archivedAt?: string
  meta: string
  state: ChatState
}

export interface ChatState {
  ref: AgentChatRef
  archived: boolean
  stoppable: boolean
  restart?: 'Resume' | 'Retry'
  planMore: boolean
}

export type ChatActionKind =
  | 'stop'
  | 'restart'
  | 'rename'
  | 'plan-more'
  | 'archive'
  | 'unarchive'
  | 'delete'

export function coordinatorChatState(
  chat: Pick<CoordinatorChatSummary, 'id' | 'status' | 'endedAt' | 'chatAgent'>,
): ChatState {
  const archived = chat.endedAt !== undefined
  return {
    ref: { agent: 'coordinator', id: chat.id },
    archived,
    stoppable: coordinatorStoppable(chat),
    ...(coordinatorRetryable(chat) && { restart: 'Retry' as const }),
    planMore: false,
  }
}

export function planChatState(plan: Pick<Plan, 'id' | 'status' | 'archivedAt'>): ChatState {
  const archived = plan.archivedAt !== undefined
  const restart = plan.status === 'failed' ? 'Retry' : 'Resume'
  return {
    ref: { agent: 'planner', id: plan.id },
    archived,
    stoppable: planStoppable(plan),
    ...(planMenuResumable(plan) && { restart }),
    planMore: archived || planEnded(plan),
  }
}

export function chatActions(state: ChatState): { kind: ChatActionKind; divider: boolean }[] {
  const item = (kind: ChatActionKind, divider = false) => ({ kind, divider })
  if (state.archived) {
    return [
      item('unarchive'),
      ...(state.planMore ? [item('plan-more', true), item('delete')] : [item('delete', true)]),
    ]
  }
  const first = state.stoppable ? 'stop' : state.restart !== undefined ? 'restart' : undefined
  return [
    ...(first === undefined ? [] : [item(first)]),
    item('rename', first !== undefined),
    ...(state.planMore ? [item('plan-more')] : []),
    item('archive', true),
    item('delete'),
  ]
}

export function chatActionLabel(kind: ChatActionKind, state: ChatState): string {
  switch (kind) {
    case 'stop':
      return 'Stop'
    case 'restart':
      return state.restart ?? 'Resume'
    case 'rename':
      return 'Rename…'
    case 'plan-more':
      return 'Plan more from here…'
    case 'archive':
      return 'Archive'
    case 'unarchive':
      return 'Unarchive'
    case 'delete':
      return 'Delete…'
  }
}

export const coordinatorStatus: Record<
  Coordinator['status'],
  { label: string; tone: StatusTone; glyph?: StatusGlyph }
> = {
  ready: { label: coordinatorStatusLabels.ready, tone: 'neutral' },
  queued: { label: coordinatorStatusLabels.queued, tone: 'neutral', glyph: 'queued' },
  working: { label: coordinatorStatusLabels.working, tone: 'working', glyph: 'working' },
  paused: { label: coordinatorStatusLabels.paused, tone: 'neutral', glyph: 'paused' },
  failed: { label: coordinatorStatusLabels.failed, tone: 'failed', glyph: 'failed' },
}

const archivedChip = { label: chatArchivedLabel, tone: 'neutral' as const }

function coordinatorRow(chat: CoordinatorChatSummary): AgentChatRow {
  const archived = chat.endedAt !== undefined
  return {
    ref: { agent: 'coordinator', id: chat.id },
    factoryId: chat.factoryId,
    agent: chat.chatAgent.name,
    title: chat.title || `${chat.chatAgent.name} chat`,
    chip: archived ? archivedChip : chat.waiting ? waitingChip : coordinatorStatus[chat.status],
    lastAt: chat.lastAt,
    waiting: !archived && chat.waiting,
    ...(chat.endedAt !== undefined && { archivedAt: chat.endedAt }),
    meta: chat.taskCount === 1 ? '1 Task' : `${chat.taskCount} Tasks`,
    state: coordinatorChatState(chat),
  }
}

const waitingChip = { label: chatWaitingLabel, tone: 'waiting' as const, glyph: 'waiting' as const }

function planRow(plan: Plan): AgentChatRow {
  const archived = plan.archivedAt !== undefined
  return {
    ref: { agent: 'planner', id: plan.id },
    factoryId: plan.factoryId,
    agent: plan.chatAgent.name,
    title: plan.title,
    chip: archived ? archivedChip : planStatusChip(plan),
    lastAt: plan.lastAt,
    waiting: planWaiting(plan),
    ...(plan.archivedAt !== undefined && { archivedAt: plan.archivedAt }),
    meta: plan.fromTask
      ? `From ${plan.fromTask.displayId}`
      : planTasksLabel(plan) === '—'
        ? ''
        : planTasksLabel(plan),
    state: planChatState(plan),
  }
}

export function agentChatRows(
  coordinatorChats: readonly CoordinatorChatSummary[],
  plans: readonly Plan[],
): AgentChatRow[] {
  return [...coordinatorChats.map(coordinatorRow), ...plans.map(planRow)].sort((a, b) =>
    b.lastAt.localeCompare(a.lastAt),
  )
}

export interface ArchiveSplit {
  open: AgentChatRow[]
  archived: AgentChatRow[]
}

export function splitArchived(rows: readonly AgentChatRow[]): ArchiveSplit {
  return {
    open: rows.filter((r) => r.archivedAt === undefined),
    archived: rows
      .filter((r) => r.archivedAt !== undefined)
      .sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? '')),
  }
}

const builtInNames = ['Coordinator', 'Planner']

export function groupedRows(
  rows: readonly AgentChatRow[],
): { agent: string; rows: AgentChatRow[] }[] {
  const names = [...new Set(rows.map((r) => r.agent))].sort((a, b) => {
    const [x, y] = [builtInNames.indexOf(a), builtInNames.indexOf(b)]
    if (x !== y) return (x === -1 ? builtInNames.length : x) - (y === -1 ? builtInNames.length : y)
    return a.localeCompare(b)
  })
  return names.map((agent) => ({ agent, rows: rows.filter((r) => r.agent === agent) }))
}

export function sameChat(a: AgentChatRef | undefined, b: AgentChatRef | undefined): boolean {
  return a !== undefined && b !== undefined && a.agent === b.agent && a.id === b.id
}

export function pickChat(
  rows: readonly AgentChatRow[],
  remembered: AgentChatRef | undefined,
): AgentChatRef | undefined {
  return (
    rows.find((r) => sameChat(r.ref, remembered))?.ref ??
    rows.find((r) => r.archivedAt === undefined)?.ref
  )
}

const storageKey = 'ted.agents'

interface Stored {
  byAgent: boolean
  open: Record<string, AgentChatRef>
}

function isRef(value: unknown): value is AgentChatRef {
  if (!value || typeof value !== 'object') return false
  const { agent, id } = value as { agent?: unknown; id?: unknown }
  return (agent === 'coordinator' || agent === 'planner') && typeof id === 'string'
}

function read(): Stored {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '{}')
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new Error('not saved')
    const { byAgent, open } = stored as { byAgent?: unknown; open?: unknown }
    return {
      byAgent: byAgent === true,
      open:
        open && typeof open === 'object' && !Array.isArray(open)
          ? Object.fromEntries(Object.entries(open).filter(([, ref]) => isRef(ref)))
          : {},
    }
  } catch {
    return { byAgent: false, open: {} }
  }
}

export function useAgentsView(factoryId: string) {
  const [stored, setStored] = useState(read)
  const save = (next: Stored) => {
    setStored(next)
    try {
      localStorage.setItem(storageKey, JSON.stringify(next))
    } catch {}
  }
  return {
    byAgent: stored.byAgent,
    setByAgent: (byAgent: boolean) => save({ ...read(), byAgent }),
    remembered: stored.open[factoryId],
    remember: useCallback(
      (ref: AgentChatRef) => {
        const now = read()
        if (sameChat(now.open[factoryId], ref)) return
        const next = { ...now, open: { ...now.open, [factoryId]: ref } }
        setStored(next)
        try {
          localStorage.setItem(storageKey, JSON.stringify(next))
        } catch {}
      },
      [factoryId],
    ),
  }
}
