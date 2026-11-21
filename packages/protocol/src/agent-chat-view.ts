import type { ChatItem } from './chat.ts'
import type { ChatRequestKind } from './chat-agent.ts'
import type { Coordinator } from './coordinator.ts'
import type { Plan } from './plan.ts'
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
