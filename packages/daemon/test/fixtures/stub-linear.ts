import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface StubLinearState {
  id: string
  name: string
  type: string
  position: number
}

export interface StubLinearIssue {
  identifier: string
  title: string
  description?: string
  priority?: number
  branchName?: string
  state?: string
  teamName?: string
  teamKey?: string
}

export interface StubLinearAccount {
  name: string
  workspace: { name: string; urlKey: string }
  issues?: StubLinearIssue[]
  states?: StubLinearState[]
  attachments?: { issue: string; url: string; title: string }[]
}

export interface StubLinearUpload {
  body?: string | Buffer
  contentType?: string
  status?: number
  redirect?: string
}

export interface StubLinear {
  url: string
  origin: string
  requests: { authorization: string | undefined; query: string; variables: unknown }[]
  downloads: { authorization: string | undefined; path: string }[]
  accounts: Map<string, StubLinearAccount>
  uploads: Map<string, StubLinearUpload>
  uploadUrl(name: string): string
  close(): Promise<void>
}

export const stubLinearStates: StubLinearState[] = [
  { id: 'state-triage', name: 'Triage', type: 'triage', position: 0 },
  { id: 'state-backlog', name: 'Backlog', type: 'backlog', position: 1 },
  { id: 'state-todo', name: 'Todo', type: 'unstarted', position: 2 },
  { id: 'state-review', name: 'In Review', type: 'started', position: 4 },
  { id: 'state-progress', name: 'In Progress', type: 'started', position: 3 },
  { id: 'state-done', name: 'Done', type: 'completed', position: 5 },
  { id: 'state-canceled', name: 'Canceled', type: 'canceled', position: 6 },
]

const teamKeyOf = (issue: StubLinearIssue) => issue.teamKey ?? issue.identifier.split('-')[0] ?? ''

export const stubLinearIssueId = (identifier: string) => `uuid-${identifier}`

export async function startStubLinear(
  accounts: Record<string, StubLinearAccount> = {},
): Promise<StubLinear> {
  const stub: Omit<StubLinear, 'url' | 'origin' | 'uploadUrl' | 'close'> = {
    requests: [],
    downloads: [],
    accounts: new Map(Object.entries(accounts)),
    uploads: new Map(),
  }
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://stub').pathname
    if (req.method === 'GET' && pathname.startsWith('/uploads/')) {
      stub.downloads.push({ authorization: req.headers.authorization, path: pathname })
      const upload = stub.uploads.get(pathname)
      if (!upload) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        return res.end('Not found')
      }
      if (upload.redirect !== undefined) {
        res.writeHead(upload.status ?? 302, { location: upload.redirect })
        return res.end()
      }
      res.writeHead(upload.status ?? 200, {
        'content-type': upload.contentType ?? 'application/octet-stream',
      })
      return res.end(upload.body ?? '')
    }
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      const { query = '', variables } = JSON.parse(body || '{}') as {
        query?: string
        variables?: Record<string, string>
      }
      stub.requests.push({ authorization: req.headers.authorization, query, variables })
      const reply = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      const account = stub.accounts.get(req.headers.authorization ?? '')
      if (!account) {
        return reply(400, {
          errors: [
            {
              message: 'Authentication required, not authenticated',
              extensions: { type: 'authentication error', code: 'AUTHENTICATION_ERROR' },
            },
          ],
        })
      }
      const states = account.states ?? stubLinearStates
      const stateOf = (issue: StubLinearIssue) =>
        states.find((s) => s.name === (issue.state ?? 'Todo')) ?? states[0]
      const byId = (id: string | undefined) =>
        account.issues?.find((i) => i.identifier === id || stubLinearIssueId(i.identifier) === id)
      const notFound = (path: string[]) => ({
        message: 'Entity not found: Issue',
        path,
        extensions: { type: 'invalid input', code: 'INVALID_INPUT' },
      })
      const organization = { name: account.workspace.name, urlKey: account.workspace.urlKey }
      if (query.includes('TedIssueStates')) {
        const data: Record<string, unknown> = {}
        const errors: unknown[] = []
        for (const [alias, id] of Object.entries(variables ?? {})) {
          const issue = byId(id)
          if (!issue) {
            data[alias] = null
            errors.push(notFound([alias]))
            continue
          }
          data[alias] = {
            id: stubLinearIssueId(issue.identifier),
            identifier: issue.identifier,
            state: stateOf(issue),
            team: {
              id: `team-${teamKeyOf(issue)}`,
              key: teamKeyOf(issue),
            },
          }
        }
        return reply(200, { data, ...(errors.length > 0 && { errors }) })
      }
      if (query.includes('TedTeamStates')) {
        return reply(200, { data: { team: { states: { nodes: states } } } })
      }
      if (query.includes('TedMoveIssue')) {
        const issue = byId(variables?.id)
        const state = states.find((s) => s.id === variables?.stateId)
        if (!issue || !state) return reply(200, { data: null, errors: [notFound(['issueUpdate'])] })
        issue.state = state.name
        return reply(200, { data: { issueUpdate: { success: true } } })
      }
      if (query.includes('TedLinkPullRequest')) {
        const issue = byId(variables?.issueId)
        if (!issue) return reply(200, { data: null, errors: [notFound(['attachmentCreate'])] })
        account.attachments ??= []
        account.attachments.push({
          issue: issue.identifier,
          url: variables?.url ?? '',
          title: variables?.title ?? '',
        })
        return reply(200, { data: { attachmentCreate: { success: true } } })
      }
      if (query.includes('issue(')) {
        const issue = account.issues?.find((i) => i.identifier === variables?.id)
        if (!issue) return reply(200, { data: null, errors: [notFound(['issue'])] })
        return reply(200, {
          data: {
            issue: {
              attachments: {
                nodes: (account.attachments ?? [])
                  .filter((a) => a.issue === issue.identifier)
                  .map(({ url, title }) => ({ url, title })),
              },
              identifier: issue.identifier,
              title: issue.title,
              description: issue.description ?? null,
              priority: issue.priority ?? 0,
              branchName: issue.branchName ?? '',
              team: {
                key: teamKeyOf(issue),
                name: issue.teamName ?? teamKeyOf(issue),
              },
              url: `https://linear.app/${account.workspace.urlKey}/issue/${issue.identifier}`,
            },
          },
        })
      }
      return reply(200, {
        data: { viewer: { name: account.name, displayName: account.name }, organization },
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const origin = `http://127.0.0.1:${port}`
  return {
    ...stub,
    url: `${origin}/graphql`,
    origin,
    uploadUrl: (name) => `${origin}/uploads/${name}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}
