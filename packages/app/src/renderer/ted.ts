import type {
  Comment,
  DaemonEvent,
  Factory,
  MachineSettings,
  StageEntry,
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
  listStageEntries: (taskId: string) =>
    window.ted.request('listStageEntries', taskId) as Promise<StageEntry[]>,
  listFactories: () => window.ted.request('listFactories') as Promise<Factory[]>,
  getSettings: () => window.ted.request('getSettings') as Promise<MachineSettings>,
  updateSettings: (changes: Partial<MachineSettings>) =>
    window.ted.request('updateSettings', changes) as Promise<MachineSettings>,
  onEvent: (listener: (event: DaemonEvent) => void) => window.ted.onEvent(listener),
}
