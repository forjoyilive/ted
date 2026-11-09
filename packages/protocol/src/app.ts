import type { AppKind } from './factory-settings.ts'
import type { Attachment } from './task.ts'

export const appStates = ['stopped', 'waiting', 'starting', 'running', 'exited', 'failed'] as const
export type AppState = (typeof appStates)[number]

export type AppStarter = 'human' | 'task-lead' | 'sub-agent'

export interface TaskApp {
  repo: string
  name: string
  kind: AppKind
  state: AppState
  port?: number
  url?: string
  startedAt?: string
  endedAt?: string
  exitCode?: number
  signal?: string
  problem?: string
  startedBy?: AppStarter
  removed?: boolean
  waitingFor?: string
  simulator?: AppSimulator
}

export interface AppSimulator {
  device: string
  booted: boolean
  recording?: boolean
  shutDown?: { at: string; for?: string }
}

export interface BootedSimulator {
  udid: string
  taskId: string
  displayId: string
  title: string
  repo: string
  app: string
  device: string
  lastUsedAt: string
  recording: boolean
}

export interface SimulatorSlots {
  supported: boolean
  limit: number
  booted: BootedSimulator[]
}

export interface SimulatorAsk {
  app: string
  repo: string
  device: string
  limit: number
  booted: BootedSimulator[]
}

export interface StartAppRequest extends AppRef {
  shutDown?: string
  reason?: string
}

export interface RecordAppRequest extends AppRef {
  action: 'start' | 'stop'
}

export interface AppCapture {
  attachment?: Attachment
  recording: boolean
}

export interface AppRef {
  name: string
  repo?: string
}

export interface AppLog {
  text: string
  truncated: boolean
}

export function appEnvName(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, '_')
}

export function isLoopbackUrl(text: string): boolean {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.username !== '' || url.password !== '') return false
  const host = url.hostname.toLowerCase()
  return host === 'localhost' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host)
}

export const simulatorSlotLimits = { min: 1, max: 20 } as const

export function simulatorsLine(slots: SimulatorSlots): string | undefined {
  if (!slots.supported || slots.booted.length === 0) return undefined
  return `Simulators ${slots.booted.length} of ${slots.limit} booted`
}
