import { Agent, request as httpRequest, type IncomingMessage } from 'node:http'
import type { Activity, OpenAppResult } from './activity.ts'
import type {
  AppCapture,
  AppLog,
  AppRef,
  RecordAppRequest,
  SimulatorSlots,
  StartAppRequest,
  TaskApp,
} from './app.ts'
import {
  bodyHash,
  daemonProof,
  equalHex,
  newNonce,
  responseMac,
  responseMacHeader,
  signRequest,
} from './app-auth.ts'
import type {
  AnswerAutomationRequest,
  Automation,
  AutomationDetail,
  AutomationRequest,
  AutomationRun,
  AutomationTemplate,
  CreateAutomationRequest,
  EditAutomationRequest,
  SchedulePreview,
} from './automation.ts'
import type { Banner, BannerActionInput } from './banner.ts'
import type { DraftLineCommentRequest, FileDiff, LineComment, TaskChanges } from './changes.ts'
import type { RunChat, RunMessage, RunSummary } from './chat.ts'
import type { CheckOutput, CheckRun, CheckRunReport, RunChecksRequest, SendBack } from './checks.ts'
import type { CommandLineStatus } from './command-line.ts'
import type { CallerInfo, DaemonInfo } from './daemon-info.ts'
import type {
  BackupsSummary,
  DataStatus,
  RestoreBackupRequest,
  RestoreBackupResult,
  ShutdownRequest,
} from './data.ts'
import type { Diagnostics, LogText } from './diagnostics.ts'
import type { DaemonEvent } from './events.ts'
import type {
  AddFactoryRequest,
  CheckRepoRequest,
  CreateFactoryRequest,
  Factory,
  FactoryRemoval,
  RemoveFactoryRequest,
  ReorderFactoriesRequest,
  RepoCheck,
  RepoRemoval,
} from './factory.ts'
import type {
  CheckTry,
  CheckTryOutput,
  CheckTryRequest,
  DriftCounts,
  FactorySettingsChanges,
  FactorySettingsView,
  LibraryChanges,
  LibraryPreview,
  LibraryView,
  RenameFactoryRequest,
  SaveLibraryRequest,
  SaveSettingsRequest,
  SaveSettingsResult,
  SettingsPreview,
} from './factory-settings.ts'
import type { AgentHealth } from './health.ts'
import type { IntegrationsHealth, RunFixRequest, RunFixResult } from './integrations.ts'
import type { LinearLookup, LinearStatus, SaveLinearKeyRequest } from './linear.ts'
import type { Plan, PlanDetail, PlanInboxItem, PlanRequest, StartPlanRequest } from './plan.ts'
import type {
  AgentKind,
  Run,
  RunWithConversation,
  StartDevRunRequest,
  StartSubAgentRequest,
  SubAgent,
  SubAgentWait,
} from './run.ts'
import type { AutomationSchedule } from './schedule.ts'
import type { SearchResults } from './search.ts'
import type { MachineSettings, Profile } from './settings.ts'
import type {
  FoundEditor,
  OpenInEditorRequest,
  ShellOutput,
  ShellOutputQuery,
  ShellSize,
  TaskShell,
} from './shell.ts'
import type { RunSlots } from './slots.ts'
import type { RemoveClonesResult, StorageSummary } from './storage.ts'
import type {
  AgentStageId,
  AnswerRequest,
  ArchiveDoneResult,
  ArchiveTaskRequest,
  Attachment,
  AttachmentBytes,
  AttachmentRef,
  CancelMergeRequest,
  CloseRoundRequest,
  Comment,
  CreateTaskRequest,
  DeleteTaskRequest,
  DescriptionVersion,
  EditTaskRequest,
  FollowUpRequest,
  InboxItem,
  MoveTaskRequest,
  OutcomeResult,
  PostCommentRequest,
  Priority,
  ProposalInput,
  ReportOutcomeRequest,
  RepoSetupReport,
  ResumeTaskRequest,
  RoundInput,
  SetClarifyDepthRequest,
  SetPriorityRequest,
  SetTaskLeadRequest,
  SetTaskReposRequest,
  Task,
  TaskBrief,
  TaskDefaults,
  TaskReposResult,
  ThreadEvent,
} from './task.ts'
import type { UpdateWork } from './update.ts'
import type { WaitingRequest } from './waiting.ts'
import type { FactoryBoard, StageEntry } from './workflow.ts'

export class DaemonUnreachableError extends Error {}

let sharedAgent: Agent | undefined
const agent = () => {
  sharedAgent ??= new Agent({ keepAlive: false })
  return sharedAgent
}

export class DaemonRequestError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export interface Subscription {
  close(): void
}

export class DaemonClient {
  readonly #info: DaemonInfo
  readonly #token: string
  readonly #appKey: string | undefined
  readonly #idleTimeoutMs: number

  constructor(
    info: DaemonInfo,
    token: string = info.token,
    { idleTimeoutMs = 300_000, appKey }: { idleTimeoutMs?: number; appKey?: string } = {},
  ) {
    this.#info = info
    this.#token = token
    this.#appKey = appKey
    this.#idleTimeoutMs = idleTimeoutMs
  }

