import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface StubLinearIssue {
  identifier: string
  title: string
  description?: string
  priority?: number
  branchName?: string
}

export interface StubLinearAccount {
  name: string
  workspace: { name: string; urlKey: string }
  issues?: StubLinearIssue[]
}

export interface StubLinear {
  url: string
  requests: { authorization: string | undefined; query: string; variables: unknown }[]
  accounts: Map<string, StubLinearAccount>
  close(): Promise<void>
}

export async function startStubLinear(
  accounts: Record<string, StubLinearAccount> = {},
): Promise<StubLinear> {
  const stub: Omit<StubLinear, 'url' | 'close'> = {
    requests: [],
    accounts: new Map(Object.entries(accounts)),
  }
  const server = http.createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      const { query = '', variables } = JSON.parse(body || '{}') as {
        query?: string
        variables?: { id?: string }
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
      const organization = { name: account.workspace.name, urlKey: account.workspace.urlKey }
      if (query.includes('issue(')) {
        const issue = account.issues?.find((i) => i.identifier === variables?.id)
        if (!issue) {
          return reply(200, {
            data: null,
            errors: [
              {
                message: 'Entity not found: Issue',
                extensions: { type: 'invalid input', code: 'INVALID_INPUT' },
              },
            ],
          })
        }
        return reply(200, {
          data: {
            issue: {
              identifier: issue.identifier,
              title: issue.title,
              description: issue.description ?? null,
              priority: issue.priority ?? 0,
              branchName: issue.branchName ?? '',
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
  return {
    ...stub,
    url: `http://127.0.0.1:${port}/graphql`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}
