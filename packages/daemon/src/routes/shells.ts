import {
  maxShellInputChars,
  type OpenInEditorRequest,
  type ShellChange,
  type ShellSize,
  shellSizeLimits,
} from '@ted/protocol'
import { RequestError as HttpError } from '../errors.ts'
import type { Caller } from '../tasks/tasks.ts'
import { type Route, readJson, readOptionalJson } from './route.ts'

const shellPath = (rest: string) =>
  new RegExp(`^/tasks/([^/]+)/repos/([^/]+)/shell(?:/panes/([^/]+))?${rest}$`)
const workspacePath = (rest: string) => new RegExp(`^/tasks/([^/]+)/repos/([^/]+)/shells${rest}$`)

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
  if (given.file === undefined) {
    if (given.line !== undefined || given.column !== undefined) {
      throw new HttpError(400, 'line and column need a file')
    }
    return {}
  }
  if (typeof given.file !== 'string') throw new HttpError(400, 'file must be a path')
  return {
    file: given.file,
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

function object(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new HttpError(400, 'body must be an object')
  return body as Record<string, unknown>
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(value))
    throw new HttpError(400, 'a shell or divider ID is required')
  return value
}

function changeRequest(body: unknown): ShellChange {
  const given = object(body)
  const revision = whole('revision', given.revision, 0, Number.MAX_SAFE_INTEGER)
  if (given.kind === 'ratio') {
    const ratio = given.ratio
    if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0.1 || ratio > 0.9)
      throw new HttpError(400, 'ratio must be from 0.1 to 0.9')
    return { kind: 'ratio', revision, branchId: identifier(given.branchId), ratio }
  }
  const shellId = identifier(given.shellId)
  if (given.kind === 'close') return { kind: 'close', revision, shellId }
  if (given.kind !== 'split' || (given.direction !== 'right' && given.direction !== 'below'))
    throw new HttpError(400, 'choose split right, split below, close or ratio')
  return { kind: 'split', revision, shellId, direction: given.direction, size: size(given.size) }
}

export const shellRoutes: Route[] = [
  {
    method: 'GET',
    path: workspacePath(''),
    async handle({ params: [ref = '', repo = ''], caller }, { shells }) {
      appOnly(caller)
      return [200, await shells.workspace(ref, repo)]
    },
  },
  {
    method: 'POST',
    path: workspacePath(''),
    async handle({ req, params: [ref = '', repo = ''] }, { shells }) {
      const body = object(await readJson(req))
      if (body.create !== undefined && typeof body.create !== 'boolean')
        throw new HttpError(400, 'create must be a boolean')
      return [200, await shells.workspace(ref, repo, size(body), body.create === true)]
    },
  },
  {
    method: 'POST',
    path: workspacePath('/change'),
    async handle({ req, params: [ref = '', repo = ''] }, { shells }) {
      return [200, await shells.change(ref, repo, changeRequest(await readJson(req)))]
    },
  },
  {
    method: 'POST',
    path: shellPath(''),
    async handle({ req, params: [ref = '', repo = '', id] }, { shells }) {
      return [200, await shells.open(ref, repo, size(await readJson(req)), id || undefined)]
    },
  },
  {
    method: 'POST',
    path: shellPath('/restart'),
    async handle({ req, params: [ref = '', repo = '', id] }, { shells }) {
      return [200, await shells.restart(ref, repo, size(await readJson(req)), id || undefined)]
    },
  },
  {
    method: 'POST',
    path: shellPath('/input'),
    async handle({ req, params: [ref = '', repo = '', id] }, { shells }) {
      const body = (await readJson(req)) as { data?: unknown } | null
      const data = body?.data
      if (typeof data !== 'string' || data.length === 0 || data.length > maxShellInputChars) {
        throw new HttpError(400, `data must be text of 1 to ${maxShellInputChars} characters`)
      }
      await shells.write(ref, repo, data, id || undefined)
      return [200, {}]
    },
  },
  {
    method: 'POST',
    path: shellPath('/resize'),
    async handle({ req, params: [ref = '', repo = '', id] }, { shells }) {
      await shells.resize(ref, repo, size(await readJson(req)), id || undefined)
      return [200, {}]
    },
  },
  {
    method: 'GET',
    path: shellPath('/output\\?(.*)'),
    async handle({ res, params: [ref = '', repo = '', id, search = ''], caller }, { shells }) {
      appOnly(caller)
      const closed = new AbortController()
      const abort = () => closed.abort()
      res.on('close', abort)
      try {
        return [200, await shells.read(ref, repo, query(search), closed.signal, id || undefined)]
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
      const { worktree } = await tasks.worktreeAccess(ref, repo)
      await editors.open({ worktree }, request)
      return [200, {}]
    },
  },
]