  async provesAppKey(): Promise<boolean> {
    if (this.#appKey === undefined) return false
    const nonce = newNonce()
    const res = await this.#send('GET', '/caller', undefined, undefined, undefined, nonce)
    const { kind, proof } = (await this.#json(res)) as CallerInfo
    return (
      kind === 'app' &&
      proof !== undefined &&
      equalHex(proof, daemonProof(this.#appKey, nonce, this.#info.port))
    )
  }

  listAutomations(factory?: string): Promise<Automation[]> {
    return this.#request('GET', `/automations${factoryQuery(factory)}`)
  }

  getAutomation(ref: string, factory?: string): Promise<AutomationDetail> {
    return this.#request('GET', `/automations/${encodeURIComponent(ref)}${factoryQuery(factory)}`)
  }

  automationTemplates(): Promise<AutomationTemplate[]> {
    return this.#request('GET', '/automations/templates')
  }

  automationRequests(): Promise<AutomationRequest[]> {
    return this.#request('GET', '/automations/requests')
  }

  previewSchedule(schedule: AutomationSchedule, timeZone?: string): Promise<SchedulePreview> {
    return this.#request('POST', '/automations/schedule-preview', {
      schedule,
      ...(timeZone !== undefined && { timeZone }),
    })
  }

  createAutomation(input: CreateAutomationRequest): Promise<Automation> {
    return this.#request('POST', '/automations', input)
  }

  editAutomation(ref: string, input: EditAutomationRequest, factory?: string): Promise<Automation> {
    return this.#request(
      'PATCH',
      `/automations/${encodeURIComponent(ref)}${factoryQuery(factory)}`,
      input,
    )
  }

  setAutomationOn(ref: string, on: boolean, factory?: string): Promise<Automation> {
    const action = on ? 'enable' : 'disable'
    return this.#request(
      'POST',
      `/automations/${encodeURIComponent(ref)}/${action}${factoryQuery(factory)}`,
      {},
    )
  }

