import type { AppKind } from './factory-settings.ts'
import type { Attachment } from './task.ts'

export const appStates = ['stopped', 'waiting', 'starting', 'running', 'exited', 'failed'] as const
export type AppState = (typeof appStates)[number]

export type AppStarter = 'human' | 'task-lead' | 'sub-agent' | 'automation'

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
  confirmOutsideSandbox?: true
}

export interface AppSimulator {
  device: string
  booted: boolean
  recording?: boolean
  window?: boolean
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

export type DevicePlatform = 'ios' | 'android'

export interface SimulatorAsk {
  platform?: 'android'
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

export function isSimulatorApp<T extends { kind: AppKind }>(
  app: T,
): app is T & { kind: 'ios-simulator' } {
  return app.kind === 'ios-simulator'
}

export function isEmulatorApp<T extends { kind: AppKind }>(
  app: T,
): app is T & { kind: 'android-emulator' } {
  return app.kind === 'android-emulator'
}

export function isDeviceApp<T extends { kind: AppKind }>(
  app: T,
): app is T & { kind: 'ios-simulator' | 'android-emulator' } {
  return isSimulatorApp(app) || isEmulatorApp(app)
}

export function devicePlatform(app: { kind: AppKind }): DevicePlatform | undefined {
  if (isSimulatorApp(app)) return 'ios'
  if (isEmulatorApp(app)) return 'android'
  return undefined
}

export const deviceWords = {
  ios: { one: 'simulator', many: 'simulators', on: 'booted', title: 'iOS simulator' },
  android: { one: 'emulator', many: 'emulators', on: 'running', title: 'Android emulator' },
} as const

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

export const emulatorSlotLimits = { min: 1, max: 16 } as const

export function simulatorsLine(slots: SimulatorSlots): string | undefined {
  if (!slots.supported || slots.booted.length === 0) return undefined
  return `Simulators ${slots.booted.length} of ${slots.limit} booted`
}

export function emulatorsLine(slots: SimulatorSlots): string | undefined {
  if (!slots.supported || slots.booted.length === 0) return undefined
  return `Emulators ${slots.booted.length} of ${slots.limit} running`
}
