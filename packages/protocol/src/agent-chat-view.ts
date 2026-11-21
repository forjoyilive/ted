import type { BuiltInAgentId } from './agent-files.ts'
import type { ChatItem } from './chat.ts'
import type { AgentSummary, ChatRequestKind } from './chat-agent.ts'
import type { Coordinator, CoordinatorChatSummary } from './coordinator.ts'
import type { Plan, PlanStatus } from './plan.ts'
import { ordinal } from './task-status.ts'

export const chatRequestLabels = {
  question: 'Question',
  round: 'Round',
  proposal: 'Proposal',
  agent: 'Agent draft',
  'outside-command': 'Outside command',
} as const satisfies Readonly<Record<ChatRequestKind, string>>

export const coordinatorStatusLabels: Readonly<Record<Coordinator['status'], string>> = {
  ready: 'Ready',
  queued: 'Queued',
  working: 'Working',
  paused: 'Paused',
  failed: 'Failed',
}

export const chatWaitingLabel = 'Waiting on you'
export const chatArchivedLabel = 'Archived'

export function planStatusLabel(plan: Pick<Plan, 'status' | 'queuePlace' | 'paused'>): string {
  switch (plan.status) {
    case 'waiting':
      return chatWaitingLabel
    case 'working':
      return 'Working'
    case 'idle':
      return 'Idle'
    case 'queued':
      return plan.queuePlace === undefined ? 'Queued' : `Queued · ${ordinal(plan.queuePlace)}`
    case 'paused':
      return `Paused · ${plan.paused ?? 'usage limit'}`
    case 'failed':
      return 'Failed'
    case 'finished':
      return 'Finished'
    case 'stopped':
      return 'Stopped'
  }
}

export function planWaiting(plan: Pick<Plan, 'status' | 'openRequest' | 'archivedAt'>): boolean {
  return plan.archivedAt === undefined && (plan.status === 'waiting' || plan.openRequest === true)
}

const endedPlanStatuses: readonly PlanStatus[] = ['finished', 'stopped', 'failed']

export function planHasEnded(plan: Pick<Plan, 'status'>): boolean {
  return endedPlanStatuses.includes(plan.status)
}

export function coordinatorStoppable(
  chat: Pick<CoordinatorChatSummary, 'status' | 'endedAt'>,
): boolean {
  return (
    chat.endedAt === undefined &&
    (chat.status === 'working' || chat.status === 'queued' || chat.status === 'paused')
  )
}

export function planStoppable(plan: Pick<Plan, 'status' | 'archivedAt'>): boolean {
  return plan.archivedAt === undefined && !planHasEnded(plan)
}

const builtInSummaries = {
  coordinator: 'Recommends what to do next and acts on Tasks when you ask.',
  planner: 'Talks a large piece of work through with you, then proposes Tasks.',
} satisfies Record<BuiltInAgentId, string>

const builtInOrder: readonly string[] = ['coordinator', 'planner'] satisfies BuiltInAgentId[]

export function agentDescription(
  agent: Pick<AgentSummary, 'id' | 'description'>,
): string | undefined {
  if (agent.description !== undefined) return agent.description
  return agent.id === 'coordinator' || agent.id === 'planner'
    ? builtInSummaries[agent.id]
    : undefined
}

export function pickerOrder<T extends Pick<AgentSummary, 'id' | 'name'>>(
  agents: readonly T[],
): T[] {
  const place = (agent: T) => {
    const at = builtInOrder.indexOf(agent.id)
    return at === -1 ? builtInOrder.length : at
  }
  return [...agents].sort((a, b) => place(a) - place(b) || a.name.localeCompare(b.name))
}

export function conversationRows<T extends { at: string }>(
  items: readonly ChatItem[],
  extra: readonly T[],
  startedAt: string,
): ({ item: ChatItem } | { extra: T })[] {
  let lastAt = startedAt
  const rows = items.map((item) => {
    if (item.at !== undefined && item.at > lastAt) lastAt = item.at
    return { item, at: lastAt, queued: item.kind === 'human' && item.queued === true }
  })
  const additions = [...extra].sort((a, b) => a.at.localeCompare(b.at))
  const merged: ({ item: ChatItem } | { extra: T })[] = []
  let index = 0
  for (const row of rows) {
    while (index < additions.length) {
      const added = additions[index]
      if (!added || (!row.queued && added.at >= row.at)) break
      merged.push({ extra: added })
      index++
    }
    merged.push({ item: row.item })
  }
  for (const added of additions.slice(index)) merged.push({ extra: added })
  return merged
}
