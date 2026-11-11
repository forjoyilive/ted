import type { Priority } from './task.ts'

export const busyHold = 'this computer is busy'

export type SlotHolder =
  | TaskSlotHolder
  | AutomationSlotHolder
  | PlanSlotHolder
  | CoordinatorSlotHolder
  | DraftSlotHolder
  | SideChatSlotHolder

export interface SideChatSlotHolder {
  kind: 'side-chat'
  runId: string
  factoryId: string
  name: string
  runs: number
}

export interface DraftSlotHolder {
  kind: 'automation-draft'
  runId: string
  name: string
  factoryId: string
  runs: number
}

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
  | { kind: 'side-chat'; place: number; runId: string; factoryId: string; name: string }
  | { kind: 'automation-draft'; place: number; runId: string; name: string; factoryId: string }
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
  heldForLoad?: true
  loadRatio?: number
}
