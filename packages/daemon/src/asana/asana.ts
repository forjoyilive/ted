import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import {
  type AsanaConfiguration,
  type AsanaStatus,
  edition,
  parseAsanaConfiguration,
} from '@ted/protocol'
import { type Clock, systemClock, type Timer } from '../clock.ts'
import { RequestError } from '../errors.ts'
import { type Keyring, KeyringUnavailableError } from '../linear/keyring.ts'
import { CredentialCleanupError, type Credentials, credentialStore } from './credentials.ts'

export const asanaScopes = [
  'users:read',
  'workspaces:read',
  'projects:read',
  'tasks:read',
  'attachments:read',
  'stories:read',
  'tasks:write',
  'stories:write',
]
export interface AsanaOptions {
  home: string
  keyring: Keyring
  oauthOrigin?: string
  apiOrigin?: string
  callbackPort?: number
  now?: () => number
  sessionMs?: number
  timeoutMs?: number
  hold?: () => () => void
  clock?: Clock
}

class ConnectionError extends Error {
  readonly status: number | undefined
  readonly retryAfterMs: number | undefined
  constructor(message: string, status?: number, retryAfterMs?: number) {
    super(message)
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}
class RevokedError extends ConnectionError {}

export class AsanaReadError extends Error {
  readonly status: number | undefined
  readonly retryAfterMs: number | undefined
  constructor(message: string, status?: number, retryAfterMs?: number) {
    super(message)
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}

const maxReadBytes = 4_000_000
const maxWriteBytes = 65_536
export const maxAsanaCommentLength = 2000
const maxRetryAfterMs = 60 * 60_000

function retryAfter(response: Response): number | undefined {
  if (response.status !== 429 && response.status !== 503) return undefined
  const header = response.headers.get('retry-after')?.trim()
  if (!header || !/^\d{1,6}$/.test(header)) return response.status === 429 ? 60_000 : undefined
  return Math.min(Number(header) * 1000, maxRetryAfterMs)
}

export function createAsana(options: AsanaOptions) {
  const oauth = checkedOrigin(options.oauthOrigin ?? 'https://app.asana.com')
  const api = checkedOrigin(options.apiOrigin ?? 'https://app.asana.com')
  const port = options.callbackPort ?? (edition === 'release' ? 49174 : 49175)
  const redirectUri = `http://127.0.0.1:${port}/asana/callback`
  const now = options.now ?? options.clock?.now ?? Date.now
  const store = credentialStore(options.home, options.keyring)
  let generation = 0
  let tail: Promise<unknown> = Promise.resolve()
  let notice: string | undefined
  let session:
    | {
        server: http.Server
        timer: Timer
        state: string
        verifier: string
        expires: number
        generation: number
        release: () => void
      }
    | undefined
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = tail.then(work)
    tail = next.catch(() => undefined)
    return next.catch((error: unknown) => {
      throw new RequestError(409, safeError(error))
    })
  }
  function cancelSession() {
    generation++
    if (!session) return
    session.timer.cancel()
    session.server.close()
    session.server.closeAllConnections()
    session.release()
    session = undefined
  }
  async function status(): Promise<AsanaStatus> {
    try {
      const { record, place } = await store.read()
      const verified = completeScopes(record?.tokens?.scopes)
      return {
        state: session
          ? 'authorizing'
          : notice
            ? 'error'
            : record?.tokens
              ? verified
                ? 'connected'
                : 'error'
              : record
                ? 'disconnected'
                : 'unconfigured',
        configured: !!record,
        redirectUri,
        ...(place && { storedIn: place }),
        ...(record?.tokens && verified && { user: record.tokens.user }),
        ...(notice
          ? { error: notice }
          : record?.tokens && !verified
            ? { error: 'Reconnect to verify this account’s Asana permission grant.' }
            : {}),
      }
    } catch (error) {
      return {
        state: 'error',
        configured: false,
        redirectUri,
        error:
          error instanceof CredentialCleanupError
            ? 'Asana is disconnected, but old keyring credentials could not be deleted. Unlock or restore your keyring; TED will retry cleanup without restoring the account.'
            : error instanceof KeyringUnavailableError
              ? error.reason === 'locked'
                ? 'Unlock your keyring, then try again.'
                : 'No keyring is available. You can explicitly choose private-file storage.'
              : 'Couldn’t read Asana credentials. Check your keyring and credential file permissions.',
        ...((error instanceof KeyringUnavailableError || error instanceof CredentialCleanupError) &&
          error.reason && { storageProblem: error.reason }),
      }
    }
  }
  async function request(
    url: string,
    init: RequestInit,
    maxBytes = 32_768,
  ): Promise<Record<string, unknown>> {
    try {
      const response = await fetch(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      })
      if (response.status === 401) {
        await response.body?.cancel()
        throw new RevokedError('Asana authorization expired or was revoked. Reconnect to continue.')
      }
      if (!response.ok) {
        const invalid = response.status === 400 && url.endsWith('/-/oauth_token')
        await response.body?.cancel()
        if (invalid)
          throw new RevokedError(
            'Asana rejected the authorization. Check your app configuration and reconnect.',
          )
        throw new ConnectionError(
          'Asana couldn’t complete the request. Check your connection and app permissions, then try again.',
          response.status,
          retryAfter(response),
        )
      }
      if (url.endsWith('/-/oauth_revoke')) {
        await response.body?.cancel()
        return {}
      }
      const reader = response.body?.getReader()
      if (!reader) throw new Error()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.length
          if (size > maxBytes) throw new Error()
          chunks.push(value)
        }
      } finally {
        await reader.cancel()
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    } catch (error) {
      if (error instanceof ConnectionError) throw error
      throw new ConnectionError(
        'Couldn’t reach Asana or read its response. Check your connection and try again.',
      )
    }
  }
  function form(record: Credentials, fields: Record<string, string>) {
    return {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: record.clientId,
        client_secret: record.clientSecret,
        ...fields,
      }),
    }
  }
  async function identity(access: string) {
    const body = await request(`${api}/api/1.0/users/me?opt_fields=gid,name,email`, {
      headers: { authorization: `Bearer ${access}` },
    })
    const user = body.data as Record<string, unknown> | undefined
    if (
      !user ||
      typeof user.gid !== 'string' ||
      typeof user.name !== 'string' ||
      typeof user.email !== 'string'
    )
      throw new ConnectionError(
        'Asana returned an incomplete identity. Check users:read permission and reconnect.',
      )
    return {
      gid: user.gid.slice(0, 100),
      name: user.name.slice(0, 200),
      email: user.email.slice(0, 320),
    }
  }
  async function grantedScopes(record: Credentials, access: string) {
    const info = await request(`${oauth}/-/token_info`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: access }),
    })
    const scopes =
      typeof info.scope === 'string' ? [...new Set(info.scope.split(/\s+/).filter(Boolean))] : []
    if (
      info.active !== true ||
      info.client_id !== record.clientId ||
      info.token_type !== 'bearer' ||
      !completeScopes(scopes)
    ) {
      throw new RevokedError(
        'Asana did not confirm this app’s complete permission grant. Check the registered scopes and reconnect.',
      )
    }
    return scopes
  }
  async function exchange(record: Credentials, fields: Record<string, string>) {
    const result = await request(`${oauth}/-/oauth_token`, form(record, fields))
    if (
      typeof result.access_token !== 'string' ||
      !result.access_token ||
      result.access_token.length > 8192 ||
      typeof result.expires_in !== 'number' ||
      !Number.isFinite(result.expires_in) ||
      result.expires_in <= 0 ||
      result.expires_in > 31_536_000 ||
      (result.refresh_token !== undefined &&
        (typeof result.refresh_token !== 'string' ||
          !result.refresh_token ||
          result.refresh_token.length > 8192)) ||
      (result.token_type as string)?.toLowerCase() !== 'bearer'
    )
      throw new ConnectionError('Asana returned incomplete credentials. Reconnect to try again.')
    const refresh =
      typeof result.refresh_token === 'string' ? result.refresh_token : record.tokens?.refresh
    if (!refresh)
      throw new ConnectionError('Asana did not return a refresh token. Reconnect to try again.')
    return {
      access: result.access_token,
      refresh,
      expires: now() + result.expires_in * 1000,
      scopes: await grantedScopes(record, result.access_token),
      user: await identity(result.access_token),
    }
  }
  async function revoke(record: Credentials) {
    if (!record.tokens) return
    try {
      await request(`${oauth}/-/oauth_revoke`, form(record, { token: record.tokens.refresh }))
    } catch {
      notice =
        'Disconnected locally. Asana could not confirm revocation. Remove this app in Asana → My settings → Apps to revoke it manually.'
    }
  }
  async function disconnect(remove = false) {
    cancelSession()
    return serial(async () => {
      notice = undefined
      const { record, place } = await store.read()
      if (record && place) {
        if (remove) await store.remove()
        else
          await store.write(
            { version: 1, clientId: record.clientId, clientSecret: record.clientSecret },
            place,
          )
        await revoke(record)
      }
      return status()
    })
  }
  function accessToken(): Promise<{ access: string; user: { gid: string; name: string } }> {
    const started = generation
    return serial(async () => {
      const { record, place } = await store.read()
      if (!record?.tokens || !place)
        throw new ConnectionError('Connect Asana in Settings → Integrations, then try again.')
      let tokens = record.tokens
      if (tokens.expires <= now() + 30_000) {
        try {
          tokens = await exchange(record, {
            grant_type: 'refresh_token',
            refresh_token: tokens.refresh,
            redirect_uri: redirectUri,
          })
          if (tokens.user.gid !== record.tokens.user.gid)
            throw new RevokedError(
              'Asana returned a different account. Reconnect to authorize it explicitly.',
            )
        } catch (error) {
          if (error instanceof RevokedError && started === generation) {
            await store.write(
              { version: 1, clientId: record.clientId, clientSecret: record.clientSecret },
              place,
            )
            notice = error.message
          }
          throw error
        }
        if (started === generation) await store.write({ ...record, tokens }, place)
      }
      return { access: tokens.access, user: { gid: tokens.user.gid, name: tokens.user.name } }
    })
  }
  async function read(
    path: string,
    query: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    if (!/^\/[a-z_]+(\/\d{1,32}(\/[a-z_]+)?)?$/.test(path))
      throw new AsanaReadError('TED asked Asana for an unexpected path')
    const { access } = await accessToken().catch((error: unknown) => {
      throw new AsanaReadError(error instanceof Error ? error.message : 'Couldn’t read Asana')
    })
    const url = new URL(`/api/1.0${path}`, api)
    url.search = new URLSearchParams(query).toString()
    try {
      return await request(
        url.href,
        { headers: { authorization: `Bearer ${access}`, accept: 'application/json' } },
        maxReadBytes,
      )
    } catch (error) {
      if (error instanceof ConnectionError)
        throw new AsanaReadError(error.message, error.status, error.retryAfterMs)
      throw new AsanaReadError('Couldn’t reach Asana or read its response. Try again.')
    }
  }
  async function write(
    method: 'POST' | 'PUT',
    path: string,
    data: Record<string, string | boolean>,
  ): Promise<Record<string, unknown>> {
    const { access } = await accessToken().catch((error: unknown) => {
      throw new AsanaReadError(error instanceof Error ? error.message : 'Couldn’t reach Asana')
    })
    try {
      return await request(
        new URL(`/api/1.0${path}?opt_fields=gid`, api).href,
        {
          method,
          headers: {
            authorization: `Bearer ${access}`,
            accept: 'application/json',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ data }),
        },
        maxWriteBytes,
      )
    } catch (error) {
      if (error instanceof ConnectionError)
        throw new AsanaReadError(error.message, error.status, error.retryAfterMs)
      throw new AsanaReadError('Couldn’t reach Asana or read its response. Try again.')
    }
  }
  function taskGid(gid: string): string {
    if (!/^\d{1,32}$/.test(gid)) throw new AsanaReadError('TED asked Asana for an unexpected task')
    return gid
  }
  return {
    read,
    async comment(gid: string, text: string): Promise<void> {
      if (text.length === 0 || text.length > maxAsanaCommentLength)
        throw new AsanaReadError('TED tried to post a comment of an unexpected length')
      await write('POST', `/tasks/${taskGid(gid)}/stories`, { text })
    },
    async complete(gid: string): Promise<void> {
      await write('PUT', `/tasks/${taskGid(gid)}`, { completed: true })
    },
    async account(): Promise<string | undefined> {
      const current = await serial(status)
      return current.state === 'connected' ? current.user?.gid : undefined
    },
    async user() {
      return (await accessToken()).user
    },
    status: () => serial(status),
    configure(input: AsanaConfiguration) {
      const parsed = parseAsanaConfiguration(input)
      cancelSession()
      return serial(async () => {
        const old = await store.read().catch((error) => {
          if (
            (error instanceof KeyringUnavailableError || error instanceof CredentialCleanupError) &&
            error.reason === 'no-keyring' &&
            parsed.inFile
          )
            return { record: undefined, place: undefined }
          throw error
        })
        await store.write(
          { version: 1, clientId: parsed.clientId, clientSecret: parsed.clientSecret },
          parsed.inFile ? 'file' : 'keyring',
        )
        notice = undefined
        if (old.record) await revoke(old.record)
        return status()
      })
    },
    connect() {
      cancelSession()
      const started = generation
      const release = options.hold?.() ?? (() => undefined)
      return serial(async () => {
        notice = undefined
        const { record, place } = await store.read()
        if (!record || !place)
          throw new ConnectionError('Import your Asana app configuration first.')
        await store.write(
          { version: 1, clientId: record.clientId, clientSecret: record.clientSecret },
          place,
        )
        await revoke(record)
        if (generation !== started)
          throw new ConnectionError('Authorization was canceled. Try connecting again.')
        const state = randomBytes(32).toString('base64url')
        const verifier = randomBytes(32).toString('base64url')
        const expires = now() + (options.sessionMs ?? 5 * 60_000)
        const server = http.createServer((req, res) => {
          res.setHeader('connection', 'close')
          res.setHeader('content-type', 'text/plain; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          res.setHeader('referrer-policy', 'no-referrer')
          res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'")
          let url: URL
          try {
            url = new URL(req.url ?? '/', redirectUri)
          } catch {
            res.writeHead(400)
            res.end('Invalid authorization response. Return to TED.')
            return
          }
          const current = session
          if (
            req.method !== 'GET' ||
            req.headers.host !== `127.0.0.1:${port}` ||
            url.origin !== new URL(redirectUri).origin ||
            url.pathname !== '/asana/callback' ||
            !current ||
            current.state !== state ||
            current.generation !== generation ||
            now() >= expires ||
            url.searchParams.getAll('state').length !== 1 ||
            !sameState(url.searchParams.get('state'), state) ||
            url.searchParams.getAll('code').length > 1 ||
            url.searchParams.getAll('error').length > 1 ||
            url.searchParams.has('code') === url.searchParams.has('error')
          ) {
            res.writeHead(400)
            res.end('Invalid or expired authorization response. Return to TED.')
            return
          }
          const code = url.searchParams.get('code')
          current.timer.cancel()
          session = undefined
          server.close()
          res.once('finish', () => server.closeAllConnections())
          res.once('close', () => server.closeAllConnections())
          res.end('Authorization response received. Return to TED to see the result.')
          if (!code || code.length > 8192 || url.searchParams.has('error')) {
            notice = 'Authorization was denied or canceled. Connect to try again.'
            release()
            return
          }
          void serial(async () => {
            try {
              const tokens = await exchange(
                { version: 1, clientId: record.clientId, clientSecret: record.clientSecret },
                {
                  grant_type: 'authorization_code',
                  code,
                  code_verifier: verifier,
                  redirect_uri: redirectUri,
                },
              )
              if (started !== generation) return
              await store.write(
                {
                  version: 1,
                  clientId: record.clientId,
                  clientSecret: record.clientSecret,
                  tokens,
                },
                place,
              )
              notice = undefined
            } catch (error) {
              if (started === generation) notice = safeError(error)
            } finally {
              release()
            }
          })
        })
        server.requestTimeout = 5000
        server.headersTimeout = 5000
        server.maxHeadersCount = 30
        try {
          await new Promise<void>((resolve, reject) => {
            server.once('error', reject)
            server.listen(port, '127.0.0.1', () => {
              server.removeListener('error', reject)
              resolve()
            })
          })
        } catch {
          throw new ConnectionError(
            'The Asana callback port is busy. Close another TED instance using this edition and try again.',
          )
        }
        if (generation !== started) {
          server.close()
          server.closeAllConnections()
          throw new ConnectionError('Authorization was canceled.')
        }
        const timer = (options.clock ?? systemClock).timeout(
          () => {
            if (session?.state !== state) return
            cancelSession()
            notice = 'Authorization timed out. Connect to try again.'
          },
          options.sessionMs ?? 5 * 60_000,
        )
        timer.unref()
        session = { server, timer, state, verifier, expires, generation: started, release }
        const url = new URL('/-/oauth_authorize', 'https://app.asana.com')
        url.search = new URLSearchParams({
          client_id: record.clientId,
          response_type: 'code',
          redirect_uri: redirectUri,
          state,
          code_challenge_method: 'S256',
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
          scope: asanaScopes.join(' '),
        }).toString()
        return { url: url.href }
      }).catch((error: unknown) => {
        release()
        throw error
      })
    },
    cancel() {
      cancelSession()
      return serial(async () => {
        const { record, place } = await store.read()
        if (record?.tokens && place) {
          await store.write(
            { version: 1, clientId: record.clientId, clientSecret: record.clientSecret },
            place,
          )
          await revoke(record)
        }
        notice = 'Authorization canceled. Connect to try again.'
        return status()
      })
    },
    disconnect,
    remove: () => disconnect(true),
    test() {
      const started = generation
      return serial(async () => {
        notice = undefined
        const { record, place } = await store.read()
        if (!record?.tokens || !place) return status()
        try {
          let tokens = record.tokens
          if (tokens.expires <= now() + 30_000)
            tokens = await exchange(record, {
              grant_type: 'refresh_token',
              refresh_token: tokens.refresh,
              redirect_uri: redirectUri,
            })
          else {
            try {
              tokens = {
                ...tokens,
                scopes: await grantedScopes(record, tokens.access),
                user: await identity(tokens.access),
              }
            } catch (error) {
              if (!(error instanceof RevokedError)) throw error
              tokens = await exchange(record, {
                grant_type: 'refresh_token',
                refresh_token: tokens.refresh,
                redirect_uri: redirectUri,
              })
            }
          }
          if (tokens.user.gid !== record.tokens.user.gid)
            throw new RevokedError(
              'Asana returned a different account. Reconnect to authorize it explicitly.',
            )
          if (started !== generation) return status()
          await store.write({ ...record, tokens }, place)
        } catch (error) {
          if (started !== generation) return status()
          if (error instanceof RevokedError)
            await store.write(
              { version: 1, clientId: record.clientId, clientSecret: record.clientSecret },
              place,
            )
          notice = safeError(error)
        }
        return status()
      })
    },
    async close() {
      cancelSession()
      await tail
    },
  }
}
export type Asana = ReturnType<typeof createAsana>

function safeError(error: unknown) {
  return error instanceof ConnectionError
    ? error.message
    : 'Couldn’t save Asana credentials. Unlock your keyring and check file permissions, then reconnect.'
}
function checkedOrigin(input: string) {
  const url = new URL(input)
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (url.origin !== 'https://app.asana.com' &&
      !(url.protocol === 'http:' && url.hostname === '127.0.0.1'))
  )
    throw new Error('Asana endpoints must use the Asana HTTPS origin or a local test server')
  return url.origin
}

function sameState(actual: string | null, expected: string) {
  if (actual === null) return false
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function completeScopes(scopes: readonly string[] | undefined) {
  return (
    scopes !== undefined &&
    asanaScopes.every((scope) => scopes.includes(scope)) &&
    scopes.every((scope) => asanaScopes.includes(scope))
  )
}
