import type {
  BackupsSummary,
  Comment,
  DaemonEvent,
  DataStatus,
  Factory,
  MachineSettings,
  RestoreBackupResult,
  Task,
} from '@ted/protocol'

export interface TedBridge {
  request(name: string, ...args: unknown[]): Promise<unknown>
  onEvent(listener: (event: DaemonEvent) => void): () => void
}

declare global {
  interface Window {
    ted: TedBridge
  }
}

export const ted = {
  listTasks: () => window.ted.request('listTasks') as Promise<Task[]>,
  listComments: (taskId: string) =>
    window.ted.request('listComments', taskId) as Promise<Comment[]>,
  listFactories: () => window.ted.request('listFactories') as Promise<Factory[]>,
  getSettings: () => window.ted.request('getSettings') as Promise<MachineSettings>,
  updateSettings: (changes: Partial<MachineSettings>) =>
    window.ted.request('updateSettings', changes) as Promise<MachineSettings>,
  getDataStatus: () => window.ted.request('getDataStatus') as Promise<DataStatus>,
  listBackups: () => window.ted.request('listBackups') as Promise<BackupsSummary>,
  restoreBackup: (name: string) =>
    window.ted.request('restoreBackup', name) as Promise<RestoreBackupResult>,
  copyText: (text: string) => window.ted.request('copyText', text) as Promise<void>,
  downloadTed: () => window.ted.request('downloadTed') as Promise<void>,
  quit: () => window.ted.request('quit') as Promise<void>,
  onEvent: (listener: (event: DaemonEvent) => void) => window.ted.onEvent(listener),
}
