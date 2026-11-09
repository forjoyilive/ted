import { Agent, request as httpRequest, type IncomingMessage } from 'node:http'
import type { Activity, OpenAppResult } from './activity.ts'
import {
  bodyHash,
  daemonProof,
  equalHex,
  newNonce,
  responseMac,
  responseMacHeader,
  signRequest,
} from './app-auth.ts'
import type { Banner, BannerActionInput } from './banner.ts'
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
  RepoCheck,
} from './factory.ts'
import type {
  FactorySettingsChanges,
  FactorySettingsView,
  RenameFactoryRequest,
  SaveSettingsRequest,
  SaveSettingsResult,
  SettingsPreview,
} from './factory-settings.ts'
import type { AgentHealth } from './health.ts'
import type { IntegrationsHealth, RunFixRequest, RunFixResult } from './integrations.ts'
import type { LinearLookup, LinearStatus, SaveLinearKeyRequest } from './linear.ts'
import type {
  AgentKind,
  Run,
  RunWithConversation,
  StartDevRunRequest,
  StartSubAgentRequest,
  SubAgent,
  SubAgentWait,
} from './run.ts'
import type { MachineSettings, Profile } from './settings.ts'
import type { RunSlots } from './slots.ts'
import type { RemoveClonesResult, StorageSummary } from './storage.ts'
import type {
  AnswerRequest,
  ArchiveTaskRequest,
  Attachment,
  CancelMergeRequest,
  Comment,
  CreateTaskRequest,
  DeleteTaskRequest,
  DescriptionVersion,
  EditTaskRequest,
  InboxItem,
  MoveTaskRequest,
  OutcomeResult,
  PostCommentRequest,
  Priority,
  ReportOutcomeRequest,
  RepoSetupReport,
  ResumeTaskRequest,
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

  resumeTask(ref: string, comment?: string): Promise<Task> {
    const body: ResumeTaskRequest = comment === undefined ? {} : { comment }
    return this.#request('POST', `/tasks/${encodeURIComponent(ref)}/resume`, body)
  }

  cancelMerge(ref: string, comment: string): Promise<Comment> {
    const body: CancelMergeRequest = { comment }
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

  setPriority(ref: string, priority: Priority): Promise<Task> {
    const body: SetPriorityRequest = { priority }
    return this.#request('PUT', `/tasks/${encodeURIComponent(ref)}/priority`, body)
  }

  archiveTask(ref: string, options: ArchiveTaskRequest = {}): Promise<Task> {
    return this.#request('POST', `/tasks/${encodeURIComponent(ref)}/archive`, options)
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

  answerRequest(commentId: string, answer: AnswerRequest): Promise<Comment> {
    return this.#request('POST', `/comments/${encodeURIComponent(commentId)}/answer`, answer)
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

  async uploadAttachment(
    file: { name: string; mediaType: string },
    bytes: Uint8Array<ArrayBuffer>,
  ): Promise<Attachment> {
    const res = await this.#send('POST', '/attachments', bytes, undefined, {
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
          `the server on port ${this.#info.port} didn't prove it is TED's daemon`,
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
        req.destroy(new Error(`TED's daemon sent nothing for ${this.#idleTimeoutMs} ms`))
      })
      req.on('error', (error) => reject(unreachable(port, error)))
      req.end(payload)
    })
  }
}

function unreachable(port: number, cause: unknown): DaemonUnreachableError {
  return new DaemonUnreachableError(`can't reach TED's daemon on port ${port}`, { cause })
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