  runAutomation(ref: string, factory?: string): Promise<AutomationRun> {
    return this.#request(
      'POST',
      `/automations/${encodeURIComponent(ref)}/run${factoryQuery(factory)}`,
      {},
    )
  }

  retryAutomationRun(runId: string): Promise<AutomationRun> {
    return this.#request('POST', `/automation-runs/${encodeURIComponent(runId)}/retry`, {})
  }

  deleteAutomation(ref: string, factory?: string): Promise<{ deleted: boolean }> {
    return this.#request(
      'DELETE',
      `/automations/${encodeURIComponent(ref)}${factoryQuery(factory)}`,
    )
  }

  postAutomationComment(input: { body: string; choices?: string[] }): Promise<AutomationRequest> {
    return this.#request('POST', '/automation-runs/comments', input)
  }

  answerAutomationRequest(id: string, answer: AnswerAutomationRequest): Promise<AutomationRequest> {
    return this.#request('POST', `/automation-requests/${encodeURIComponent(id)}/answer`, answer)
  }

  listPlans(factory?: string): Promise<Plan[]> {
    return this.#request('GET', `/plans${factoryQuery(factory)}`)
  }

  getPlan(id: string): Promise<PlanDetail> {
    return this.#request('GET', `/plans/${encodeURIComponent(id)}`)
  }

  startPlan(input: StartPlanRequest): Promise<Plan> {
    return this.#request('POST', '/plans', input)
  }

  renamePlan(id: string, title: string): Promise<Plan> {
    return this.#request('PATCH', `/plans/${encodeURIComponent(id)}`, { title })
  }

  stopPlan(id: string): Promise<Plan> {
    return this.#request('POST', `/plans/${encodeURIComponent(id)}/stop`, {})
  }

  retryPlan(id: string): Promise<Plan> {
    return this.#request('POST', `/plans/${encodeURIComponent(id)}/retry`, {})
  }

  deletePlan(id: string): Promise<{ deleted: true }> {
    return this.#request('DELETE', `/plans/${encodeURIComponent(id)}`)
  }

  planInbox(): Promise<PlanInboxItem[]> {
    return this.#request('GET', '/plan-requests')
  }

  postPlanRequest(input: {
    round?: RoundInput
    proposal?: ProposalInput
    supersedes?: string
  }): Promise<PlanRequest> {
    return this.#request('POST', '/plan-runs/requests', input)
  }

  answerPlanRequest(id: string, answer: AnswerRequest): Promise<PlanRequest> {
    return this.#request('POST', `/plan-requests/${encodeURIComponent(id)}/answer`, answer)
  }

  listTasks(): Promise<Task[]> {
    return this.#request('GET', '/tasks')
  }

  createTask(input: CreateTaskRequest): Promise<Task> {
    return this.#request('POST', '/tasks', input)
  }

  startTask(ref: string): Promise<Task> {
    return this.#request('POST', `/tasks/${encodeURIComponent(ref)}/start`)
  }

  blockTask(ref: string, by: string): Promise<Task> {
    return this.#request('POST', `/tasks/${encodeURIComponent(ref)}/blockers`, { by })
  }

  unblockTask(ref: string, by?: string): Promise<Task> {
    const route = `/tasks/${encodeURIComponent(ref)}/blockers`
    return this.#request('DELETE', by === undefined ? route : `${route}/${encodeURIComponent(by)}`)
  }

  setTaskLead(ref: string, lead: SetTaskLeadRequest): Promise<Task> {
    return this.#request('PUT', `/tasks/${encodeURIComponent(ref)}/lead`, lead)
  }

  setClarifyDepth(ref: string, request: SetClarifyDepthRequest): Promise<Task> {
    return this.#request('PUT', `/tasks/${encodeURIComponent(ref)}/clarify-depth`, request)
  }

  useDefaultModel(ref: string): Promise<Task> {
    return this.#request('POST', `/tasks/${encodeURIComponent(ref)}/lead/use-default-model`)
  }

  moveToBacklog(ref: string): Promise<Task> {
    return this.#request('POST', `/tasks/${encodeURIComponent(ref)}/backlog`)
  }

  stopTask(ref: string): Promise<Task> {
    return this.#request('POST', `/tasks/${encodeURIComponent(ref)}/stop`)
  }

  resumeTask(ref: string, comment?: string, attachments?: AttachmentRef[]): Promise<Task> {
    const body: ResumeTaskRequest = {
      ...(comment !== undefined && { comment }),
      ...(attachments !== undefined && attachments.length > 0 && { attachments }),
    }
    return this.#request('POST', `/tasks/${encodeURIComponent(ref)}/resume`, body)
  }

  cancelMerge(ref: string, comment: string, attachments?: AttachmentRef[]): Promise<Comment> {
    const body: CancelMergeRequest = {
      comment,
      ...(attachments !== undefined && attachments.length > 0 && { attachments }),
    }
    return this.#request('POST', `/tasks/${encodeURIComponent(ref)}/cancel-merge`, body)
  }

  moveTask(ref: string, request: MoveTaskRequest): Promise<Task> {
    return this.#request('POST', `/tasks/${encodeURIComponent(ref)}/move`, request)
  }

  editTask(ref: string, request: EditTaskRequest): Promise<Task> {
    return this.#request('PUT', `/tasks/${encodeURIComponent(ref)}`, request)
  }

  taskDescriptions(ref: string): Promise<DescriptionVersion[]> {
    return this.#request('GET', `/tasks/${encodeURIComponent(ref)}/descriptions`)
  }

  search(query: string, factoryId?: string): Promise<SearchResults> {
    const params = new URLSearchParams({ q: query })
    if (factoryId !== undefined) params.set('factory', factoryId)
    return this.#request('GET', `/search?${params}`)
  }

  setPriority(ref: string, priority: Priority): Promise<Task> {
    const body: SetPriorityRequest = { priority }
    return this.#request('PUT', `/tasks/${encodeURIComponent(ref)}/priority`, body)
  }

  archiveTask(ref: string, options: ArchiveTaskRequest = {}): Promise<Task> {
    return this.#request('POST', `/tasks/${encodeURIComponent(ref)}/archive`, options)
  }

  followUpTask(ref: string, comment?: string, attachments?: AttachmentRef[]): Promise<Task> {
    const body: FollowUpRequest = {
      ...(comment !== undefined && { comment }),
      ...(attachments !== undefined && attachments.length > 0 && { attachments }),
    }
    return this.#request('POST', `/tasks/${encodeURIComponent(ref)}/follow-up`, body)
  }

  archiveDone(factory: string): Promise<ArchiveDoneResult> {
    return this.#request('POST', `/factories/${encodeURIComponent(factory)}/archive-done`, {})
  }

  allowLinearSync(ref: string): Promise<Task> {
    return this.#request('POST', `/tasks/${encodeURIComponent(ref)}/linear-sync`)
  }

  unarchiveTask(ref: string): Promise<Task> {
    return this.#request('POST', `/tasks/${encodeURIComponent(ref)}/unarchive`, {})
  }

  async deleteTask(ref: string, options: DeleteTaskRequest = {}): Promise<void> {
    await this.#request('POST', `/tasks/${encodeURIComponent(ref)}/delete`, options)
  }

  getSlots(): Promise<RunSlots> {
    return this.#request('GET', '/slots')
  }

  listComments(ref: string): Promise<Comment[]> {
    return this.#request('GET', `/tasks/${encodeURIComponent(ref)}/comments`)
  }

  listStageEntries(ref: string): Promise<StageEntry[]> {
    return this.#request('GET', `/tasks/${encodeURIComponent(ref)}/stage-entries`)
  }

  runChecks(ref: string, request: RunChecksRequest = {}): Promise<CheckRun> {
    return this.#request('POST', `/tasks/${encodeURIComponent(ref)}/checks`, request)
  }

  getCheckRun(id: string): Promise<CheckRunReport> {
    return this.#request('GET', `/check-runs/${encodeURIComponent(id)}`)
  }

  listCheckRuns(ref: string): Promise<CheckRun[]> {
    return this.#request('GET', `/tasks/${encodeURIComponent(ref)}/check-runs`)
  }

  checkOutput(id: string, index: number): Promise<CheckOutput> {
    return this.#request('GET', `/check-runs/${encodeURIComponent(id)}/checks/${index}/output`)
  }

  listSendBacks(ref: string): Promise<SendBack[]> {
    return this.#request('GET', `/tasks/${encodeURIComponent(ref)}/send-backs`)
  }

  listThreadEvents(ref: string): Promise<ThreadEvent[]> {
    return this.#request('GET', `/tasks/${encodeURIComponent(ref)}/events`)
  }

  markCommentsRead(ref: string): Promise<{ read: number }> {
    return this.#request('POST', `/tasks/${encodeURIComponent(ref)}/read`)
  }

  postComment(ref: string, comment: string | PostCommentRequest): Promise<Comment> {
    const body = typeof comment === 'string' ? { body: comment } : comment
    return this.#request('POST', `/tasks/${encodeURIComponent(ref)}/comments`, body)
  }

  listInbox(): Promise<InboxItem[]> {
    return this.#request('GET', '/inbox')
  }

  listAnswered(): Promise<InboxItem[]> {
    return this.#request('GET', '/inbox/answered')
  }

  listWaiting(): Promise<WaitingRequest[]> {
    return this.#request('GET', '/inbox/waiting')
  }

  answerRequest(commentId: string, answer: AnswerRequest): Promise<Comment> {
    return this.#request('POST', `/comments/${encodeURIComponent(commentId)}/answer`, answer)
  }

  talkThrough(commentId: string): Promise<Comment> {
    return this.#request('POST', `/comments/${encodeURIComponent(commentId)}/talk`)
  }

  doneTalking(commentId: string): Promise<Comment> {
    return this.#request('POST', `/comments/${encodeURIComponent(commentId)}/done-talking`)
  }

  closeRound(ref: string, request: CloseRoundRequest): Promise<Comment> {
    return this.#request('POST', `/tasks/${encodeURIComponent(ref)}/rounds/close`, request)
  }

  writeBrief(ref: string, text: string): Promise<TaskBrief> {
    return this.#request('POST', `/tasks/${encodeURIComponent(ref)}/brief`, { text })
  }

  getBrief(ref: string): Promise<TaskBrief> {
    return this.#request('GET', `/tasks/${encodeURIComponent(ref)}/brief`)
  }

  setActivity(ref: string, text: string): Promise<Task> {
    return this.#request('POST', `/tasks/${encodeURIComponent(ref)}/activity`, { text })
  }

  reportOutcome(ref: string, outcome: ReportOutcomeRequest): Promise<OutcomeResult> {
    return this.#request('POST', `/tasks/${encodeURIComponent(ref)}/outcome`, outcome)
  }

  listFactories(): Promise<Factory[]> {
    return this.#request('GET', '/factories')
  }

  factoryBoard(factoryId: string): Promise<FactoryBoard> {
    return this.#request('GET', `/factories/${encodeURIComponent(factoryId)}/board`)
  }

  taskDefaults(factoryId: string): Promise<TaskDefaults> {
    return this.#request('GET', `/factories/${encodeURIComponent(factoryId)}/task-defaults`)
  }

  uploadAttachment(
    file: { name: string; mediaType: string },
    bytes: Uint8Array<ArrayBuffer>,
  ): Promise<Attachment> {
    return this.#upload('/attachments', file, bytes)
  }

  uploadTaskAttachment(
    ref: string,
    file: { name: string; mediaType: string },
    bytes: Uint8Array<ArrayBuffer>,
  ): Promise<Attachment> {
    return this.#upload(`/tasks/${encodeURIComponent(ref)}/attachments`, file, bytes)
  }

  readAttachment(attachment: Pick<Attachment, 'hash' | 'name'>): Promise<AttachmentBytes> {
    return this.#request(
      'GET',
      `/attachments/${encodeURIComponent(attachment.hash)}/${encodeURIComponent(attachment.name)}`,
    )
  }

  async #upload(
    route: string,
    file: { name: string; mediaType: string },
    bytes: Uint8Array<ArrayBuffer>,
  ): Promise<Attachment> {
    const res = await this.#send('POST', route, bytes, undefined, {
      'content-type': file.mediaType || 'application/octet-stream',
      'x-ted-name': encodeURIComponent(file.name),
    })
    return (await this.#json(res)) as Attachment
  }

  setLocalFolder(key: string, path: string): Promise<Factory> {
    return this.#request('PUT', `/factories/${encodeURIComponent(key)}/local-folder`, { path })
  }

  setTaskRepos(ref: string, request: SetTaskReposRequest): Promise<TaskReposResult> {
    return this.#request('PUT', `/tasks/${encodeURIComponent(ref)}/repos`, request)
  }

  repoSetup(ref: string, repo: string): Promise<RepoSetupReport> {
    return this.#request(
      'GET',
      `/tasks/${encodeURIComponent(ref)}/repos/${encodeURIComponent(repo)}/setup`,
    )
  }

  openShell(ref: string, repo: string, size: ShellSize): Promise<TaskShell> {
    return this.#request('POST', shellRoute(ref, repo), size)
  }

  restartShell(ref: string, repo: string, size: ShellSize): Promise<TaskShell> {
    return this.#request('POST', shellRoute(ref, repo, '/restart'), size)
  }

  async writeShell(ref: string, repo: string, data: string): Promise<void> {
    await this.#request('POST', shellRoute(ref, repo, '/input'), { data })
  }

  async resizeShell(ref: string, repo: string, size: ShellSize): Promise<void> {
    await this.#request('POST', shellRoute(ref, repo, '/resize'), size)
  }

  readShell(ref: string, repo: string, query: ShellOutputQuery): Promise<ShellOutput> {
    const params = new URLSearchParams({
      generation: String(query.generation),
      from: String(query.from),
      waitMs: String(query.waitMs ?? 0),
    })
    return this.#request('GET', shellRoute(ref, repo, `/output?${params}`))
  }

  listEditors(): Promise<FoundEditor[]> {
    return this.#request('GET', '/editors')
  }

  async openInEditor(ref: string, repo: string, request: OpenInEditorRequest = {}): Promise<void> {
    await this.#request(
      'POST',
      `/tasks/${encodeURIComponent(ref)}/repos/${encodeURIComponent(repo)}/open-in-editor`,
      request,
    )
  }

  taskChanges(ref: string): Promise<TaskChanges> {
    return this.#request('GET', `/tasks/${encodeURIComponent(ref)}/changes`)
  }

  fileDiffs(ref: string, repo: string, path?: string): Promise<FileDiff[]> {
    const query = path === undefined ? '' : `?${new URLSearchParams({ path })}`
    return this.#request(
      'GET',
      `/tasks/${encodeURIComponent(ref)}/changes/${encodeURIComponent(repo)}/diffs${query}`,
    )
  }

  lineComments(ref: string): Promise<LineComment[]> {
    return this.#request('GET', `/tasks/${encodeURIComponent(ref)}/line-comments`)
  }

  draftLineComment(ref: string, request: DraftLineCommentRequest): Promise<LineComment> {
    return this.#request('POST', `/tasks/${encodeURIComponent(ref)}/line-comments`, request)
  }

  editLineComment(id: string, body: string): Promise<LineComment> {
    return this.#request('PATCH', `/line-comments/${encodeURIComponent(id)}`, { body })
  }

  deleteLineComment(id: string): Promise<void> {
    return this.#request('DELETE', `/line-comments/${encodeURIComponent(id)}`)
  }

  discardLineComments(ref: string): Promise<void> {
    return this.#request('DELETE', `/tasks/${encodeURIComponent(ref)}/line-comments`)
  }

  sendLineComments(ref: string): Promise<Comment> {
    return this.#request('POST', `/tasks/${encodeURIComponent(ref)}/line-comments/send`)
  }

  listApps(ref: string): Promise<TaskApp[]> {
    return this.#request('GET', `/tasks/${encodeURIComponent(ref)}/apps`)
  }

  startApp(ref: string, app: StartAppRequest): Promise<TaskApp> {
    return this.#request('POST', `/tasks/${encodeURIComponent(ref)}/apps/start`, app)
  }

  stopApp(ref: string, app: AppRef): Promise<TaskApp> {
    return this.#request('POST', `/tasks/${encodeURIComponent(ref)}/apps/stop`, app)
  }

  restartApp(ref: string, app: AppRef): Promise<TaskApp> {
    return this.#request('POST', `/tasks/${encodeURIComponent(ref)}/apps/restart`, app)
  }

  showApp(ref: string, app: AppRef): Promise<TaskApp> {
    return this.#request('POST', `/tasks/${encodeURIComponent(ref)}/apps/show`, app)
  }

  screenshotApp(ref: string, app: AppRef): Promise<AppCapture> {
    return this.#request('POST', `/tasks/${encodeURIComponent(ref)}/apps/screenshot`, app)
  }

  recordApp(ref: string, request: RecordAppRequest): Promise<AppCapture> {
    return this.#request('POST', `/tasks/${encodeURIComponent(ref)}/apps/record`, request)
  }

  simulators(): Promise<SimulatorSlots> {
    return this.#request('GET', '/simulators')
  }

  appLog(ref: string, app: { repo: string; name: string }): Promise<AppLog> {
    return this.#request(
      'GET',
      `/tasks/${encodeURIComponent(ref)}/apps/${encodeURIComponent(app.repo)}/${encodeURIComponent(app.name)}/log`,
    )
  }

  async setupLog(ref: string, repo: string): Promise<string> {
    const { text } = await this.#request<{ text: string }>(
      'GET',
      `/tasks/${encodeURIComponent(ref)}/repos/${encodeURIComponent(repo)}/setup-log`,
    )
    return text
  }

  getSettings(): Promise<MachineSettings> {
    return this.#request('GET', '/settings')
  }

  updateSettings(changes: Partial<MachineSettings>): Promise<MachineSettings> {
    return this.#request('PATCH', '/settings', changes)
  }

  getProfile(): Promise<Profile> {
    return this.#request('GET', '/profile')
  }

  getDiagnostics(): Promise<Diagnostics> {
    return this.#request('GET', '/diagnostics')
  }

  getReport(): Promise<{ text: string }> {
    return this.#request('GET', '/diagnostics/report')
  }

  readDaemonLog(): Promise<LogText> {
    return this.#request('GET', '/logs/daemon')
  }

  readRunOutput(id: string): Promise<LogText> {
    return this.#request('GET', `/runs/${encodeURIComponent(id)}/raw`)
  }

  listBanners(): Promise<Banner[]> {
    return this.#request('GET', '/banners')
  }

  dismissBanner(id: string): Promise<Banner> {
    return this.#request('POST', `/banners/${encodeURIComponent(id)}/dismiss`)
  }

  actOnBanner(id: string, input?: BannerActionInput): Promise<void> {
    return this.#request('POST', `/banners/${encodeURIComponent(id)}/action`, input)
  }

  agentHealth(): Promise<AgentHealth[]> {
    return this.#request('GET', '/agents/health')
  }

  checkAgentHealth(): Promise<AgentHealth[]> {
    return this.#request('POST', '/agents/health/check')
  }

  fixAgent(agent: AgentKind): Promise<AgentHealth> {
    return this.#request('POST', `/agents/${encodeURIComponent(agent)}/fix`)
  }

  getIntegrations(): Promise<IntegrationsHealth> {
    return this.#request('GET', '/integrations')
  }

  checkIntegrations(): Promise<IntegrationsHealth> {
    return this.#request('POST', '/integrations/check')
  }

  runFix(input: RunFixRequest): Promise<RunFixResult> {
    return this.#request('POST', '/integrations/fix', input)
  }

  getLinear(): Promise<LinearStatus> {
    return this.#request('GET', '/integrations/linear')
  }

  saveLinearKey(input: SaveLinearKeyRequest): Promise<LinearStatus> {
    return this.#request('PUT', '/integrations/linear/key', input)
  }

  testLinear(): Promise<LinearStatus> {
    return this.#request('POST', '/integrations/linear/test')
  }

  removeLinearKey(): Promise<LinearStatus> {
    return this.#request('DELETE', '/integrations/linear/key')
  }

  lookupLinear(url: string): Promise<LinearLookup> {
    return this.#request('POST', '/integrations/linear/lookup', { url })
  }

  getActivity(): Promise<Activity> {
    return this.#request('GET', '/activity')
  }

  updateWork(): Promise<UpdateWork> {
    return this.#request('GET', '/update/work')
  }

  shutdown(request: ShutdownRequest = {}): Promise<void> {
    return this.#request('POST', '/shutdown', request)
  }

  caller(): Promise<CallerInfo> {
    return this.#request('GET', '/caller')
  }

  getCommandLine(): Promise<CommandLineStatus> {
    return this.#request('GET', '/command-line')
  }

  installCommandLine(): Promise<CommandLineStatus> {
    return this.#request('POST', '/command-line/install')
  }

  openApp(): Promise<OpenAppResult> {
    return this.#request('POST', '/app/open')
  }

  checkRepo(input: CheckRepoRequest): Promise<RepoCheck> {
    return this.#request('POST', '/factories/check-repo', input)
  }

  createFactory(input: CreateFactoryRequest): Promise<Factory> {
    return this.#request('POST', '/factories', input)
  }

  factorySettings(factoryId: string): Promise<FactorySettingsView> {
    return this.#request('GET', `/factories/${encodeURIComponent(factoryId)}/settings`)
  }

  previewFactorySettings(
    factoryId: string,
    changes: FactorySettingsChanges,
  ): Promise<SettingsPreview> {
    return this.#request(
      'POST',
      `/factories/${encodeURIComponent(factoryId)}/settings/preview`,
      changes,
    )
  }

  saveFactorySettings(
    factoryId: string,
    request: SaveSettingsRequest,
  ): Promise<SaveSettingsResult> {
    return this.#request(
      'POST',
      `/factories/${encodeURIComponent(factoryId)}/settings/save`,
      request,
    )
  }

  library(): Promise<LibraryView> {
    return this.#request('GET', '/library')
  }

  previewLibrary(changes: LibraryChanges): Promise<LibraryPreview> {
    return this.#request('POST', '/library/preview', changes)
  }

  saveLibrary(request: SaveLibraryRequest): Promise<LibraryView> {
    return this.#request('POST', '/library/save', request)
  }

  drift(): Promise<DriftCounts> {
    return this.#request('GET', '/drift')
  }

  mergeInherited(factoryId: string, stage: AgentStageId): Promise<Task> {
    return this.#request(
      'POST',
      `/factories/${encodeURIComponent(factoryId)}/stages/${encodeURIComponent(stage)}/merge-inherited`,
    )
  }

  tryCheck(factoryId: string, request: CheckTryRequest): Promise<CheckTry> {
    return this.#request('POST', `/factories/${encodeURIComponent(factoryId)}/checks/try`, request)
  }

  stopCheckTry(factoryId: string, name: string): Promise<void> {
    return this.#request('POST', `/factories/${encodeURIComponent(factoryId)}/checks/try/stop`, {
      name,
    })
  }

  checkTryOutput(factoryId: string, name: string): Promise<CheckTryOutput> {
    return this.#request(
      'GET',
      `/factories/${encodeURIComponent(factoryId)}/checks/try/output?name=${encodeURIComponent(name)}`,
    )
  }

  renameFactory(factoryId: string, name: string): Promise<Factory> {
    return this.#request('PUT', `/factories/${encodeURIComponent(factoryId)}/name`, {
      name,
    } satisfies RenameFactoryRequest)
  }

  setRepoLocalFolder(factoryId: string, repoName: string, path: string): Promise<Factory> {
    return this.#request(
      'PUT',
      `/factories/${encodeURIComponent(factoryId)}/repos/${encodeURIComponent(repoName)}/local-folder`,
      { path },
    )
  }

  clearRepoLocalFolder(factoryId: string, repoName: string): Promise<Factory> {
    return this.#request(
      'DELETE',
      `/factories/${encodeURIComponent(factoryId)}/repos/${encodeURIComponent(repoName)}/local-folder`,
    )
  }

  reorderFactories(factoryIds: string[]): Promise<Factory[]> {
    return this.#request('PUT', '/factories/order', {
      factoryIds,
    } satisfies ReorderFactoriesRequest)
  }

  newSetupTask(factoryId: string): Promise<Task> {
    return this.#request('POST', `/factories/${encodeURIComponent(factoryId)}/setup-task`)
  }

  factoryRemoval(factoryId: string): Promise<FactoryRemoval> {
    return this.#request('GET', `/factories/${encodeURIComponent(factoryId)}/removal`)
  }

  removeFactory(factoryId: string, request: RemoveFactoryRequest): Promise<void> {
    return this.#request('POST', `/factories/${encodeURIComponent(factoryId)}/remove`, request)
  }

  repoRemoval(factoryId: string, repoName: string): Promise<RepoRemoval> {
    return this.#request(
      'GET',
      `/factories/${encodeURIComponent(factoryId)}/repos/${encodeURIComponent(repoName)}/removal`,
    )
  }

  retryClone(factoryId: string): Promise<Factory> {
    return this.#request('POST', `/factories/${encodeURIComponent(factoryId)}/retry-clone`)
  }

  addFactory(input: AddFactoryRequest): Promise<Factory> {
    return this.#request('POST', '/dev/factories', input)
  }

  startDevRun(input: StartDevRunRequest): Promise<Run> {
    return this.#request('POST', '/dev/runs', input)
  }

  getRun(id: string): Promise<RunWithConversation> {
    return this.#request('GET', `/runs/${encodeURIComponent(id)}`)
  }

  getRunChat(id: string): Promise<RunChat> {
    return this.#request('GET', `/runs/${encodeURIComponent(id)}/chat`)
  }

  sendRunMessage(
    id: string,
    text: string,
    { interrupt = false }: { interrupt?: boolean } = {},
  ): Promise<RunMessage> {
    return this.#request('POST', `/runs/${encodeURIComponent(id)}/messages`, {
      text,
      ...(interrupt && { interrupt }),
    })
  }

  interruptRun(id: string): Promise<RunSummary> {
    return this.#request('POST', `/runs/${encodeURIComponent(id)}/interrupt`)
  }

  sendQueuedMessageNow(runId: string, messageId: string): Promise<RunMessage> {
    return this.#request(
      'POST',
      `/runs/${encodeURIComponent(runId)}/messages/${encodeURIComponent(messageId)}/send-now`,
    )
  }

  deleteQueuedMessage(runId: string, messageId: string): Promise<RunMessage> {
    return this.#request(
      'DELETE',
      `/runs/${encodeURIComponent(runId)}/messages/${encodeURIComponent(messageId)}`,
    )
  }

  reachedBoundary(runId: string): Promise<{ delivered: number }> {
    return this.#request('POST', `/runs/${encodeURIComponent(runId)}/boundary`)
  }

  restartRun(id: string): Promise<RunSummary> {
    return this.#request('POST', `/runs/${encodeURIComponent(id)}/restart`)
  }

  stopRun(id: string): Promise<RunSummary> {
    return this.#request('POST', `/runs/${encodeURIComponent(id)}/stop`)
  }

  startSubAgent(ref: string, input: StartSubAgentRequest): Promise<SubAgent> {
    return this.#request('POST', `/tasks/${encodeURIComponent(ref)}/sub-agents`, input)
  }

  waitForSubAgent(id: string, timeoutMs?: number): Promise<SubAgentWait> {
    const query = timeoutMs === undefined ? '' : `?timeoutMs=${Math.round(timeoutMs)}`
    return this.#request('GET', `/sub-agents/${encodeURIComponent(id)}/wait${query}`)
  }

  sendSubAgent(id: string, text: string): Promise<SubAgent> {
    return this.#request('POST', `/sub-agents/${encodeURIComponent(id)}/messages`, { text })
  }

  stopSubAgent(id: string): Promise<SubAgent> {
    return this.#request('POST', `/sub-agents/${encodeURIComponent(id)}/stop`)
  }

  listTaskRuns(ref: string): Promise<RunSummary[]> {
    return this.#request('GET', `/tasks/${encodeURIComponent(ref)}/runs`)
  }

  openRunTab(ref: string, runId: string): Promise<Task> {
    return this.#request(
      'PUT',
      `/tasks/${encodeURIComponent(ref)}/tabs/${encodeURIComponent(runId)}`,
    )
  }

  closeRunTab(ref: string, runId: string): Promise<Task> {
    return this.#request(
      'DELETE',
      `/tasks/${encodeURIComponent(ref)}/tabs/${encodeURIComponent(runId)}`,
    )
  }

  getDataStatus(): Promise<DataStatus> {
    return this.#request('GET', '/data-status')
  }

  getStorage(): Promise<StorageSummary> {
    return this.#request('GET', '/storage')
  }

  removeUnusedClones(): Promise<RemoveClonesResult> {
    return this.#request('POST', '/storage/remove-clones')
  }

  listBackups(): Promise<BackupsSummary> {
    return this.#request('GET', '/backups')
  }

  restoreBackup(input: RestoreBackupRequest): Promise<RestoreBackupResult> {
    return this.#request('POST', '/backups/restore', input)
  }

  async subscribe(
    onEvent: (event: DaemonEvent) => void,
    { app = false, onClose }: { app?: boolean; onClose?: () => void } = {},
  ): Promise<Subscription> {
    const controller = new AbortController()
    const route = app ? '/events?app=1' : '/events'
    const res = await this.#send('GET', route, undefined, controller.signal)
    if (!isOk(res)) throw await requestError(res, this.#info.port)
    res.setEncoding('utf8')

    const ready = Promise.withResolvers<void>()
    let opened = false
    let buffer = ''
    res.on('data', (chunk: string) => {
      try {
        buffer = dispatch(buffer + chunk, onEvent, () => {
          opened = true
          ready.resolve()
        })
      } catch (error) {
        ready.reject(error)
        res.destroy()
      }
    })
    res.on('error', () => undefined)
    res.on('close', () => {
      ready.reject(new DaemonUnreachableError('the daemon closed the event stream'))
      if (opened && !controller.signal.aborted) onClose?.()
    })
    await ready.promise

    return { close: () => controller.abort() }
  }

  async #request<T>(method: string, route: string, body?: unknown): Promise<T> {
    return (await this.#json(await this.#send(method, route, body))) as T
  }

  async #json(res: IncomingMessage): Promise<unknown> {
    const text = await readText(res, this.#info.port)
    const nonce = sentNonces.get(res)
    if (this.#appKey !== undefined) {
      const given = res.headers[responseMacHeader]
      const expected = responseMac(this.#appKey, nonce ?? '', res.statusCode ?? 0, bodyHash(text))
      if (typeof given !== 'string' || !equalHex(given, expected)) {
        throw new DaemonRequestError(
          res.statusCode ?? 0,
          `the server on port ${this.#info.port} didn’t prove it is TED’s daemon`,
        )
      }
    }
    if (!isOk(res)) throw errorFrom(res.statusCode ?? 0, text)
    return JSON.parse(text)
  }

  #send(
    method: string,
    route: string,
    body?: unknown,
    signal?: AbortSignal,
    rawHeaders?: Record<string, string>,
    nonce?: string,
  ): Promise<IncomingMessage> {
    const port = this.#info.port
    const sent = nonce ?? newNonce()
    const raw = body instanceof Uint8Array
    const payload =
      body === undefined ? undefined : raw ? (body as Uint8Array) : JSON.stringify(body)
    return new Promise((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port,
        path: route,
        method,
        agent: agent(),
        timeout: this.#idleTimeoutMs,
        headers: {
          ...(this.#appKey === undefined
            ? { authorization: `Bearer ${this.#token}` }
            : signRequest(this.#appKey, method, route, payload, sent)),
          ...(payload !== undefined && !raw && { 'content-type': 'application/json' }),
          ...(payload !== undefined && { 'content-length': Buffer.byteLength(payload) }),
          ...rawHeaders,
        },
        ...(signal && { signal }),
      })
      req.on('response', (res) => {
        sentNonces.set(res, sent)
        resolve(res)
      })
      req.on('timeout', () => {
        req.destroy(new Error(`TED’s daemon sent nothing for ${this.#idleTimeoutMs} ms`))
      })
      req.on('error', (error) => reject(unreachable(port, error)))
      req.end(payload)
    })
  }
}

