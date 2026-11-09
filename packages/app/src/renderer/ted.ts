import type { DaemonConnection } from '@ted/daemon/launch'
import type { Banner, Comment, DaemonEvent, Factory, MachineSettings, Task } from '@ted/protocol'

export type AppEvent = DaemonEvent | { type: 'connection'; connection: DaemonConnection }

export interface TedBridge {
  request(name: string, ...args: unknown[]): Promise<unknown>
  onEvent(listener: (event: AppEvent) => void): () => void
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
  listBanners: () => window.ted.request('listBanners') as Promise<Banner[]>,
  dismissBanner: (id: string) => window.ted.request('dismissBanner', id) as Promise<Banner>,
  actOnBanner: (id: string) => window.ted.request('actOnBanner', id) as Promise<void>,
  connection: () => window.ted.request('connection') as Promise<DaemonConnection>,
  restartDaemon: () => window.ted.request('restartDaemon') as Promise<void>,
  copyCrashReport: () => window.ted.request('copyCrashReport') as Promise<void>,
  onEvent: (listener: (event: AppEvent) => void) => window.ted.onEvent(listener),
}
