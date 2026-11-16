import type { Coordinator, CoordinatorChatSummary, Plan } from '@ted/protocol'
import { useCallback, useState } from 'react'
import type { StatusGlyph, StatusTone } from './components/StatusChip.tsx'
import { planEnded, planStatusChip, planTasksLabel } from './plans.ts'

export type AgentName = 'Coordinator' | 'Planner'

export const agentNames: readonly AgentName[] = ['Coordinator', 'Planner']

export type AgentChatRef = { agent: 'coordinator'; id: string } | { agent: 'planner'; id: string }

export interface AgentChatRow {
  ref: AgentChatRef
  agent: AgentName
  title: string
  chip: { label: string; tone: StatusTone; glyph?: StatusGlyph }
  lastAt: string
  waiting: boolean
  ended: boolean
  meta: string
}

export const coordinatorStatus: Record<
  Coordinator['status'],
  { label: string; tone: StatusTone; glyph?: StatusGlyph }
> = {
  ready: { label: 'Ready', tone: 'neutral' },
  queued: { label: 'Queued', tone: 'neutral', glyph: 'queued' },
  working: { label: 'Working', tone: 'working', glyph: 'working' },
  paused: { label: 'Paused', tone: 'neutral', glyph: 'paused' },
  failed: { label: 'Failed', tone: 'failed', glyph: 'failed' },
}

const endedChip = { label: 'Ended', tone: 'neutral' as const }

function coordinatorRow(chat: CoordinatorChatSummary): AgentChatRow {
  const ended = chat.endedAt !== undefined
  return {
    ref: { agent: 'coordinator', id: chat.id },
    agent: 'Coordinator',
    title: chat.title || 'Coordinator chat',
    chip: ended ? endedChip : chat.waiting ? waitingChip : coordinatorStatus[chat.status],
    lastAt: chat.lastAt,
    waiting: chat.waiting,
    ended,
    meta: chat.taskCount === 1 ? '1 Task' : `${chat.taskCount} Tasks`,
  }
}

const waitingChip = { label: 'Waiting on you', tone: 'waiting' as const, glyph: 'waiting' as const }

function planRow(plan: Plan): AgentChatRow {
  return {
    ref: { agent: 'planner', id: plan.id },
    agent: 'Planner',
    title: plan.title,
    chip: planStatusChip(plan),
    lastAt: plan.lastAt,
    waiting: plan.status === 'waiting',
    ended: planEnded(plan),
    meta: plan.fromTask
      ? `From ${plan.fromTask.displayId}`
      : planTasksLabel(plan) === '—'
        ? ''
        : planTasksLabel(plan),
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

export function groupedRows(
  rows: readonly AgentChatRow[],
): { agent: AgentName; rows: AgentChatRow[] }[] {
  return agentNames
    .map((agent) => ({ agent, rows: rows.filter((r) => r.agent === agent) }))
    .filter((group) => group.rows.length > 0)
}

export function sameChat(a: AgentChatRef | undefined, b: AgentChatRef | undefined): boolean {
  return a !== undefined && b !== undefined && a.agent === b.agent && a.id === b.id
}

export function pickChat(
  rows: readonly AgentChatRow[],
  remembered: AgentChatRef | undefined,
): AgentChatRef | undefined {
  return rows.find((r) => sameChat(r.ref, remembered))?.ref ?? rows[0]?.ref
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
