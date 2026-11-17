import type { AutomationInput, EditAutomationRequest } from './automation.ts'

export const automationCardKinds = ['create', 'edit', 'delete'] as const

export type AutomationCardKind = (typeof automationCardKinds)[number]

export const automationDraftLimits = { name: 120, prompt: 8000, model: 100 } as const

export interface AutomationDraftRequest {
  operation: string
  kind: AutomationCardKind
  automation?: string
  create?: AutomationInput
  edit?: EditAutomationRequest
}

export interface AutomationCardRow {
  label: string
  value: string
  before?: string
  long?: true
}

export interface AutomationCardResult {
  decision: 'confirm' | 'cancel'
  at: string
  automationId?: string
  startTasks?: true
  refused?: string
}

export interface AutomationCard {
  id: string
  kind: AutomationCardKind
  operation: string
  askedAt: string
  name: string
  automationId?: string
  rows: AutomationCardRow[]
  nextFirings: string[]
  offersStartTasks: boolean
  create?: AutomationInput
  edit?: EditAutomationRequest
  fingerprint?: string
  requestHash: string
  answer?: AutomationCardResult
}

export interface AutomationCardAnswer {
  decision: 'confirm' | 'cancel'
  startTasks?: boolean
}

export interface AutomationDraftResult {
  card: { id: string; waiting: boolean }
}

export function automationCardHeadline(card: Pick<AutomationCard, 'kind' | 'name'>): string {
  if (card.kind === 'create') return `Create Automation “${card.name}”?`
  if (card.kind === 'edit') return `Save changes to “${card.name}”?`
  return `Delete Automation “${card.name}”?`
}
