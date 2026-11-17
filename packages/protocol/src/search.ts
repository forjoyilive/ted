import type { CommentAuthor, StageId } from './task.ts'

export type SearchField = 'id' | 'tracker' | 'title' | 'description' | 'original-request' | 'brief'

export type TrackerKind = 'linear' | 'github' | 'sentry'

export interface TrackerMatch {
  kind: TrackerKind
  id: string
}

export type SearchTaskState = 'open' | 'done' | 'archived'

export interface TaskHit {
  taskId: string
  displayId: string
  factoryId: string
  title: string
  stage: StageId
  state: SearchTaskState
  field: SearchField
  snippet?: string
  tracker?: TrackerMatch
}

export interface CommentHit {
  commentId: string
  taskId: string
  displayId: string
  factoryId: string
  taskTitle: string
  author: CommentAuthor
  leadAuthor: boolean
  state: SearchTaskState
  snippet: string
  createdAt: string
}

export interface FactoryHit {
  factoryId: string
  name: string
}

export interface PlanHit {
  planId: string
  factoryId: string
  title: string
  ended: boolean
}

export interface AutomationHit {
  automationId: string
  factoryId: string
  name: string
  on: boolean
}

export interface ConversationHit {
  runId: string
  itemId: string
  factoryId: string
  source: 'task' | 'plan' | 'automation' | 'coordinator'
  chatId?: string
  ref: string
  title: string
  runName: string
  kind: 'agent' | 'human' | 'tool'
  at: string
  snippet: string
}

export interface SearchResults {
  query: string
  conversations: ConversationHit[]
  tasks: TaskHit[]
  comments: CommentHit[]
  factories: FactoryHit[]
  plans: PlanHit[]
  automations: AutomationHit[]
}

export const searchLimits = {
  conversations: 10,
  conversationsPerRun: 2,
  tasks: 20,
  comments: 10,
  factories: 10,
  plans: 10,
  automations: 10,
} as const

export function foldText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

export function searchTerms(query: string): string[] {
  return foldText(query).split(/\s+/).filter(Boolean)
}

export function compactId(text: string): string {
  return foldText(text.trim())
    .replace(/^#/, '')
    .replace(/[\s-]+/g, '')
}

export function matchesTerms(terms: readonly string[], text: string): boolean {
  if (terms.length === 0) return false
  const folded = foldText(text)
  return terms.every((term) => folded.includes(term))
}

export function snippetAround(terms: readonly string[], text: string, width = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= width) return flat
  const folded = foldText(flat)
  const at = Math.max(
    0,
    Math.min(
      ...terms.flatMap((t) => {
        const i = folded.indexOf(t)
        return i >= 0 ? [i] : []
      }),
    ),
  )
  const start = Math.max(0, Math.min(at - Math.floor(width / 3), flat.length - width))
  const end = Math.min(flat.length, start + width)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`
}
