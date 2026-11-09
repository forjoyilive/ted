import type { Priority } from './task.ts'

export interface SlotHolder {
  kind: 'task'
  taskId: string
  displayId: string
  title: string
  factoryId: string
  runs: number
  settingUp: boolean
}

export interface QueuedForSlot {
  kind: 'task'
  place: number
  taskId: string
  displayId: string
  title: string
  factoryId: string
  priority: Priority
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
