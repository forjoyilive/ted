import type { Billing } from './health.ts'
import type { ListView } from './list-view.ts'
import type { AgentKind } from './run.ts'
import type { EditorChoice } from './shell.ts'

export const timeFormats = ['system', '12-hour', '24-hour'] as const

export type TimeFormat = (typeof timeFormats)[number]

export const appearances = ['system', 'light', 'dark'] as const

export type Appearance = (typeof appearances)[number]

export const workingRunLimits = { min: 1, max: 99 } as const

export const terminalFontSizes = { min: 10, max: 20 } as const

export const runOutputDayLimits = { min: 1, max: 365 } as const

export const quitChoices = ['ask', 'keep-running', 'stop'] as const

export type QuitChoice = (typeof quitChoices)[number]

export interface MachineSettings {
  timeFormat: TimeFormat
  timeZone: string
  appearance: Appearance
  terminalFontSize: number
  profilePicture: string | null
  developerMode: boolean
  overnightMode: boolean
  maxWorkingRuns: number
  maxBootedSimulators: number
  runOutputDays: number
  quitWithWorkRunning: QuitChoice
  showTrayIcon: boolean
  startAtLogin: boolean
  stayAwake: boolean
  restartIdleRuns: boolean
  notifyInboxItems: boolean
  notifyProblems: boolean
  notifyTaskMerged: boolean
  notifySound: boolean
  listViews: Readonly<Record<string, ListView>>
  firstLaunchDone: boolean
  billing: Readonly<Record<AgentKind, Billing>>
  editor: EditorChoice | null
  editorCommand: string
  linearSync: boolean
  linearSyncTeams: Readonly<Record<string, readonly string[]>>
  linearSyncDeclined: Readonly<Record<string, readonly string[]>>
  appsOutsideSandbox: Readonly<Record<string, readonly string[]>>
}

export const defaultMachineSettings: MachineSettings = {
  timeFormat: 'system',
  timeZone: 'system',
  appearance: 'system',
  terminalFontSize: 13,
  profilePicture: null,
  developerMode: false,
  overnightMode: false,
  maxWorkingRuns: 6,
  maxBootedSimulators: 3,
  runOutputDays: 7,
  quitWithWorkRunning: 'ask',
  showTrayIcon: true,
  startAtLogin: true,
  stayAwake: true,
  restartIdleRuns: true,
  notifyInboxItems: true,
  notifyProblems: true,
  notifyTaskMerged: false,
  notifySound: false,
  listViews: {},
  firstLaunchDone: false,
  billing: { claude: 'subscription', codex: 'subscription' },
  editor: null,
  editorCommand: '',
  linearSync: true,
  linearSyncTeams: {},
  linearSyncDeclined: {},
  appsOutsideSandbox: {},
}

export interface Profile {
  name: string
}
