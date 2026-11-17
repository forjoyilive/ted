import type { DaemonConnection } from '@ted/daemon/launch'
import type {
  AsanaStatus,
  Attachment,
  AutomationDetail,
  Crash,
  ExportFormat,
  MachineSettings,
  MemoryUse,
  ProblemReportRequest,
  ProblemReportResult,
  ProcessInfo,
  ProcessUsage,
  RunFixRequest,
  RunFixResult,
  SaveExportResult,
  TaskBrief,
} from '@ted/protocol'
import type { LoginItemState } from './login-item.ts'
import type { NotificationOffer } from './notifications.ts'
import type { UpdateStatus } from './updates.ts'

export interface CustomRequests {
  authorizeAsana: () => Promise<AsanaStatus>
  openAsanaSetup: () => Promise<void>
  openWorker: () => Promise<void>
  workerStatus: () => Promise<import('@ted/protocol').WorkerStatus>
  workerPair: (
    input: import('@ted/protocol').WorkerPairRequest,
  ) => Promise<import('@ted/protocol').WorkerStatus>
  workerStart: () => Promise<import('@ted/protocol').WorkerStatus>
  workerStop: () => Promise<import('@ted/protocol').WorkerStatus>
  showAttachmentInFolder: (attachment: Pick<Attachment, 'hash' | 'name'>) => Promise<void>
  getAutomation: (id: string) => Promise<AutomationDetail | null>
  exportFactory: (factoryId: string, format: ExportFormat) => Promise<SaveExportResult>
  taskBrief: (taskId: string) => Promise<TaskBrief | null>
  openTaskSource: (taskId: string) => Promise<void>
  openPullRequest: (taskId: string, repoName: string) => Promise<void>
  openFigmaLink: (taskId: string, commentId: string) => Promise<void>
  openMarkdownLink: (url: string) => Promise<void>
  presentBrowser: (
    taskId: string,
    repo: string,
    name: string,
    bounds: { x: number; y: number; width: number; height: number },
  ) => Promise<void>
  hideBrowser: (temporary?: boolean) => Promise<void>
  browserState: (
    taskId: string,
  ) => Promise<{ url: string; text: string; opening?: true; blocked?: number } | undefined>
  externalBrowser: (taskId: string) => Promise<void>
  openAppPreview: (taskId: string, repo: string, name: string) => Promise<void>
  openHostedPreview: (taskId: string, repo: string) => Promise<void>
  openRunAppPreview: (runId: string, repo: string, name: string) => Promise<void>
  chooseFolder: (title: string) => Promise<string | undefined>
  homeFolder: () => Promise<string>
  showFactoryFolder: (factoryId: string) => Promise<void>
  openOnGitHub: (url: string) => Promise<void>
  copyText: (text: string) => Promise<void>
  downloadTed: () => Promise<void>
  thirdPartyLicenses: () => Promise<string>
  quit: () => Promise<void>
  chooseProfilePicture: () => Promise<MachineSettings>
  copyReport: () => Promise<void>
  memoryUse: () => Promise<MemoryUse>
  resourceUsage: () => Promise<ProcessUsage>
  appProcesses: () => Promise<ProcessInfo[]>
  tedFolder: () => Promise<{ path: string; platform: string }>
  showTedFolder: () => Promise<void>
  showBackupInFolder: (name: string) => Promise<void>
  loginItem: () => Promise<LoginItemState>
  startSettled: () => Promise<void>
  openLoginItemsSettings: () => Promise<void>
  notificationsOff: () => Promise<boolean>
  notificationOffer: () => Promise<NotificationOffer>
  turnOnNotifications: () => Promise<void>
  declineNotifications: () => Promise<void>
  openNotificationSettings: () => Promise<void>
  connection: () => Promise<DaemonConnection>
  restartDaemon: () => Promise<void>
  updateStatus: () => Promise<UpdateStatus>
  checkForUpdates: () => Promise<UpdateStatus>
  restartToUpdate: () => Promise<void>
  copyCrashReport: () => Promise<void>
  problemReport: () => Promise<{ text: string; daemon: boolean }>
  sendProblemReport: (request: ProblemReportRequest) => Promise<ProblemReportResult>
  reportCrash: (crash: Crash) => Promise<void>
  openGitHubIssue: () => Promise<void>
  runFix: (request: RunFixRequest) => Promise<RunFixResult>
  openLinearKeyPage: () => Promise<void>
}

export type CustomHandlers<K extends keyof CustomRequests> = {
  [P in K]: (
    client: import('@ted/protocol').DaemonClient,
    ...args: Parameters<CustomRequests[P]>
  ) => ReturnType<CustomRequests[P]>
}

export function customRequest<K extends keyof CustomRequests>(
  request: (name: string, ...args: unknown[]) => Promise<unknown>,
  name: K,
  ...args: Parameters<CustomRequests[K]>
): ReturnType<CustomRequests[K]> {
  return request(name, ...args) as ReturnType<CustomRequests[K]>
}
