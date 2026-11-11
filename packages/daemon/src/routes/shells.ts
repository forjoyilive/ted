import { parseOpenInEditorRequest, parseShellInputRequest, parseShellSize } from '@ted/protocol'
import { RequestError as HttpError } from '../errors.ts'
import type { Caller } from '../tasks/tasks.ts'
import { jsonRoute, type Route } from './route.ts'

const shellPath = (rest: string) => new RegExp(`^/tasks/([^/]+)/repos/([^/]+)/shell${rest}$`)

function appOnly(caller: Caller): void {
  if (caller.kind !== 'app') throw new HttpError(403, 'only the TED app can do this')
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
  jsonRoute(parseShellSize, {
    method: 'POST',
    path: shellPath(''),
    async handle({ body, params: [ref = '', repo = ''] }, { shells }) {
      return [200, await shells.open(ref, repo, body)]
    },
  }),
  jsonRoute(parseShellSize, {
    method: 'POST',
    path: shellPath('/restart'),
    async handle({ body, params: [ref = '', repo = ''] }, { shells }) {
      return [200, await shells.restart(ref, repo, body)]
    },
  }),
  jsonRoute(parseShellInputRequest, {
    method: 'POST',
    path: shellPath('/input'),
    async handle({ body, params: [ref = '', repo = ''] }, { shells }) {
      await shells.write(ref, repo, body.data)
      return [200, {}]
    },
  }),
  jsonRoute(parseShellSize, {
    method: 'POST',
    path: shellPath('/resize'),
    async handle({ body, params: [ref = '', repo = ''] }, { shells }) {
      await shells.resize(ref, repo, body)
      return [200, {}]
    },
  }),
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
  jsonRoute(parseOpenInEditorRequest, {
    optionalBody: true,
    method: 'POST',
    path: /^\/tasks\/([^/]+)\/repos\/([^/]+)\/open-in-editor$/,
    async handle({ body, params: [ref = '', repo = ''] }, { tasks, editors }) {
      const { worktree, fileScope } = await tasks.worktreeAccess(ref, repo)
      await editors.open({ worktree, fileScope }, body)
      return [200, {}]
    },
  }),
]
