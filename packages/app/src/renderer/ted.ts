import type {
  Attachment,
  Banner,
  Comment,
  CreateTaskRequest,
  DaemonEvent,
  Factory,
  MachineSettings,
  Run,
  StageEntry,
  Task,
  TaskDefaults,
  TaskLead,
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
  getRun: (runId: string) => window.ted.request('getRun', runId) as Promise<Run>,
  setTaskLead: (taskId: string, lead: TaskLead) =>
    window.ted.request('setTaskLead', taskId, lead) as Promise<Task>,
  pickDefaultModel: (taskId: string) =>
    window.ted.request('useDefaultModel', taskId) as Promise<Task>,
  listStageEntries: (taskId: string) =>
    window.ted.request('listStageEntries', taskId) as Promise<StageEntry[]>,
  listFactories: () => window.ted.request('listFactories') as Promise<Factory[]>,
  createTask: (input: CreateTaskRequest) =>
    window.ted.request('createTask', input) as Promise<Task>,
  taskDefaults: (factoryId: string) =>
    window.ted.request('taskDefaults', factoryId) as Promise<TaskDefaults>,
  uploadAttachment: (file: { name: string; mediaType: string }, bytes: Uint8Array) =>
    window.ted.request('uploadAttachment', file.name, file.mediaType, bytes) as Promise<Attachment>,
  getSettings: () => window.ted.request('getSettings') as Promise<MachineSettings>,
  updateSettings: (changes: Partial<MachineSettings>) =>
    window.ted.request('updateSettings', changes) as Promise<MachineSettings>,
  listBanners: () => window.ted.request('listBanners') as Promise<Banner[]>,
  dismissBanner: (id: string) => window.ted.request('dismissBanner', id) as Promise<Banner>,
  actOnBanner: (id: string) => window.ted.request('actOnBanner', id) as Promise<void>,
  onEvent: (listener: (event: DaemonEvent) => void) => window.ted.onEvent(listener),
}
