import {
  maxShellInputChars,
  type OpenInEditorRequest,
  type ShellSize,
  shellSizeLimits,
} from '@ted/protocol'
import { RequestError as HttpError } from '../errors.ts'
import type { Caller } from '../tasks/tasks.ts'
import { type Route, readJson, readOptionalJson } from './route.ts'

const shellPath = (rest: string) => new RegExp(`^/tasks/([^/]+)/repos/([^/]+)/shell${rest}$`)

function appOnly(caller: Caller): void {
  if (caller.kind !== 'app') throw new HttpError(403, 'only the TED app can do this')
}

function whole(name: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, `${name} must be a whole number from ${min} to ${max}`)
  }
  return value
}

function size(body: unknown): ShellSize {
  const given = (body ?? {}) as Partial<Record<keyof ShellSize, unknown>>
  const { min, max } = shellSizeLimits
  return { cols: whole('cols', given.cols, min, max), rows: whole('rows', given.rows, min, max) }
}

const maxPosition = 10_000_000

function editorRequest(body: unknown): OpenInEditorRequest {
  if (body === null || body === undefined) return {}
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'body must be an object')
  }
  const given = body as Record<string, unknown>
  if (given.snapshot !== undefined && typeof given.snapshot !== 'boolean') {
    throw new HttpError(400, 'snapshot must be a boolean')
  }
  if (given.file === undefined) {
    if (given.line !== undefined || given.column !== undefined || given.snapshot === true) {
      throw new HttpError(400, 'line, column and snapshot need a file')
    }
    return {}
  }
  if (typeof given.file !== 'string') throw new HttpError(400, 'file must be a path')
  return {
    file: given.file,
    ...(given.snapshot !== undefined && { snapshot: given.snapshot }),
    ...(given.line !== undefined && { line: whole('line', given.line, 1, maxPosition) }),
    ...(given.column !== undefined && { column: whole('column', given.column, 1, maxPosition) }),
  }
}

function query(search: string): { generation: number; from: number; waitMs: number } {
  const params = new URLSearchParams(search)
  const number = (name: string, fallback?: number) => {
    const text = params.get(name)
    if (text === null && fallback !== undefined) return fallback
    const value = Number(text)
    if (text === null || !Number.isSafeInteger(value) || value < 0) {
      throw new HttpError(400, `${name} must be a whole number`)
    }
    return value
  }
  return { generation: number('generation'), from: number('from'), waitMs: number('waitMs', 0) }
}

export const shellRoutes: Route[] = [
  {
    method: 'POST',
    path: shellPath(''),
    async handle({ req, params: [ref = '', repo = ''] }, { shells }) {
      return [200, await shells.open(ref, repo, size(await readJson(req)))]
    },
  },
  {
    method: 'POST',
    path: shellPath('/restart'),
    async handle({ req, params: [ref = '', repo = ''] }, { shells }) {
      return [200, await shells.restart(ref, repo, size(await readJson(req)))]
    },
  },
  {
    method: 'POST',
    path: shellPath('/input'),
    async handle({ req, params: [ref = '', repo = ''] }, { shells }) {
      const body = (await readJson(req)) as { data?: unknown } | null
      const data = body?.data
      if (typeof data !== 'string' || data.length === 0 || data.length > maxShellInputChars) {
        throw new HttpError(400, `data must be text of 1 to ${maxShellInputChars} characters`)
      }
      await shells.write(ref, repo, data)
      return [200, {}]
    },
  },
  {
    method: 'POST',
    path: shellPath('/resize'),
    async handle({ req, params: [ref = '', repo = ''] }, { shells }) {
      await shells.resize(ref, repo, size(await readJson(req)))
      return [200, {}]
    },
  },
  {
    method: 'GET',
    path: shellPath('/output\\?(.*)'),
    async handle({ res, params: [ref = '', repo = '', search = ''], caller }, { shells }) {
      appOnly(caller)
      const closed = new AbortController()
      const abort = () => closed.abort()
      res.on('close', abort)
      try {
        return [200, await shells.read(ref, repo, query(search), closed.signal)]
      } finally {
        res.off('close', abort)
      }
    },
  },
  {
    method: 'GET',
    path: /^\/editors$/,
    handle: async (_, { editors }) => [200, await editors.found()],
  },
  {
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/repos\/([^/]+)\/open-in-editor$/,
    async handle({ req, params: [ref = '', repo = ''] }, { tasks, editors }) {
      const request = editorRequest(await readOptionalJson(req))
      const { worktree, fileScope } = await tasks.worktreeAccess(ref, repo)
      await editors.open({ worktree, fileScope }, request)
      return [200, {}]
    },
  },
]
