import { createHash } from 'node:crypto'
import http from 'node:http'

export interface StubAsanaTask {
  gid: string
  name: string
  notes?: string
  completed?: boolean
  assignee?: { gid: string; name: string }
  subtasks?: string[]
  comments?: { author: string; at: string; text: string }[]
  attachments?: { name: string; host?: string; bytes?: string }[]
  status?: number
  parent?: string
  memberships?: { project: string; section?: string }[]
}

export interface StubAsanaProject {
  gid: string
  name: string
  workspace: string
  archived?: boolean
  sections?: { gid: string; name: string }[]
}

export async function startStubAsana() {
  const requests: {
    at: number
    method: string
    path: string
    query: Record<string, string>
    fields: Record<string, string>
    json?: unknown
    authorization?: string
  }[] = []
  let writeFailure: { status: number; retryAfter?: string; applied?: boolean } | undefined
  const tasks = new Map<string, StubAsanaTask>()
  const workspaces = new Map<string, string>()
  const projects = new Map<string, StubAsanaProject>()
  const failures = new Map<string, { status: number; times: number; retryAfter?: string }>()
  const pathHolds = new Map<string, Promise<void>>()
  let pageSize = 2
  let user = { gid: '100', name: 'Avery', email: 'avery@example.test' }
  let expiresIn = 3600
  let revoked = false
  let offline = false
  let tokenError: boolean | 401 = false
  let redirect = false
  let grantClientId = ''
  let grant: Record<string, unknown> | undefined
  let refreshToken: string | undefined = 'refresh-secret-opaque'
  let delay: Promise<void> | undefined
  const codes = new Map<string, string>()
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks).toString()
    const isJson = req.headers['content-type'] === 'application/json'
    const fields = isJson ? {} : Object.fromEntries(new URLSearchParams(raw))
    const json = isJson ? (JSON.parse(raw) as { data?: Record<string, unknown> }) : undefined
    const path = (req.url ?? '').split('?')[0] ?? ''
    const query = Object.fromEntries(new URL(req.url ?? '/', 'http://stub').searchParams)
    requests.push({
      at: Date.now(),
      method: req.method ?? 'GET',
      path,
      query,
      fields,
      ...(json && { json }),
      ...(req.headers.authorization && { authorization: req.headers.authorization }),
    })
    if (delay) await delay
    const held = pathHolds.get(path)
    if (held) await held
    res.setHeader('content-type', 'application/json')
    if (redirect) {
      res.writeHead(302, { location: '/leak' })
      res.end()
      return
    }
    if (offline) {
      res.writeHead(503)
      res.end(JSON.stringify({ error: 'sensitive-response-do-not-display' }))
      return
    }
    if (path === '/-/oauth_token') {
      if (
        tokenError ||
        (revoked && fields.grant_type === 'refresh_token') ||
        (fields.grant_type === 'authorization_code' &&
          codes.get(fields.code ?? '') !==
            createHash('sha256')
              .update(fields.code_verifier ?? '')
              .digest('base64url'))
      ) {
        res.writeHead(tokenError === 401 ? 401 : 400)
        res.end(JSON.stringify({ error: 'invalid_grant', error_description: fields.client_secret }))
        return
      }
      if (fields.code) {
        codes.delete(fields.code)
        revoked = false
      }
      grantClientId = fields.client_id ?? ''
      res.end(
        JSON.stringify({
          access_token: 'access-secret-opaque',
          ...(refreshToken !== undefined && { refresh_token: refreshToken }),
          token_type: 'bearer',
          expires_in: expiresIn,
        }),
      )
    } else if (path === '/-/token_info') {
      res.end(
        JSON.stringify({
          active: !revoked,
          token_type: 'bearer',
          client_id: grantClientId,
          scope:
            'users:read workspaces:read projects:read tasks:read attachments:read stories:read tasks:write stories:write',
          ...grant,
        }),
      )
    } else if (path === '/api/1.0/users/me') {
      if (revoked) {
        res.writeHead(401)
        res.end('{}')
        return
      }
      res.end(JSON.stringify({ data: user }))
    } else if (path.startsWith('/files/')) {
      const [, , gid = '', index = ''] = path.split('/')
      const file = tasks.get(gid)?.attachments?.[Number(index)]
      res.setHeader('content-type', 'application/octet-stream')
      if (!file) {
        res.writeHead(404)
        res.end()
        return
      }
      res.end(Buffer.from(file.bytes ?? '', 'latin1'))
    } else if (failures.has(path)) {
      const failure = failures.get(path) ?? { status: 500, times: 0 }
      if (failure.times <= 1) failures.delete(path)
      else failures.set(path, { ...failure, times: failure.times - 1 })
      res.writeHead(
        failure.status,
        failure.retryAfter === undefined ? {} : { 'retry-after': failure.retryAfter },
      )
      res.end('{}')
    } else if (
      path === '/api/1.0/workspaces' ||
      /^\/api\/1\.0\/(workspaces\/\d+\/projects|projects\/\d+\/sections)$/.test(path)
    ) {
      if (req.headers.authorization !== 'Bearer access-secret-opaque') {
        res.writeHead(401)
        res.end('{}')
        return
      }
      const [, , , kind = '', gid = ''] = path.split('/')
      const items =
        path === '/api/1.0/workspaces'
          ? [...workspaces].map(([id, name]) => ({ gid: id, name }))
          : kind === 'workspaces'
            ? [...projects.values()]
                .filter((p) => p.workspace === gid && !(query.archived === 'false' && p.archived))
                .map((p) => ({ gid: p.gid, name: p.name, archived: p.archived === true }))
            : (projects.get(gid)?.sections ?? [])
      if (kind === 'projects' && !projects.has(gid)) {
        res.writeHead(404)
        res.end('{}')
        return
      }
      const offset = Number(query.offset ?? '0')
      const next = offset + pageSize
      res.end(
        JSON.stringify({
          data: items.slice(offset, next),
          next_page: next < items.length ? { offset: String(next) } : null,
        }),
      )
    } else if (/^\/api\/1\.0\/(workspaces|projects|sections)\//.test(path)) {
      if (req.headers.authorization !== 'Bearer access-secret-opaque') {
        res.writeHead(401)
        res.end('{}')
        return
      }
      const [, , , kind = '', gid = '', list] = path.split('/')
      const sectionOf = (id: string) => {
        for (const project of projects.values()) {
          const section = project.sections?.find((s) => s.gid === id)
          if (section) return { ...section, project }
        }
        return undefined
      }
      const project = kind === 'projects' ? projects.get(gid) : undefined
      const section = kind === 'sections' ? sectionOf(gid) : undefined
      const workspace = kind === 'workspaces' ? workspaces.get(gid) : undefined
      if (!project && !section && workspace === undefined) {
        res.writeHead(404)
        res.end('{}')
        return
      }
      if (list === 'tasks') {
        const members = [...tasks.values()].filter(
          (task) =>
            task.status === undefined &&
            (query.completed_since !== 'now' || task.completed !== true) &&
            (task.memberships ?? []).some((m) =>
              project ? m.project === project.gid : m.section === section?.gid,
            ),
        )
        const offset = Number(query.offset ?? '0')
        const next = offset + pageSize
        res.end(
          JSON.stringify({
            data: members.slice(offset, next).map((task) => ({
              gid: task.gid,
              name: task.name,
              completed: task.completed === true,
            })),
            next_page: next < members.length ? { offset: String(next) } : null,
          }),
        )
        return
      }
      res.end(
        JSON.stringify({
          data: project
            ? {
                gid: project.gid,
                name: project.name,
                archived: project.archived === true,
                workspace: { gid: project.workspace },
              }
            : section
              ? { gid: section.gid, name: section.name, project: { gid: section.project.gid } }
              : { gid, name: workspace },
        }),
      )
    } else if (path.startsWith('/api/1.0/tasks/') || path === '/api/1.0/attachments') {
      if (req.headers.authorization !== 'Bearer access-secret-opaque') {
        res.writeHead(401)
        res.end('{}')
        return
      }
      const [, , , , gid = query.parent ?? '', list] = path.split('/')
      const task = tasks.get(path === '/api/1.0/attachments' ? (query.parent ?? '') : gid)
      if (!task || task.status !== undefined) {
        res.writeHead(task?.status ?? 404)
        res.end('{}')
        return
      }
      if (req.method === 'POST' || req.method === 'PUT') {
        const failure = writeFailure
        writeFailure = undefined
        if (failure && !failure.applied) {
          res.writeHead(
            failure.status,
            failure.retryAfter ? { 'retry-after': failure.retryAfter } : {},
          )
          res.end('{}')
          return
        }
        const data = json?.data ?? {}
        if (req.method === 'POST' && list === 'stories' && typeof data.text === 'string') {
          tasks.set(task.gid, {
            ...task,
            comments: [
              ...(task.comments ?? []),
              { author: user.name, at: new Date().toISOString(), text: data.text },
            ],
          })
        } else if (req.method === 'PUT' && list === undefined && data.completed === true) {
          tasks.set(task.gid, { ...task, completed: true })
        } else {
          res.writeHead(400)
          res.end('{}')
          return
        }
        if (failure) {
          res.writeHead(failure.status)
          res.end('{}')
          return
        }
        res.end(JSON.stringify({ data: { gid: `${task.gid}9` } }))
        return
      }
      const page = (items: unknown[]) => {
        const offset = Number(query.offset ?? '0')
        const next = offset + pageSize
        res.end(
          JSON.stringify({
            data: items.slice(offset, next),
            next_page: next < items.length ? { offset: String(next) } : null,
          }),
        )
      }
      if (path === '/api/1.0/attachments')
        page(
          (task.attachments ?? []).map((file, index) => ({
            gid: `${task.gid}${index}`,
            name: file.name,
            host: file.host ?? 'asana',
            view_url: `https://app.asana.com/app/asana/-/get_asset?asset_id=${task.gid}${index}`,
            ...((file.host ?? 'asana') === 'asana' && {
              download_url: `http://127.0.0.1:${port()}/files/${task.gid}/${index}`,
            }),
          })),
        )
      else if (list === 'subtasks')
        page(
          (task.subtasks ?? []).flatMap((child) => {
            const found = tasks.get(child)
            return found
              ? [
                  {
                    gid: found.gid,
                    name: found.name,
                    completed: found.completed === true,
                    num_subtasks: (found.subtasks ?? []).length,
                  },
                ]
              : [{ gid: child, name: `Missing ${child}`, completed: false }]
          }),
        )
      else if (list === 'stories')
        page([
          { type: 'system', resource_subtype: 'due_date_changed', text: 'changed the due date' },
          ...(task.comments ?? []).map((comment) => ({
            type: 'comment',
            resource_subtype: 'comment_added',
            text: comment.text,
            created_at: comment.at,
            created_by: { name: comment.author },
          })),
        ])
      else
        res.end(
          JSON.stringify({
            data: {
              gid: task.gid,
              name: task.name,
              notes: task.notes ?? '',
              completed: task.completed === true,
              num_subtasks: (task.subtasks ?? []).length,
              permalink_url: `https://app.asana.com/1/1/project/9/task/${task.gid}`,
              assignee: task.assignee ?? null,
              parent: task.parent ? { gid: task.parent } : null,
              memberships: (task.memberships ?? []).map((m) => ({
                project: { gid: m.project, name: projects.get(m.project)?.name ?? m.project },
                section: m.section ? { gid: m.section } : null,
              })),
            },
          }),
        )
    } else if (path === '/-/oauth_revoke') {
      revoked = true
      res.end('{}')
    } else {
      res.writeHead(404)
      res.end('{}')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No stub port')
  const port = () => address.port
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    setTasks(list: readonly StubAsanaTask[]) {
      tasks.clear()
      for (const task of list) tasks.set(task.gid, task)
    },
    setWorkspaces(list: readonly { gid: string; name: string }[]) {
      workspaces.clear()
      for (const workspace of list) workspaces.set(workspace.gid, workspace.name)
    },
    setProjects(list: readonly StubAsanaProject[]) {
      projects.clear()
      for (const project of list) projects.set(project.gid, project)
    },
    holdPath(path: string, value: Promise<void> | undefined) {
      if (value) pathHolds.set(path, value)
      else pathHolds.delete(path)
    },
    failNext(path: string, status: number, times = 1, retryAfter?: string) {
      failures.set(path, { status, times, ...(retryAfter !== undefined && { retryAfter }) })
    },
    updateTask(gid: string, change: Partial<StubAsanaTask>) {
      const task = tasks.get(gid)
      if (task) tasks.set(gid, { ...task, ...change })
    },
    setPageSize(size: number) {
      pageSize = size
    },
    setUser(next: typeof user) {
      user = next
      revoked = false
    },
    setGrant(value: Record<string, unknown> | undefined) {
      grant = value
    },
    setRefreshToken(value: string | undefined) {
      refreshToken = value
    },
    setExpiresIn(seconds: number) {
      expiresIn = seconds
    },
    setRevoked(value: boolean) {
      revoked = value
    },
    setOffline(value: boolean) {
      offline = value
    },
    setTokenError(value: boolean | 401) {
      tokenError = value
    },
    setRedirect(value: boolean) {
      redirect = value
    },
    failNextWrite(failure: { status: number; retryAfter?: string; applied?: boolean }) {
      writeFailure = failure
    },
    task(gid: string) {
      return tasks.get(gid)
    },
    hold(value: Promise<void> | undefined) {
      delay = value
    },
    callback(authorization: string, code = 'stub-code') {
      const url = new URL(authorization)
      codes.set(code, url.searchParams.get('code_challenge') ?? '')
      const callback = new URL(url.searchParams.get('redirect_uri') ?? '')
      callback.search = new URLSearchParams({
        state: url.searchParams.get('state') ?? '',
        code,
      }).toString()
      return callback.href
    },
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

export async function unusedPort() {
  const server = http.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No port')
  const port = address.port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}
