import type {
  Banner,
  Comment,
  DaemonEvent,
  Diagnostics,
  Factory,
  LogText,
  MachineSettings,
  Profile,
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
  getProfile: () => window.ted.request('getProfile') as Promise<Profile>,
  chooseProfilePicture: () =>
    window.ted.request('chooseProfilePicture') as Promise<MachineSettings>,
  getDiagnostics: () => window.ted.request('getDiagnostics') as Promise<Diagnostics>,
  readDaemonLog: () => window.ted.request('readDaemonLog') as Promise<LogText>,
  readRunOutput: (runId: string) => window.ted.request('readRunOutput', runId) as Promise<LogText>,
  copyReport: () => window.ted.request('copyReport') as Promise<void>,
  tedFolder: () => window.ted.request('tedFolder') as Promise<{ path: string; platform: string }>,
  showTedFolder: () => window.ted.request('showTedFolder') as Promise<void>,
  listBanners: () => window.ted.request('listBanners') as Promise<Banner[]>,
  dismissBanner: (id: string) => window.ted.request('dismissBanner', id) as Promise<Banner>,
  actOnBanner: (id: string) => window.ted.request('actOnBanner', id) as Promise<void>,
  onEvent: (listener: (event: DaemonEvent) => void) => window.ted.onEvent(listener),
}
