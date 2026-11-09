import type { DaemonInfo } from './daemon-info.ts'
import type { DaemonEvent } from './events.ts'
import type { AddFactoryRequest, Factory } from './factory.ts'
import type { Run, RunWithConversation, StartDevRunRequest } from './run.ts'
import type { Comment, CreateTaskRequest, Outcome, Task } from './task.ts'
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

  listComments(ref: string): Promise<Comment[]> {
    return this.#request('GET', `/tasks/${encodeURIComponent(ref)}/comments`)
  }

  listStageEntries(ref: string): Promise<StageEntry[]> {
    return this.#request('GET', `/tasks/${encodeURIComponent(ref)}/stage-entries`)
  }

  postComment(ref: string, body: string): Promise<Comment> {
    return this.#request('POST', `/tasks/${encodeURIComponent(ref)}/comments`, { body })
  }

  reportOutcome(ref: string, outcome: Outcome): Promise<Task> {
    return this.#request('POST', `/tasks/${encodeURIComponent(ref)}/outcome`, { outcome })
  }

  listFactories(): Promise<Factory[]> {
    return this.#request('GET', '/factories')
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

  addFactory(input: AddFactoryRequest): Promise<Factory> {
    return this.#request('POST', '/dev/factories', input)
  }

  startDevRun(input: StartDevRunRequest): Promise<Run> {
    return this.#request('POST', '/dev/runs', input)
  }

  getRun(id: string): Promise<RunWithConversation> {
    return this.#request('GET', `/runs/${encodeURIComponent(id)}`)
  }

  async subscribe(onEvent: (event: DaemonEvent) => void): Promise<Subscription> {
    const controller = new AbortController()
    const res = await this.#fetch('GET', '/events', undefined, controller.signal)
    if (!res.ok || !res.body) throw await requestError(res)
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()

    const ready = Promise.withResolvers<void>()
    void (async () => {
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer = dispatch(buffer + value, onEvent, ready.resolve)
      }
      ready.reject(new DaemonUnreachableError('the daemon closed the event stream'))
    })().catch(ready.reject)
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
  ): Promise<Response> {
    try {
      return await fetch(`http://127.0.0.1:${this.#info.port}${route}`, {
        method,
        headers: {
          authorization: `Bearer ${this.#token}`,
          ...(body !== undefined && { 'content-type': 'application/json' }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
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
