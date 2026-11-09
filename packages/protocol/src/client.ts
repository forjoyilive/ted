import type { DaemonInfo } from './daemon-info.ts'
import type { CreateTaskRequest, Task } from './task.ts'

export class DaemonUnreachableError extends Error {}

export class DaemonRequestError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export class DaemonClient {
  readonly #info: DaemonInfo

  constructor(info: DaemonInfo) {
    this.#info = info
  }

  listTasks(): Promise<Task[]> {
    return this.#request('GET', '/tasks')
  }

  createTask(input: CreateTaskRequest): Promise<Task> {
    return this.#request('POST', '/tasks', input)
  }

  async #request<T>(method: string, route: string, body?: unknown): Promise<T> {
    let res: Response
    try {
      res = await fetch(`http://127.0.0.1:${this.#info.port}${route}`, {
        method,
        headers: {
          authorization: `Bearer ${this.#info.token}`,
          ...(body !== undefined && { 'content-type': 'application/json' }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      })
    } catch (error) {
      throw new DaemonUnreachableError(`can't reach TED's daemon on port ${this.#info.port}`, {
        cause: error,
      })
    }
    const payload = (await res.json()) as T & { error?: string }
    if (!res.ok) throw new DaemonRequestError(res.status, payload.error ?? `HTTP ${res.status}`)
    return payload
  }
}
