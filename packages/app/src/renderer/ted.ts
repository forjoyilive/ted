import type { DaemonConnection } from '@ted/daemon/launch'
import type {
  AgentHealth,
  AgentKind,
  AgentStageId,
  AnswerAutomationRequest,
  AnswerRequest,
  AppLog,
  ArchiveDoneResult,
  ArchiveTaskRequest,
  Attachment,
  AttachmentBytes,
  AttachmentRef,
  Automation,
  AutomationDetail,
  AutomationPromptDraft,
  AutomationRequest,
  AutomationRun,
  AutomationSchedule,
  AutomationTemplate,
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
  Coordinator,
  CoordinatorMessage,
  CoordinatorStatus,
  CreateAutomationRequest,
  CreateFactoryRequest,
  CreateTaskRequest,
  DaemonEvent,
  DataStatus,
  DeleteTaskRequest,
  DescriptionVersion,
  Diagnostics,
  DraftAutomationPromptRequest,
  DraftLineCommentRequest,
  DriftCounts,
  EditAutomationRequest,
  EditTaskRequest,
  Factory,
  FactoryBoard,
  FactoryRemoval,
  FactorySettingsChanges,
  FactorySettingsView,
  FileDiff,
  FoundEditor,
  InboxItem,
  IntegrationsHealth,
  LibraryChanges,
  LibraryPreview,
  LibraryView,
  LinearLookup,
  LinearStatus,
  LineComment,
  LogText,
  MachineSettings,
  MoveTaskRequest,
  NewTaskDraft,
  OpenInEditorRequest,
  Plan,
  PlanDetail,
  PlanInboxItem,
  PlanRequest,
  Priority,
  Profile,
  RemoveClonesResult,
  RemoveFactoryRequest,
  RepoCheck,
  RepoRemoval,
  RestoreBackupResult,
  Run,
  RunChat,
  RunFixRequest,
  RunFixResult,
  RunMessage,
  RunSlots,
  RunSummary,
  SaveLibraryRequest,
  SaveSettingsRequest,
  SaveSettingsResult,
  SchedulePreview,
  SearchResults,
  SetTaskGatesRequest,
  SetTaskReposRequest,
  SettingsPreview,
  ShellOutput,
  ShellOutputQuery,
  ShellSize,
  SideChat,
  SimulatorSlots,
  StageEntry,
  StartPlanRequest,
  StorageSummary,
  Task,
  TaskApp,
  TaskBrief,
  TaskChanges,
  TaskDefaults,
  TaskDraftState,
  TaskGates,
  TaskLead,
  TaskReposResult,
  TaskShell,
  ThreadEvent,
  WaitingRequest,
} from '@ted/protocol'
import type { MenuCommand } from '../background.ts'
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

