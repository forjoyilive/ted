import type { DaemonConnection } from '@ted/daemon/launch'
import type {
  AgentHealth,
  AgentKind,
  AnswerRequest,
  ArchiveDoneResult,
  ArchiveTaskRequest,
  Attachment,
  BackupsSummary,
  Banner,
  BannerActionInput,
  CheckOutput,
  CheckRepoRequest,
  CheckRun,
  CheckTry,
  CheckTryOutput,
  CheckTryRequest,
  ClarifyDepth,
  CommandLineStatus,
  Comment,
  CreateFactoryRequest,
  CreateTaskRequest,
  DaemonEvent,
  DataStatus,
  DeleteTaskRequest,
  DescriptionVersion,
  Diagnostics,
  EditTaskRequest,
  Factory,
  FactoryBoard,
  FactorySettingsChanges,
  FactorySettingsView,
  InboxItem,
  IntegrationsHealth,
  LinearLookup,
  LinearStatus,
  LogText,
  MachineSettings,
  MoveTaskRequest,
  Priority,
  Profile,
  RemoveClonesResult,
  RepoCheck,
  RestoreBackupResult,
  Run,
  RunChat,
  RunFixRequest,
  RunFixResult,
  RunMessage,
  RunSlots,
  RunSummary,
  SaveSettingsRequest,
  SaveSettingsResult,
  SetTaskReposRequest,
  SettingsPreview,
  StageEntry,
  StorageSummary,
  Task,
  TaskDefaults,
  TaskLead,
  TaskReposResult,
  ThreadEvent,
} from '@ted/protocol'
import type { MenuCommand } from '../background.ts'
import type { LoginItemState } from '../login-item.ts'

