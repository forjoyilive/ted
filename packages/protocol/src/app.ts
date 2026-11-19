import type { AppKind } from './factory-settings.ts'
import type { OutsideSandboxApproval } from './outside-sandbox.ts'
import type { PreviewPreset } from './preview-size.ts'
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
  builtAt?: string
  endedAt?: string
  exitCode?: number
  signal?: string
  problem?: string
  startedBy?: AppStarter
  removed?: boolean
  waitingFor?: string
  waitingOn?: { displayId: string; app: string }
  asking?: true
  simulator?: AppSimulator
  confirmOutsideSandbox?: true
  outsideSandboxApproval?: OutsideSandboxApproval
  electron?: true
  preview?: PreviewPreset
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
  platform?: 'android'
}

export type DeviceWait =
  | { kind: 'answer' }
  | { kind: 'build'; displayId: string; app: string }
  | { kind: 'device' }
  | { kind: 'busy' }
  | { kind: 'line' }

export interface WaitingDevice {
  taskId: string
  displayId: string
  title: string
  repo: string
  app: string
  device: string
  platform?: 'android'
  place: number
  waitingFor: DeviceWait
}

export interface SimulatorSlots {
  supported: boolean
  limit: number
  booted: BootedSimulator[]
  waiting: WaitingDevice[]
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
  declaration?: string
}

export interface RestartAppRequest extends AppRef {
  declaration?: string
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

export const deviceSlotLimits = { min: 1, max: 20 } as const

export function devicesLine(slots: SimulatorSlots): string | undefined {
  if (!slots.supported) return undefined
  const running = slots.booted.length
  const waiting = slots.waiting.length
  if (running === 0 && waiting === 0) return undefined
  const line = `Simulators and emulators ${running} of ${slots.limit} running`
  return waiting === 0 ? line : `${line} · ${waiting} waiting`
}
