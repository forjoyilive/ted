import type { Priority } from './task.ts'

export type SlotHolder =
  | TaskSlotHolder
  | AutomationSlotHolder
  | PlanSlotHolder
  | CoordinatorSlotHolder

export interface CoordinatorSlotHolder {
  kind: 'coordinator'
  runId: string
  factoryId: string
  name: string
  runs: number
}

export interface PlanSlotHolder {
  kind: 'planning'
  runId: string
  planId: string
  name: string
  factoryId: string
  runs: number
}

export interface AutomationSlotHolder {
  kind: 'automation'
  runId: string
  automationId: string
  name: string
  factoryId: string
  runs: number
}

export interface TaskSlotHolder {
  kind: 'task'
  taskId: string
  displayId: string
  title: string
  factoryId: string
  runs: number
  subAgents: number
  settingUp: boolean
}

export type QueuedForSlot =
  | { kind: 'coordinator'; place: number; runId: string; factoryId: string; name: string }
  | {
      kind: 'task'
      place: number
      taskId: string
      displayId: string
      title: string
      factoryId: string
      priority: Priority
      setup?: true
    }
  | {
      kind: 'sub-agent'
      place: number
      runId: string
      name: string
      taskId: string
      displayId: string
      factoryId: string
    }
  | {
      kind: 'planning'
      place: number
      runId: string
      planId: string
      name: string
      factoryId: string
    }
  | {
      kind: 'automation'
      place: number
      runId: string
      automationId: string
      name: string
      factoryId: string
    }

export interface FactorySlots {
  factoryId: string
  cap: number
  working: number
}

export interface RunSlots {
  limit: number
  working: number
  queued: number
  holders: SlotHolder[]
  queue: QueuedForSlot[]
  factories: FactorySlots[]
}