export type TedEvent =
  | DaemonEvent
  | { type: 'menu-command'; command: MenuCommand }
  | { type: 'connection'; connection: DaemonConnection }
  | { type: 'login-item'; state: LoginItemState }

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
  cancelMerge: (taskId: string, comment: string) =>
    window.ted.request('cancelMerge', taskId, comment) as Promise<Comment>,
  postComment: (taskId: string, body: string) =>
    window.ted.request('postComment', taskId, body) as Promise<Comment>,
  markCommentsRead: (taskId: string) =>
    window.ted.request('markCommentsRead', taskId) as Promise<{ read: number }>,
  listThreadEvents: (taskId: string) =>
    window.ted.request('listThreadEvents', taskId) as Promise<ThreadEvent[]>,
  listInbox: () => window.ted.request('listInbox') as Promise<InboxItem[]>,
  listAnswered: () => window.ted.request('listAnswered') as Promise<InboxItem[]>,
  answerRequest: (commentId: string, answer: AnswerRequest) =>
    window.ted.request('answerRequest', commentId, answer) as Promise<Comment>,
  getRun: (runId: string) => window.ted.request('getRun', runId) as Promise<Run>,
  getRunChat: (runId: string) => window.ted.request('getRunChat', runId) as Promise<RunChat>,
  sendRunMessage: (runId: string, text: string, interrupt = false) =>
    window.ted.request('sendRunMessage', runId, text, interrupt) as Promise<RunMessage>,
  interruptRun: (runId: string) => window.ted.request('interruptRun', runId) as Promise<RunSummary>,
  sendQueuedMessageNow: (runId: string, messageId: string) =>
    window.ted.request('sendQueuedMessageNow', runId, messageId) as Promise<RunMessage>,
  deleteQueuedMessage: (runId: string, messageId: string) =>
    window.ted.request('deleteQueuedMessage', runId, messageId) as Promise<RunMessage>,
  restartRun: (runId: string) => window.ted.request('restartRun', runId) as Promise<RunSummary>,
  stopRun: (runId: string) => window.ted.request('stopRun', runId) as Promise<RunSummary>,
  listTaskRuns: (taskId: string) =>
    window.ted.request('listTaskRuns', taskId) as Promise<RunSummary[]>,
  openRunTab: (taskId: string, runId: string) =>
    window.ted.request('openRunTab', taskId, runId) as Promise<Task>,
  closeRunTab: (taskId: string, runId: string) =>
    window.ted.request('closeRunTab', taskId, runId) as Promise<Task>,
  setTaskLead: (taskId: string, lead: TaskLead) =>
    window.ted.request('setTaskLead', taskId, lead) as Promise<Task>,
  editTask: (taskId: string, edit: EditTaskRequest) =>
    window.ted.request('editTask', taskId, edit) as Promise<Task>,
  taskDescriptions: (taskId: string) =>
    window.ted.request('taskDescriptions', taskId) as Promise<DescriptionVersion[]>,
  setClarifyDepth: (taskId: string, depth: ClarifyDepth) =>
    window.ted.request('setClarifyDepth', taskId, depth) as Promise<Task>,
  pickDefaultModel: (taskId: string) =>
    window.ted.request('useDefaultModel', taskId) as Promise<Task>,
  listStageEntries: (taskId: string) =>
    window.ted.request('listStageEntries', taskId) as Promise<StageEntry[]>,
  listCheckRuns: (taskId: string) =>
    window.ted.request('listCheckRuns', taskId) as Promise<CheckRun[]>,
  checkOutput: (checkRunId: string, position: number) =>
    window.ted.request('checkOutput', checkRunId, position) as Promise<CheckOutput>,
  listFactories: () => window.ted.request('listFactories') as Promise<Factory[]>,
  createTask: (input: CreateTaskRequest) =>
    window.ted.request('createTask', input) as Promise<Task>,
  startTask: (taskId: string) => window.ted.request('startTask', taskId) as Promise<Task>,
  moveToBacklog: (taskId: string) => window.ted.request('moveToBacklog', taskId) as Promise<Task>,
  stopTask: (taskId: string) => window.ted.request('stopTask', taskId) as Promise<Task>,
  resumeTask: (taskId: string, comment?: string) =>
    window.ted.request('resumeTask', taskId, comment) as Promise<Task>,
  openTaskSource: (taskId: string) => window.ted.request('openTaskSource', taskId) as Promise<void>,
  moveTask: (taskId: string, request: MoveTaskRequest) =>
    window.ted.request('moveTask', taskId, request) as Promise<Task>,
  setPriority: (taskId: string, priority: Priority) =>
    window.ted.request('setPriority', taskId, priority) as Promise<Task>,
  archiveTask: (taskId: string, options: ArchiveTaskRequest = {}) =>
    window.ted.request('archiveTask', taskId, options) as Promise<Task>,
  unarchiveTask: (taskId: string) => window.ted.request('unarchiveTask', taskId) as Promise<Task>,
  followUpTask: (taskId: string, comment?: string) =>
    window.ted.request('followUpTask', taskId, comment) as Promise<Task>,
  archiveDone: (factoryId: string) =>
    window.ted.request('archiveDone', factoryId) as Promise<ArchiveDoneResult>,
  deleteTask: (taskId: string, options: DeleteTaskRequest = {}) =>
    window.ted.request('deleteTask', taskId, options) as Promise<void>,
  openPullRequest: (taskId: string, repoName: string) =>
    window.ted.request('openPullRequest', taskId, repoName) as Promise<void>,
  blockTask: (taskId: string, by: string) =>
    window.ted.request('blockTask', taskId, by) as Promise<Task>,
  unblockTask: (taskId: string, by: string) =>
    window.ted.request('unblockTask', taskId, by) as Promise<Task>,
  getSlots: () => window.ted.request('getSlots') as Promise<RunSlots>,
  taskDefaults: (factoryId: string) =>
    window.ted.request('taskDefaults', factoryId) as Promise<TaskDefaults>,
  factoryBoard: (factoryId: string) =>
    window.ted.request('factoryBoard', factoryId) as Promise<FactoryBoard>,
  uploadAttachment: (file: { name: string; mediaType: string }, bytes: Uint8Array) =>
    window.ted.request('uploadAttachment', file.name, file.mediaType, bytes) as Promise<Attachment>,
  setupLog: (taskId: string, repo: string) =>
    window.ted.request('setupLog', taskId, repo) as Promise<string>,
  setTaskRepos: (taskId: string, request: SetTaskReposRequest) =>
    window.ted.request('setTaskRepos', taskId, request) as Promise<TaskReposResult>,
  chooseFolder: (title: string) =>
    window.ted.request('chooseFolder', title) as Promise<string | undefined>,
  homeFolder: () => window.ted.request('homeFolder') as Promise<string>,
  checkRepo: (request: CheckRepoRequest) =>
    window.ted.request('checkRepo', request) as Promise<RepoCheck>,
  createFactory: (request: CreateFactoryRequest) =>
    window.ted.request('createFactory', request) as Promise<Factory>,
  factorySettings: (factoryId: string) =>
    window.ted.request('factorySettings', factoryId) as Promise<FactorySettingsView>,
  previewFactorySettings: (factoryId: string, changes: FactorySettingsChanges) =>
    window.ted.request('previewFactorySettings', factoryId, changes) as Promise<SettingsPreview>,
  saveFactorySettings: (factoryId: string, request: SaveSettingsRequest) =>
    window.ted.request('saveFactorySettings', factoryId, request) as Promise<SaveSettingsResult>,
  tryCheck: (factoryId: string, request: CheckTryRequest) =>
    window.ted.request('tryCheck', factoryId, request) as Promise<CheckTry>,
  stopCheckTry: (factoryId: string, name: string) =>
    window.ted.request('stopCheckTry', factoryId, name) as Promise<void>,
  checkTryOutput: (factoryId: string, name: string) =>
    window.ted.request('checkTryOutput', factoryId, name) as Promise<CheckTryOutput>,
  renameFactory: (factoryId: string, name: string) =>
    window.ted.request('renameFactory', factoryId, name) as Promise<Factory>,
  setRepoLocalFolder: (factoryId: string, repoName: string, folder: string) =>
    window.ted.request('setRepoLocalFolder', factoryId, repoName, folder) as Promise<Factory>,
  clearRepoLocalFolder: (factoryId: string, repoName: string) =>
    window.ted.request('clearRepoLocalFolder', factoryId, repoName) as Promise<Factory>,
  openOnGitHub: (url: string) => window.ted.request('openOnGitHub', url) as Promise<void>,
  retryClone: (factoryId: string) =>
    window.ted.request('retryClone', factoryId) as Promise<Factory>,
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
  getStorage: () => window.ted.request('getStorage') as Promise<StorageSummary>,
  removeUnusedClones: () => window.ted.request('removeUnusedClones') as Promise<RemoveClonesResult>,
  showBackupInFolder: (name: string) =>
    window.ted.request('showBackupInFolder', name) as Promise<void>,
  listBanners: () => window.ted.request('listBanners') as Promise<Banner[]>,
  dismissBanner: (id: string) => window.ted.request('dismissBanner', id) as Promise<Banner>,
  actOnBanner: (id: string, input?: BannerActionInput) =>
    window.ted.request('actOnBanner', id, input) as Promise<void>,
  agentHealth: () => window.ted.request('agentHealth') as Promise<AgentHealth[]>,
  checkAgentHealth: () => window.ted.request('checkAgentHealth') as Promise<AgentHealth[]>,
  fixAgent: (agent: AgentKind) => window.ted.request('fixAgent', agent) as Promise<AgentHealth>,
  loginItem: () => window.ted.request('loginItem') as Promise<LoginItemState>,
  openLoginItemsSettings: () => window.ted.request('openLoginItemsSettings') as Promise<void>,
  connection: () => window.ted.request('connection') as Promise<DaemonConnection>,
  restartDaemon: () => window.ted.request('restartDaemon') as Promise<void>,
  copyCrashReport: () => window.ted.request('copyCrashReport') as Promise<void>,
  getIntegrations: () => window.ted.request('getIntegrations') as Promise<IntegrationsHealth>,
  checkIntegrations: () => window.ted.request('checkIntegrations') as Promise<IntegrationsHealth>,
  runFix: (request: RunFixRequest) =>
    window.ted.request('runFix', request) as Promise<RunFixResult>,
  getLinear: () => window.ted.request('getLinear') as Promise<LinearStatus>,
  saveLinearKey: (key: string, inFile = false) =>
    window.ted.request('saveLinearKey', key, inFile) as Promise<LinearStatus>,
  testLinear: () => window.ted.request('testLinear') as Promise<LinearStatus>,
  removeLinearKey: () => window.ted.request('removeLinearKey') as Promise<LinearStatus>,
  lookupLinear: (url: string) => window.ted.request('lookupLinear', url) as Promise<LinearLookup>,
  openLinearKeyPage: () => window.ted.request('openLinearKeyPage') as Promise<void>,
  onEvent: (listener: (event: TedEvent) => void) => window.ted.onEvent(listener),
}

export function readableError(failure: unknown): string {
  const message = failure instanceof Error ? failure.message : String(failure)
  return message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '')
}
