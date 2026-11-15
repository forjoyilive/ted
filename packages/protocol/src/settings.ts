import type { AsanaIntakeScope } from './asana-intake.ts'
import type { BoardView } from './board-view.ts'
import type { Billing } from './health.ts'
import type { LinearIntakeScope } from './linear.ts'
import type { ListView } from './list-view.ts'
import { type AgentKind, agentKinds, type PermissionMode } from './run.ts'
import type { EditorChoice } from './shell.ts'

export const timeFormats = ['system', '12-hour', '24-hour'] as const

export type TimeFormat = (typeof timeFormats)[number]

export const appearances = ['system', 'light', 'dark'] as const

export type Appearance = (typeof appearances)[number]

export const workingRunLimits = { min: 1, max: 99 } as const

export const checkLimits = { min: 1, max: 16 } as const

export const textSizeLimits = { min: 80, max: 200, step: 5 } as const

// 100% draws text at 110% of the CSS sizes; integer maths keeps the CSS value exact.
export function textScale(textSize: number): number {
  return (textSize * 11) / 1000
}

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

export function firstFactoryNotifications(
  factoryIds: readonly string[],
  notifyTaskMerged: boolean,
): Record<string, FactoryNotifications> {
  return notifyTaskMerged
    ? Object.fromEntries(
        factoryIds.map((id) => [id, { ...defaultFactoryNotifications, taskMerged: true }]),
      )
    : {}
}

export type TrackerGroupLists = Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
>

export type TrackerGroupAccounts = Readonly<
  Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>
>

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
  reviewUnvettedTasks: boolean
  maxWorkingRuns: number
  adjustRunsToLoad: boolean
  maxBootedSimulators: number
  maxRunningEmulators: number
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
  boardViews: Readonly<Record<string, BoardView>>
  firstLaunchDone: boolean
  enabledAgents: readonly AgentKind[]
  billing: Readonly<Record<AgentKind, Billing>>
  editor: EditorChoice | null
  editorCommand: string
  linearIntakeScopes: Readonly<Record<string, LinearIntakeScope>>
  asanaIntakeScopes: Readonly<Record<string, AsanaIntakeScope>>
  linearSync: boolean
  asanaSync: boolean
  githubIssueSync: boolean
  linearSyncTeams: Readonly<Record<string, readonly string[]>>
  linearSyncDeclined: Readonly<Record<string, readonly string[]>>
  trackerSyncGroups: TrackerGroupLists
  trackerSyncDeclined: TrackerGroupLists
  trackerSyncGroupAccounts: TrackerGroupAccounts
  factoryPermissions: Readonly<Record<string, PermissionMode>>
  appsOutsideSandbox: Readonly<Record<string, readonly string[]>>
  lowPriorityWork: boolean
  antigravityPlanAccepted: boolean
  maxChecksAtOnce: number
  startNewTasks: boolean
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
  reviewUnvettedTasks: true,
  maxWorkingRuns: 6,
  adjustRunsToLoad: false,
  maxBootedSimulators: 3,
  maxRunningEmulators: 2,
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
  boardViews: {},
  firstLaunchDone: false,
  enabledAgents: [...agentKinds],
  billing: { claude: 'subscription', codex: 'subscription', antigravity: 'subscription' },
  editor: null,
  editorCommand: '',
  linearIntakeScopes: {},
  asanaIntakeScopes: {},
  linearSync: true,
  asanaSync: true,
  githubIssueSync: false,
  linearSyncTeams: {},
  linearSyncDeclined: {},
  trackerSyncGroups: {},
  trackerSyncDeclined: {},
  trackerSyncGroupAccounts: {},
  factoryPermissions: {},
  appsOutsideSandbox: {},
  lowPriorityWork: true,
  antigravityPlanAccepted: false,
  maxChecksAtOnce: 2,
  startNewTasks: true,
}

export interface Profile {
  name: string
}
