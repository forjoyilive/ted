import type { Activity, OpenAppResult } from './activity.ts'
import type { Banner, BannerActionInput } from './banner.ts'
import type { DaemonInfo } from './daemon-info.ts'
import type {
  BackupsSummary,
  DataStatus,
  RestoreBackupRequest,
  RestoreBackupResult,
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
import type { AgentHealth } from './health.ts'
import type { IntegrationsHealth, RunFixRequest, RunFixResult } from './integrations.ts'
import type { LinearLookup, LinearStatus, SaveLinearKeyRequest } from './linear.ts'
import type { AgentKind, Run, RunWithConversation, StartDevRunRequest } from './run.ts'
import type { MachineSettings, Profile } from './settings.ts'
import type { RunSlots } from './slots.ts'
import type {
  AnswerRequest,
  Attachment,
  Comment,
  CreateTaskRequest,
  InboxItem,
  OutcomeResult,
  PostCommentRequest,
  ReportOutcomeRequest,
  SetTaskLeadRequest,
  Task,
  TaskBrief,
  TaskDefaults,
} from './task.ts'
import type { StageEntry } from './workflow.ts'

export class DaemonUnreachableError extends Error {}

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

  constructor(info: DaemonInfo, token: string = info.token) {
    this.#info = info
    this.#token = token
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

  useDefaultModel(ref: string): Promise<Task> {
    return this.#request('POST', `/tasks/${encodeURIComponent(ref)}/lead/use-default-model`)
  }

  moveToBacklog(ref: string): Promise<Task> {
    return this.#request('POST', `/tasks/${encodeURIComponent(ref)}/backlog`)
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

  postComment(ref: string, comment: string | PostCommentRequest): Promise<Comment> {
    const body = typeof comment === 'string' ? { body: comment } : comment
    return this.#request('POST', `/tasks/${encodeURIComponent(ref)}/comments`, body)
  }

  listInbox(): Promise<InboxItem[]> {
    return this.#request('GET', '/inbox')
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

  taskDefaults(factoryId: string): Promise<TaskDefaults> {
    return this.#request('GET', `/factories/${encodeURIComponent(factoryId)}/task-defaults`)
  }

  async uploadAttachment(
    file: { name: string; mediaType: string },
    bytes: Uint8Array<ArrayBuffer>,
  ): Promise<Attachment> {
    const res = await this.#fetch('POST', '/attachments', bytes, undefined, {
      'content-type': file.mediaType || 'application/octet-stream',
      'x-ted-name': encodeURIComponent(file.name),
    })
    if (!res.ok) throw await requestError(res)
    return (await res.json()) as Attachment
  }

  setLocalFolder(key: string, path: string): Promise<Factory> {
    return this.#request('PUT', `/factories/${encodeURIComponent(key)}/local-folder`, { path })
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

  shutdown(): Promise<void> {
    return this.#request('POST', '/shutdown')
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

  getDataStatus(): Promise<DataStatus> {
    return this.#request('GET', '/data-status')
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
    const res = await this.#fetch('GET', route, undefined, controller.signal)
    if (!res.ok || !res.body) throw await requestError(res)
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()

    const ready = Promise.withResolvers<void>()
    let opened = false
    const open = () => {
      opened = true
      ready.resolve()
    }
    void (async () => {
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer = dispatch(buffer + value, onEvent, open)
      }
      ready.reject(new DaemonUnreachableError('the daemon closed the event stream'))
    })()
      .catch(ready.reject)
      .finally(() => {
        if (opened && !controller.signal.aborted) onClose?.()
      })
    await ready.promise

    return { close: () => controller.abort() }
  }

  async #request<T>(method: string, route: string, body?: unknown): Promise<T> {
    const res = await this.#fetch(method, route, body)
    if (!res.ok) throw await requestError(res)
    return (await res.json()) as T
  }

  async #fetch(
    method: string,
    route: string,
    body?: unknown,
    signal?: AbortSignal,
    rawHeaders?: Record<string, string>,
  ): Promise<Response> {
    const raw = body instanceof Uint8Array
    try {
      return await fetch(`http://127.0.0.1:${this.#info.port}${route}`, {
        method,
        headers: {
          authorization: `Bearer ${this.#token}`,
          ...(body !== undefined && !raw && { 'content-type': 'application/json' }),
          ...rawHeaders,
        },
        ...(body !== undefined && {
          body: raw ? (body as Uint8Array<ArrayBuffer>) : JSON.stringify(body),
        }),
        ...(signal && { signal }),
      })
    } catch (error) {
      throw new DaemonUnreachableError(`can't reach TED's daemon on port ${this.#info.port}`, {
        cause: error,
      })
    }
  }
}

async function requestError(res: Response): Promise<DaemonRequestError> {
  const payload = (await res.json().catch(() => ({}))) as { error?: string }
  return new DaemonRequestError(res.status, payload.error ?? `HTTP ${res.status}`)
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
