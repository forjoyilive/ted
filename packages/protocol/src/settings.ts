import type { Billing } from './health.ts'
import type { LinearIntakeScope } from './linear.ts'
import type { ListView } from './list-view.ts'
import type { AgentKind, PermissionMode } from './run.ts'
import type { EditorChoice } from './shell.ts'

export const timeFormats = ['system', '12-hour', '24-hour'] as const

export type TimeFormat = (typeof timeFormats)[number]

export const appearances = ['system', 'light', 'dark'] as const

export type Appearance = (typeof appearances)[number]

export const workingRunLimits = { min: 1, max: 99 } as const

export const checkLimits = { min: 1, max: 16 } as const

export const textSizeLimits = { min: 80, max: 200, step: 5 } as const

export const terminalFontSizes = { min: 10, max: 20 } as const

export const runOutputDayLimits = { min: 1, max: 365 } as const

export const quitChoices = ['ask', 'keep-running', 'stop'] as const

export type QuitChoice = (typeof quitChoices)[number]

export interface FactoryNotifications {
  inboxItems: boolean
  taskMerged: boolean
}

export const defaultFactoryNotifications: FactoryNotifications = {
  inboxItems: true,
  taskMerged: false,
}

export function factoryNotifications(
  settings: Pick<MachineSettings, 'factoryNotifications'>,
  factoryId: string,
): FactoryNotifications {
  return { ...defaultFactoryNotifications, ...settings.factoryNotifications[factoryId] }
}

export interface MachineSettings {
  timeFormat: TimeFormat
  timeZone: string
  textSize: number
  appearance: Appearance
  terminalFontSize: number
  profilePicture: string | null
  developerMode: boolean
  preparationNoticeSeen: boolean
  overnightMode: boolean
  maxWorkingRuns: number
  adjustRunsToLoad: boolean
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
  factoryNotifications: Readonly<Record<string, FactoryNotifications>>
  listViews: Readonly<Record<string, ListView>>
  firstLaunchDone: boolean
  billing: Readonly<Record<AgentKind, Billing>>
  editor: EditorChoice | null
  editorCommand: string
  linearIntakeScopes: Readonly<Record<string, LinearIntakeScope>>
  linearSync: boolean
  linearSyncTeams: Readonly<Record<string, readonly string[]>>
  linearSyncDeclined: Readonly<Record<string, readonly string[]>>
  factoryPermissions: Readonly<Record<string, PermissionMode>>
  appsOutsideSandbox: Readonly<Record<string, readonly string[]>>
  lowPriorityWork: boolean
  antigravityPlanAccepted: boolean
  maxChecksAtOnce: number
}

export const defaultMachineSettings: MachineSettings = {
  timeFormat: 'system',
  timeZone: 'system',
  textSize: 100,
  appearance: 'system',
  terminalFontSize: 13,
  profilePicture: null,
  developerMode: false,
  preparationNoticeSeen: false,
  overnightMode: false,
  maxWorkingRuns: 6,
  adjustRunsToLoad: false,
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
  factoryNotifications: {},
  listViews: {},
  firstLaunchDone: false,
  billing: { claude: 'subscription', codex: 'subscription', antigravity: 'subscription' },
  editor: null,
  editorCommand: '',
  linearIntakeScopes: {},
  linearSync: true,
  linearSyncTeams: {},
  linearSyncDeclined: {},
  factoryPermissions: {},
  appsOutsideSandbox: {},
  lowPriorityWork: true,
  antigravityPlanAccepted: false,
  maxChecksAtOnce: 2,
}

export interface Profile {
  name: string
}