export const ted = {
  listTasks: () => window.ted.request('listTasks') as Promise<Task[]>,
  listComments: (taskId: string) =>
    window.ted.request('listComments', taskId) as Promise<Comment[]>,
  cancelMerge: (taskId: string, comment: string, attachments: AttachmentRef[] = []) =>
    window.ted.request('cancelMerge', taskId, comment, attachments) as Promise<Comment>,
  postComment: (taskId: string, body: string, attachments: AttachmentRef[] = []) =>
    window.ted.request('postComment', taskId, body, attachments) as Promise<Comment>,
  markCommentsRead: (taskId: string) =>
    window.ted.request('markCommentsRead', taskId) as Promise<{ read: number }>,
  listThreadEvents: (taskId: string) =>
    window.ted.request('listThreadEvents', taskId) as Promise<ThreadEvent[]>,
  listInbox: () => window.ted.request('listInbox') as Promise<InboxItem[]>,
  listWaiting: () => window.ted.request('listWaiting') as Promise<WaitingRequest[]>,
  getCoordinator: (id: string) =>
    window.ted.request('getCoordinator', id) as Promise<Coordinator | null>,
  getCoordinatorChat: (id: string) =>
    window.ted.request('getCoordinatorChat', id) as Promise<RunChat | null>,
  coordinatorStatuses: () =>
    window.ted.request('coordinatorStatuses') as Promise<CoordinatorStatus[]>,
  messageCoordinator: (id: string, input: CoordinatorMessage) =>
    window.ted.request('messageCoordinator', id, input) as Promise<Coordinator>,
  stopCoordinator: (id: string) =>
    window.ted.request('stopCoordinator', id) as Promise<Coordinator>,
  retryCoordinator: (id: string) =>
    window.ted.request('retryCoordinator', id) as Promise<Coordinator>,
  listPlans: (factory?: string) => window.ted.request('listPlans', factory) as Promise<Plan[]>,
  getPlan: (id: string) => window.ted.request('getPlan', id) as Promise<PlanDetail>,
  startPlan: (input: StartPlanRequest) => window.ted.request('startPlan', input) as Promise<Plan>,
  renamePlan: (id: string, title: string) =>
    window.ted.request('renamePlan', id, title) as Promise<Plan>,
  stopPlan: (id: string) => window.ted.request('stopPlan', id) as Promise<Plan>,
  retryPlan: (id: string) => window.ted.request('retryPlan', id) as Promise<Plan>,
  deletePlan: (id: string) => window.ted.request('deletePlan', id) as Promise<{ deleted: true }>,
  planInbox: () => window.ted.request('planInbox') as Promise<PlanInboxItem[]>,
  answerPlanRequest: (id: string, answer: AnswerRequest) =>
    window.ted.request('answerPlanRequest', id, answer) as Promise<PlanRequest>,
  listAnswered: () => window.ted.request('listAnswered') as Promise<InboxItem[]>,
  answerRequest: (commentId: string, answer: AnswerRequest) =>
    window.ted.request('answerRequest', commentId, answer) as Promise<Comment>,
  talkThrough: (commentId: string) =>
    window.ted.request('talkThrough', commentId) as Promise<Comment>,
  doneTalking: (commentId: string) =>
    window.ted.request('doneTalking', commentId) as Promise<Comment>,
  getRun: (runId: string) => window.ted.request('getRun', runId) as Promise<Run>,
  getSideChat: (id: string) => window.ted.request('getSideChat', id) as Promise<SideChat | null>,
  openSideChat: (id: string) => window.ted.request('openSideChat', id) as Promise<SideChat>,
  sendSideChat: (id: string, text: string) =>
    window.ted.request('sendSideChat', id, text) as Promise<SideChat>,
  stopSideChat: (id: string) => window.ted.request('stopSideChat', id) as Promise<SideChat>,
  retrySideChat: (id: string) => window.ted.request('retrySideChat', id) as Promise<SideChat>,
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
  taskBrief: (taskId: string) =>
    window.ted.request('taskBrief', taskId) as Promise<TaskBrief | null>,
  search: (query: string, factoryId?: string) =>
    window.ted.request('search', query, factoryId) as Promise<SearchResults>,
  taskGates: (taskId: string) => window.ted.request('taskGates', taskId) as Promise<TaskGates>,
  setTaskGates: (taskId: string, request: SetTaskGatesRequest) =>
    window.ted.request('setTaskGates', taskId, request) as Promise<TaskGates>,
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
  resumeTask: (taskId: string, comment?: string, attachments: AttachmentRef[] = []) =>
    window.ted.request('resumeTask', taskId, comment, attachments) as Promise<Task>,
  openTaskSource: (taskId: string) => window.ted.request('openTaskSource', taskId) as Promise<void>,
  moveTask: (taskId: string, request: MoveTaskRequest) =>
    window.ted.request('moveTask', taskId, request) as Promise<Task>,
  setPriority: (taskId: string, priority: Priority) =>
    window.ted.request('setPriority', taskId, priority) as Promise<Task>,
  archiveTask: (taskId: string, options: ArchiveTaskRequest = {}) =>
    window.ted.request('archiveTask', taskId, options) as Promise<Task>,
  unarchiveTask: (taskId: string) => window.ted.request('unarchiveTask', taskId) as Promise<Task>,
  allowLinearSync: (taskId: string) =>
    window.ted.request('allowLinearSync', taskId) as Promise<Task>,
  followUpTask: (taskId: string, comment?: string, attachments: AttachmentRef[] = []) =>
    window.ted.request('followUpTask', taskId, comment, attachments) as Promise<Task>,
  archiveDone: (factoryId: string) =>
    window.ted.request('archiveDone', factoryId) as Promise<ArchiveDoneResult>,
  deleteTask: (taskId: string, options: DeleteTaskRequest = {}) =>
    window.ted.request('deleteTask', taskId, options) as Promise<void>,
  openPullRequest: (taskId: string, repoName: string) =>
    window.ted.request('openPullRequest', taskId, repoName) as Promise<void>,
  openFigmaLink: (taskId: string, commentId: string) =>
    window.ted.request('openFigmaLink', taskId, commentId) as Promise<void>,
  blockTask: (taskId: string, by: string) =>
    window.ted.request('blockTask', taskId, by) as Promise<Task>,
  unblockTask: (taskId: string, by: string) =>
    window.ted.request('unblockTask', taskId, by) as Promise<Task>,
  getSlots: () => window.ted.request('getSlots') as Promise<RunSlots>,
  taskDraft: (factoryId: string) =>
    window.ted.request('taskDraft', factoryId) as Promise<TaskDraftState>,
  saveTaskDraft: (factoryId: string, draft: NewTaskDraft) =>
    window.ted.request('saveTaskDraft', factoryId, draft) as Promise<TaskDraftState>,
  taskDefaults: (factoryId: string) =>
    window.ted.request('taskDefaults', factoryId) as Promise<TaskDefaults>,
  factoryBoard: (factoryId: string) =>
    window.ted.request('factoryBoard', factoryId) as Promise<FactoryBoard>,
  uploadAttachment: (file: { name: string; mediaType: string }, bytes: Uint8Array) =>
    window.ted.request('uploadAttachment', file.name, file.mediaType, bytes) as Promise<Attachment>,
  readAttachment: (attachment: Pick<Attachment, 'hash' | 'name'>) =>
    window.ted.request(
      'readAttachment',
      attachment.hash,
      attachment.name,
    ) as Promise<AttachmentBytes>,
  setupLog: (taskId: string, repo: string) =>
    window.ted.request('setupLog', taskId, repo) as Promise<string>,
  openShell: (taskId: string, repo: string, size: ShellSize) =>
    window.ted.request('openShell', taskId, repo, size) as Promise<TaskShell>,
  restartShell: (taskId: string, repo: string, size: ShellSize) =>
    window.ted.request('restartShell', taskId, repo, size) as Promise<TaskShell>,
  writeShell: (taskId: string, repo: string, data: string) =>
    window.ted.request('writeShell', taskId, repo, data) as Promise<void>,
  resizeShell: (taskId: string, repo: string, size: ShellSize) =>
    window.ted.request('resizeShell', taskId, repo, size) as Promise<void>,
  readShell: (taskId: string, repo: string, query: ShellOutputQuery) =>
    window.ted.request('readShell', taskId, repo, query) as Promise<ShellOutput>,
  listEditors: () => window.ted.request('listEditors') as Promise<FoundEditor[]>,
  openInEditor: (taskId: string, repo: string, at?: OpenInEditorRequest) =>
    window.ted.request('openInEditor', taskId, repo, at) as Promise<void>,
  taskChanges: (taskId: string) =>
    window.ted.request('taskChanges', taskId) as Promise<TaskChanges>,
  fileDiffs: (taskId: string, repo: string, path?: string) =>
    window.ted.request('fileDiffs', taskId, repo, path) as Promise<FileDiff[]>,
  lineComments: (taskId: string) =>
    window.ted.request('lineComments', taskId) as Promise<LineComment[]>,
  draftLineComment: (taskId: string, request: DraftLineCommentRequest) =>
    window.ted.request('draftLineComment', taskId, request) as Promise<LineComment>,
  editLineComment: (id: string, body: string) =>
    window.ted.request('editLineComment', id, body) as Promise<LineComment>,
  deleteLineComment: (id: string) => window.ted.request('deleteLineComment', id) as Promise<void>,
  discardLineComments: (taskId: string) =>
    window.ted.request('discardLineComments', taskId) as Promise<void>,
  sendLineComments: (taskId: string) =>
    window.ted.request('sendLineComments', taskId) as Promise<Comment>,
  listApps: (taskId: string) => window.ted.request('listApps', taskId) as Promise<TaskApp[]>,
  startApp: (taskId: string, repo: string, name: string, shutDown?: string) =>
    window.ted.request('startApp', taskId, repo, name, shutDown) as Promise<TaskApp>,
  showApp: (taskId: string, repo: string, name: string) =>
    window.ted.request('showApp', taskId, repo, name) as Promise<TaskApp>,
  simulators: () => window.ted.request('simulators') as Promise<SimulatorSlots>,
  stopApp: (taskId: string, repo: string, name: string) =>
    window.ted.request('stopApp', taskId, repo, name) as Promise<TaskApp>,
  restartApp: (taskId: string, repo: string, name: string) =>
    window.ted.request('restartApp', taskId, repo, name) as Promise<TaskApp>,
  appLog: (taskId: string, repo: string, name: string) =>
    window.ted.request('appLog', taskId, repo, name) as Promise<AppLog>,
  openAppPreview: (taskId: string, repo: string, name: string) =>
    window.ted.request('openAppPreview', taskId, repo, name) as Promise<void>,
  openHostedPreview: (taskId: string, repo: string) =>
    window.ted.request('openHostedPreview', taskId, repo) as Promise<void>,
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
  library: () => window.ted.request('library') as Promise<LibraryView>,
  previewLibrary: (changes: LibraryChanges) =>
    window.ted.request('previewLibrary', changes) as Promise<LibraryPreview>,
  saveLibrary: (request: SaveLibraryRequest) =>
    window.ted.request('saveLibrary', request) as Promise<LibraryView>,
  drift: () => window.ted.request('drift') as Promise<DriftCounts>,
  mergeInherited: (factoryId: string, stage: AgentStageId) =>
    window.ted.request('mergeInherited', factoryId, stage) as Promise<Task>,
  tryCheck: (factoryId: string, request: CheckTryRequest) =>
    window.ted.request('tryCheck', factoryId, request) as Promise<CheckTry>,
  stopCheckTry: (factoryId: string, name: string) =>
    window.ted.request('stopCheckTry', factoryId, name) as Promise<void>,
  checkTryOutput: (factoryId: string, name: string) =>
    window.ted.request('checkTryOutput', factoryId, name) as Promise<CheckTryOutput>,
  setFactoryAutoStartBacklog: (factoryId: string, enabled: boolean) =>
    window.ted.request('setFactoryAutoStartBacklog', factoryId, enabled) as Promise<Factory>,
  renameFactory: (factoryId: string, name: string) =>
    window.ted.request('renameFactory', factoryId, name) as Promise<Factory>,
  reorderFactories: (factoryIds: string[]) =>
    window.ted.request('reorderFactories', factoryIds) as Promise<Factory[]>,
  newSetupTask: (factoryId: string) =>
    window.ted.request('newSetupTask', factoryId) as Promise<Task>,
  factoryRemoval: (factoryId: string) =>
    window.ted.request('factoryRemoval', factoryId) as Promise<FactoryRemoval>,
  removeFactory: (factoryId: string, request: RemoveFactoryRequest) =>
    window.ted.request('removeFactory', factoryId, request) as Promise<void>,
  repoRemoval: (factoryId: string, repoName: string) =>
    window.ted.request('repoRemoval', factoryId, repoName) as Promise<RepoRemoval>,
  showFactoryFolder: (factoryId: string) =>
    window.ted.request('showFactoryFolder', factoryId) as Promise<void>,
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
  notificationsOff: () => window.ted.request('notificationsOff') as Promise<boolean>,
  openNotificationSettings: () => window.ted.request('openNotificationSettings') as Promise<void>,
  connection: () => window.ted.request('connection') as Promise<DaemonConnection>,
  restartDaemon: () => window.ted.request('restartDaemon') as Promise<void>,
  updateStatus: () => window.ted.request('updateStatus') as Promise<UpdateStatus>,
  checkForUpdates: () => window.ted.request('checkForUpdates') as Promise<UpdateStatus>,
  restartToUpdate: () => window.ted.request('restartToUpdate') as Promise<void>,
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
  allowLinearTeam: (factoryId: string, team: string) =>
    window.ted.request('allowLinearTeam', factoryId, team) as Promise<MachineSettings>,
  openLinearKeyPage: () => window.ted.request('openLinearKeyPage') as Promise<void>,
  listAutomations: (factoryId?: string) =>
    window.ted.request('listAutomations', factoryId) as Promise<Automation[]>,
  getAutomation: (id: string) =>
    window.ted.request('getAutomation', id) as Promise<AutomationDetail>,
  draftAutomationPrompt: (input: DraftAutomationPromptRequest) =>
    window.ted.request('draftAutomationPrompt', input) as Promise<AutomationPromptDraft>,
  getAutomationPromptDraft: (id: string) =>
    window.ted.request('getAutomationPromptDraft', id) as Promise<AutomationPromptDraft>,
  cancelAutomationPromptDraft: (id: string) =>
    window.ted.request('cancelAutomationPromptDraft', id) as Promise<AutomationPromptDraft>,
  automationTemplates: () =>
    window.ted.request('automationTemplates') as Promise<AutomationTemplate[]>,
  automationRequests: () =>
    window.ted.request('automationRequests') as Promise<AutomationRequest[]>,
  previewSchedule: (schedule: AutomationSchedule) =>
    window.ted.request('previewSchedule', schedule) as Promise<SchedulePreview>,
  createAutomation: (input: CreateAutomationRequest) =>
    window.ted.request('createAutomation', input) as Promise<Automation>,
  editAutomation: (id: string, input: EditAutomationRequest) =>
    window.ted.request('editAutomation', id, input) as Promise<Automation>,
  setAutomationOn: (id: string, on: boolean) =>
    window.ted.request('setAutomationOn', id, on) as Promise<Automation>,
  runAutomation: (id: string) => window.ted.request('runAutomation', id) as Promise<AutomationRun>,
  retryAutomationRun: (runId: string) =>
    window.ted.request('retryAutomationRun', runId) as Promise<AutomationRun>,
  deleteAutomation: (id: string) =>
    window.ted.request('deleteAutomation', id) as Promise<{ deleted: boolean }>,
  answerAutomationRequest: (id: string, answer: AnswerAutomationRequest) =>
    window.ted.request('answerAutomationRequest', id, answer) as Promise<AutomationRequest>,
  onEvent: (listener: (event: TedEvent) => void) => window.ted.onEvent(listener),
}

export function readableError(failure: unknown): string {
  const message = failure instanceof Error ? failure.message : String(failure)
  return message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '')
}
