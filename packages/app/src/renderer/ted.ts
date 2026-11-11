import type { DaemonConnection } from '@ted/daemon/launch'
import type { DaemonEvent, ExportFormat, RunFixRequest } from '@ted/protocol'
import type { MenuCommand } from '../background.ts'
import { type CustomRequests, customRequest } from '../custom-requests.ts'
import { daemonRequests } from '../daemon-requests.ts'
import type { LoginItemState } from '../login-item.ts'
import type { UpdateStatus } from '../updates.ts'

export type TedEvent =
  | DaemonEvent
  | { type: 'menu-command'; command: MenuCommand }
  | { type: 'connection'; connection: DaemonConnection }
  | { type: 'login-item'; state: LoginItemState }
  | { type: 'update'; status: UpdateStatus }
  | { type: 'notifications-off'; off: boolean }

export interface TedBridge {
  request(name: string, ...args: unknown[]): Promise<unknown>
  onEvent(listener: (event: TedEvent) => void): () => void
}

declare global {
  interface Window {
    ted: TedBridge
  }
}

function request<K extends keyof CustomRequests>(
  name: K,
  ...args: Parameters<CustomRequests[K]>
): ReturnType<CustomRequests[K]> {
  return customRequest((name, ...args) => window.ted.request(name, ...args), name, ...args)
}

export const ted = {
  ...daemonRequests((name, ...args) => window.ted.request(name, ...args)),
  getAutomation: (id: string) => request('getAutomation', id),
  exportFactory: (factoryId: string, format: ExportFormat) =>
    request('exportFactory', factoryId, format),
  taskBrief: (taskId: string) => request('taskBrief', taskId),
  openTaskSource: (taskId: string) => request('openTaskSource', taskId),
  openPullRequest: (taskId: string, repoName: string) =>
    request('openPullRequest', taskId, repoName),
  openFigmaLink: (taskId: string, commentId: string) => request('openFigmaLink', taskId, commentId),
  openAppPreview: (taskId: string, repo: string, name: string) =>
    request('openAppPreview', taskId, repo, name),
  openHostedPreview: (taskId: string, repo: string) => request('openHostedPreview', taskId, repo),
  chooseFolder: (title: string) => request('chooseFolder', title),
  homeFolder: () => request('homeFolder'),
  showFactoryFolder: (factoryId: string) => request('showFactoryFolder', factoryId),
  openOnGitHub: (url: string) => request('openOnGitHub', url),
  copyText: (text: string) => request('copyText', text),
  downloadTed: () => request('downloadTed'),
  thirdPartyLicenses: () => request('thirdPartyLicenses'),
  quit: () => request('quit'),
  chooseProfilePicture: () => request('chooseProfilePicture'),
  copyReport: () => request('copyReport'),
  tedFolder: () => request('tedFolder'),
  showTedFolder: () => request('showTedFolder'),
  showBackupInFolder: (name: string) => request('showBackupInFolder', name),
  loginItem: () => request('loginItem'),
  openLoginItemsSettings: () => request('openLoginItemsSettings'),
  notificationsOff: () => request('notificationsOff'),
  openNotificationSettings: () => request('openNotificationSettings'),
  connection: () => request('connection'),
  restartDaemon: () => request('restartDaemon'),
  updateStatus: () => request('updateStatus'),
  checkForUpdates: () => request('checkForUpdates'),
  restartToUpdate: () => request('restartToUpdate'),
  copyCrashReport: () => request('copyCrashReport'),
  runFix: (input: RunFixRequest) => request('runFix', input),
  openLinearKeyPage: () => request('openLinearKeyPage'),
  onEvent: (listener: (event: TedEvent) => void) => window.ted.onEvent(listener),
}

export function readableError(failure: unknown): string {
  const message = failure instanceof Error ? failure.message : String(failure)
  return message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '')
}
