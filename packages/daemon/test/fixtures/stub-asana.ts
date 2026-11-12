import { createHash } from 'node:crypto'
import http from 'node:http'

export async function startStubAsana() {
  const requests: { path: string; fields: Record<string, string>; authorization?: string }[] = []
  let user = { gid: '100', name: 'Avery', email: 'avery@example.test' }
  let expiresIn = 3600
  let revoked = false
  let offline = false
  let tokenError = false
  let redirect = false
  let grantClientId = ''
  let grant: Record<string, unknown> | undefined
  let refreshToken: string | undefined = 'refresh-secret-opaque'
  let delay: Promise<void> | undefined
  const codes = new Map<string, string>()
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const fields = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()))
    const path = (req.url ?? '').split('?')[0] ?? ''
    requests.push({
      path,
      fields,
      ...(req.headers.authorization && { authorization: req.headers.authorization }),
    })
    if (delay) await delay
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
        res.writeHead(400)
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
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
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
    setTokenError(value: boolean) {
      tokenError = value
    },
    setRedirect(value: boolean) {
      redirect = value
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