function unreachable(port: number, cause: unknown): DaemonUnreachableError {
  return new DaemonUnreachableError(`can’t reach TED’s daemon on port ${port}`, { cause })
}

function isOk(res: IncomingMessage): boolean {
  const status = res.statusCode ?? 0
  return status >= 200 && status < 300
}

async function readText(res: IncomingMessage, port: number): Promise<string> {
  res.setEncoding('utf8')
  let text = ''
  try {
    for await (const chunk of res) text += chunk
  } catch (error) {
    throw unreachable(port, error)
  }
  return text
}

function errorFrom(status: number, text: string): DaemonRequestError {
  let error: string | undefined
  try {
    error = (JSON.parse(text) as { error?: string }).error
  } catch {}
  return new DaemonRequestError(status, error ?? `HTTP ${status}`)
}

const sentNonces = new WeakMap<IncomingMessage, string>()

async function requestError(res: IncomingMessage, port: number): Promise<DaemonRequestError> {
  const status = res.statusCode ?? 0
  const payload = await readText(res, port)
    .then((text) => JSON.parse(text) as { error?: string })
    .catch(() => ({}) as { error?: string })
  return new DaemonRequestError(status, payload.error ?? `HTTP ${status}`)
}
function dispatch(
  buffer: string,
  onEvent: (event: DaemonEvent) => void,
  onReady: () => void,
): string {
  const messages = buffer.split('\n\n')
  const rest = messages.pop() ?? ''
  for (const message of messages) {
    const lines = message.split('\n')
    if (lines.includes('event: ready')) {
      onReady()
      continue
    }
    const data = lines
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice('data: '.length))
      .join('\n')
    if (data !== '') onEvent(JSON.parse(data) as DaemonEvent)
  }
  return rest
}

function factoryQuery(factory: string | undefined): string {
  return factory === undefined ? '' : `?factory=${encodeURIComponent(factory)}`
}

function shellRoute(ref: string, repo: string, rest = ''): string {
  return `/tasks/${encodeURIComponent(ref)}/repos/${encodeURIComponent(repo)}/shell${rest}`
}
