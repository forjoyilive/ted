import type { AsanaIntakeScope } from './asana-intake.ts'
import { type AutomationRunsView, defaultAutomationRunsView } from './automation-runs-view.ts'
import { type BacklogStarts, noBacklogStarts } from './backlog-starts.ts'
import type { BoardView } from './board-view.ts'
import { type DiagnosticsSort, defaultDiagnosticsSort } from './diagnostics-sort.ts'
import type { GitHubIntakeScope } from './github-intake.ts'
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

const gibibyte = 1024 ** 3

export function defaultWorkingRuns(totalMemoryBytes: number): number {
  if (!Number.isFinite(totalMemoryBytes) || totalMemoryBytes <= 0) return 6
  return Math.min(8, Math.max(2, Math.floor(totalMemoryBytes / (4 * gibibyte))))
}

export const checkLimits = { min: 1, max: 16 } as const

export const checkCpuLimits = { min: 10, max: 100, step: 10 } as const

export const textSizeLimits = { min: 80, max: 200, step: 5 } as const

// 100% draws text at 110% of the CSS sizes; integer maths keeps the CSS value exact.
export function textScale(textSize: number): number {
  return (textSize * 11) / 1000
}

export const terminalFontSizes = { min: 10, max: 20 } as const

export const runOutputDayLimits = { min: 1, max: 365 } as const

export const archivedTaskDayLimits = { min: 1, max: 365 } as const

export const idleRunSleepLimits = { min: 1, max: 1440 } as const

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
  reportEmail: string
  developerMode: boolean
  preparationNoticeSeen: boolean
  overnightMode: boolean
  reviewUnvettedTasks: boolean
  maxWorkingRuns: number
  waitWhenBusy: boolean
  maxRunningDevices: number
  buildDeviceAppsOneAtATime: boolean
  runOutputDays: number
  deleteArchivedAfterDays: number | null
  deleteArchivedChatsAfterDays: number | null
  quitWithWorkRunning: QuitChoice
  showTrayIcon: boolean
  startAtLogin: boolean
  stayAwake: boolean
  restartIdleRuns: boolean
  sleepIdleRunsAfterMinutes: number | null
  notifyInboxItems: boolean
  notifyProblems: boolean
  notifyTaskMerged: boolean
  notifySound: boolean
  factoryNotifications: Readonly<Record<string, FactoryNotifications>>
  listViews: Readonly<Record<string, ListView>>
  boardViews: Readonly<Record<string, BoardView>>
  diagnosticsSort: DiagnosticsSort
  automationRunsView: AutomationRunsView
  firstLaunchDone: boolean
  onboardingOnNextOpen: boolean
  guideNextFactory: boolean
  reporting: boolean
  reportingAsked: boolean
  enabledAgents: readonly AgentKind[]
  billing: Readonly<Record<AgentKind, Billing>>
  editor: EditorChoice | null
  editorCommand: string
  linearIntakeScopes: Readonly<Record<string, LinearIntakeScope>>
  asanaIntakeScopes: Readonly<Record<string, AsanaIntakeScope>>
  githubIntakeScopes: Readonly<Record<string, GitHubIntakeScope>>
  linearSync: boolean
  asanaSync: boolean
  githubIssueSync: boolean
  aiDisclosure: boolean
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
  checkCpuPercent: number
  limitScheduledCheckCpus: boolean
  startNewTasks: boolean
  backlogStarts: BacklogStarts
}

export const defaultMachineSettings: MachineSettings = {
  timeFormat: 'system',
  timeZone: 'system',
  textSize: 100,
  appearance: 'system',
  terminalFontSize: 13,
  profilePicture: null,
  reportEmail: '',
  developerMode: false,
  preparationNoticeSeen: false,
  overnightMode: false,
  reviewUnvettedTasks: true,
  maxWorkingRuns: 6,
  waitWhenBusy: true,
  maxRunningDevices: 2,
  buildDeviceAppsOneAtATime: true,
  runOutputDays: 7,
  deleteArchivedAfterDays: null,
  deleteArchivedChatsAfterDays: null,
  quitWithWorkRunning: 'ask',
  showTrayIcon: true,
  startAtLogin: true,
  stayAwake: true,
  restartIdleRuns: true,
  sleepIdleRunsAfterMinutes: 10,
  notifyInboxItems: true,
  notifyProblems: true,
  notifyTaskMerged: false,
  notifySound: false,
  factoryNotifications: {},
  listViews: {},
  boardViews: {},
  diagnosticsSort: defaultDiagnosticsSort,
  automationRunsView: defaultAutomationRunsView,
  firstLaunchDone: false,
  onboardingOnNextOpen: false,
  guideNextFactory: false,
  reporting: false,
  reportingAsked: false,
  enabledAgents: [...agentKinds],
  billing: { claude: 'subscription', codex: 'subscription', antigravity: 'subscription' },
  editor: null,
  editorCommand: '',
  linearIntakeScopes: {},
  asanaIntakeScopes: {},
  githubIntakeScopes: {},
  linearSync: true,
  asanaSync: true,
  githubIssueSync: false,
  aiDisclosure: true,
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
  checkCpuPercent: 50,
  limitScheduledCheckCpus: true,
  startNewTasks: true,
  backlogStarts: noBacklogStarts,
}

export interface Profile {
  name: string
}
