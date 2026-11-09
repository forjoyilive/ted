import type { CommentAuthor, StageId } from './task.ts'

export type SearchField = 'id' | 'title' | 'description' | 'original-request' | 'brief'

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

export interface AutomationHit {
  automationId: string
  factoryId: string
  name: string
  on: boolean
}

export interface SearchResults {
  query: string
  tasks: TaskHit[]
  comments: CommentHit[]
  factories: FactoryHit[]
  automations: AutomationHit[]
}

export const searchLimits = { tasks: 20, comments: 10, factories: 10, automations: 10 } as const

export function foldText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

export function searchTerms(query: string): string[] {
  return foldText(query).split(/\s+/).filter(Boolean)
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
  const at = Math.max(0, Math.min(...terms.map((t) => folded.indexOf(t)).filter((i) => i >= 0)))
  const start = Math.max(0, Math.min(at - Math.floor(width / 3), flat.length - width))
  const end = Math.min(flat.length, start + width)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`
}
