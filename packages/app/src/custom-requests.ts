import type { DaemonConnection } from '@ted/daemon/launch'
import type { MachineSettings, RunFixRequest, RunFixResult, TaskBrief } from '@ted/protocol'
import type { LoginItemState } from './login-item.ts'
import type { UpdateStatus } from './updates.ts'

export interface CustomRequests {
  taskBrief: (taskId: string) => Promise<TaskBrief | null>
  openTaskSource: (taskId: string) => Promise<void>
  openPullRequest: (taskId: string, repoName: string) => Promise<void>
  openFigmaLink: (taskId: string, commentId: string) => Promise<void>
  openAppPreview: (taskId: string, repo: string, name: string) => Promise<void>
  openHostedPreview: (taskId: string, repo: string) => Promise<void>
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
  tedFolder: () => Promise<{ path: string; platform: string }>
  showTedFolder: () => Promise<void>
  showBackupInFolder: (name: string) => Promise<void>
  loginItem: () => Promise<LoginItemState>
  openLoginItemsSettings: () => Promise<void>
  notificationsOff: () => Promise<boolean>
  openNotificationSettings: () => Promise<void>
  connection: () => Promise<DaemonConnection>
  restartDaemon: () => Promise<void>
  updateStatus: () => Promise<UpdateStatus>
  checkForUpdates: () => Promise<UpdateStatus>
  restartToUpdate: () => Promise<void>
  copyCrashReport: () => Promise<void>
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
