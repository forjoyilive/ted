import type { DaemonConnection } from '@ted/daemon/launch'
import type {
  Attachment,
  BackupsSummary,
  Banner,
  CommandLineStatus,
  Comment,
  CreateTaskRequest,
  DaemonEvent,
  DataStatus,
  Diagnostics,
  Factory,
  IntegrationsHealth,
  LogText,
  MachineSettings,
  Profile,
  RestoreBackupResult,
  Run,
  RunFixRequest,
  RunFixResult,
  RunSlots,
  StageEntry,
  Task,
  TaskDefaults,
  TaskLead,
} from '@ted/protocol'
import type { MenuCommand } from '../background.ts'

export type TedEvent =
  | DaemonEvent
  | { type: 'menu-command'; command: MenuCommand }
  | { type: 'connection'; connection: DaemonConnection }

export interface TedBridge {
  request(name: string, ...args: unknown[]): Promise<unknown>
  onEvent(listener: (event: TedEvent) => void): () => void
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
  startTask: (taskId: string) => window.ted.request('startTask', taskId) as Promise<Task>,
  moveToBacklog: (taskId: string) => window.ted.request('moveToBacklog', taskId) as Promise<Task>,
  getSlots: () => window.ted.request('getSlots') as Promise<RunSlots>,
  taskDefaults: (factoryId: string) =>
    window.ted.request('taskDefaults', factoryId) as Promise<TaskDefaults>,
  uploadAttachment: (file: { name: string; mediaType: string }, bytes: Uint8Array) =>
    window.ted.request('uploadAttachment', file.name, file.mediaType, bytes) as Promise<Attachment>,
  setupLog: (taskId: string, repo: string) =>
    window.ted.request('setupLog', taskId, repo) as Promise<string>,
  locateLocalFolder: (key: string) =>
    window.ted.request('locateLocalFolder', key) as Promise<Factory | undefined>,
  getSettings: () => window.ted.request('getSettings') as Promise<MachineSettings>,
  updateSettings: (changes: Partial<MachineSettings>) =>
    window.ted.request('updateSettings', changes) as Promise<MachineSettings>,
  getDataStatus: () => window.ted.request('getDataStatus') as Promise<DataStatus>,
  listBackups: () => window.ted.request('listBackups') as Promise<BackupsSummary>,
  restoreBackup: (name: string) =>
    window.ted.request('restoreBackup', name) as Promise<RestoreBackupResult>,
  copyText: (text: string) => window.ted.request('copyText', text) as Promise<void>,
  downloadTed: () => window.ted.request('downloadTed') as Promise<void>,
  getCommandLine: () => window.ted.request('getCommandLine') as Promise<CommandLineStatus>,
  installCommandLine: () => window.ted.request('installCommandLine') as Promise<CommandLineStatus>,
  thirdPartyLicenses: () => window.ted.request('thirdPartyLicenses') as Promise<string>,
  quit: () => window.ted.request('quit') as Promise<void>,
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
  connection: () => window.ted.request('connection') as Promise<DaemonConnection>,
  restartDaemon: () => window.ted.request('restartDaemon') as Promise<void>,
  copyCrashReport: () => window.ted.request('copyCrashReport') as Promise<void>,
  getIntegrations: () => window.ted.request('getIntegrations') as Promise<IntegrationsHealth>,
  checkIntegrations: () => window.ted.request('checkIntegrations') as Promise<IntegrationsHealth>,
  runFix: (request: RunFixRequest) =>
    window.ted.request('runFix', request) as Promise<RunFixResult>,
  onEvent: (listener: (event: TedEvent) => void) => window.ted.onEvent(listener),
}
