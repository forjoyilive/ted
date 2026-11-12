import { createHash, randomBytes, randomUUID, timingSafeEqual, X509Certificate } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import https from 'node:https'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import type { TLSSocket } from 'node:tls'
import {
  type ApproveExecution,
  type ExecutionCertificate,
  type ExecutionEndpoint,
  type ExecutionGrant,
  type ExecutionMachines,
  type ExecutionOffer,
  type ExecutionPending,
  type ExecutionReadiness,
  enrollmentLifetimeMs,
  executionHello,
  parseExecutionEndpoint,
  parseExecutionEnrollment,
  parseExecutionHeartbeat,
  requireExecutionCompatibility,
} from '@ted/protocol'
import { RequestError } from '../errors.ts'
import type { TedStore } from '../store/index.ts'
import {
  certificatePin,
  controllerIdentity,
  csrPin,
  type ExecutionIdentity,
  issueCertificate,
} from './certificates.ts'

export function localExecutionAddresses(): { name: string; address: string }[] {
  return Object.entries(networkInterfaces()).flatMap(([name, entries]) =>
    (entries ?? [])
      .filter((e) => e.family === 'IPv4' && !e.internal)
      .flatMap((e) => {
        try {
          parseExecutionEndpoint({ address: e.address, port: 47443 })
          return [{ name, address: e.address }]
        } catch {
          return []
        }
      }),
  )
}
export const executionCertificateId = (cert: string | Buffer) =>
  createHash('sha256').update(new X509Certificate(cert).raw).digest('hex')
interface Pending extends ExecutionPending {
  csr: string
  finish(code: number, body: unknown): void
  timer: NodeJS.Timeout
  approving: boolean
}
function answer(res: ServerResponse, code: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}
async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += (chunk as Buffer).length
    if (bytes > 16 * 1024) throw new RequestError(413, 'Execution message too large')
    chunks.push(chunk as Buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
export function createExecutionController(options: {
  home: string
  store: Pick<TedStore, 'pairing' | 'persisted' | 'newWorkHold'>
  repos(): Promise<ExecutionMachines['repos']>
  now?: () => number
  onProblem?: (text: string | undefined) => void
}) {
  const { store } = options,
    root = path.join(options.home, 'execution-controller')
  const now = options.now ?? Date.now
  let server: https.Server | undefined,
    identity: ExecutionIdentity | undefined,
    endpoint: ExecutionEndpoint | undefined,
    problem: string | undefined
  let offer: { secret: string; expiresAt: number } | undefined
  let enrollmentBusy = false,
    attempts = 0,
    attemptsSince = 0,
    closed = false
  let mutation = Promise.resolve()
  const pending = new Map<string, Pending>()
  const snapshots = new Map<string, ExecutionReadiness>()
  const lastSeen = new Map<string, number>()
  const sessions = new Map<string, Set<ServerResponse>>()
  const sockets = new Set<TLSSocket>()
  const disabled = new Set<string>()
  const unavailableFactories = new Set<string>()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = mutation.then(work)
    mutation = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
  const validPending = (id: string): Pending => {
    const row = pending.get(id)
    if (!row || Date.parse(row.expiresAt) <= now())
      throw new RequestError(410, 'Pairing expired. Create new details on the main Mac.')
    return row
  }
  function expirePending(): void {
    for (const row of pending.values()) {
      clearTimeout(row.timer)
      row.finish(410, { error: 'Pairing expired. Create new details on the main Mac.' })
    }
    pending.clear()
  }
  async function scopesExist(scopes: ExecutionGrant['scopes']): Promise<boolean> {
    const repos = (await options.repos()).filter((r) => !unavailableFactories.has(r.factoryId))
    return (
      scopes.length > 0 &&
      scopes.every((s) =>
        repos.some(
          (r) => r.factoryId === s.factoryId && r.repo.toLowerCase() === s.repo.toLowerCase(),
        ),
      )
    )
  }
  function current(id: string): ExecutionGrant {
    const grant = store.pairing.grants().find((g) => g.id === id)
    if (!grant || grant.revokedAt || disabled.has(id))
      throw new RequestError(
        403,
        'Execution access revoked or unavailable; fresh pairing requires approval',
      )
    return grant
  }
  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (closed) throw new RequestError(503, 'Execution listener is closing')
    if (req.method === 'POST' && req.url === '/enroll') {
      if (now() - attemptsSince > 60_000) {
        attempts = 0
        attemptsSince = now()
      }
      if (++attempts > 20 || enrollmentBusy || pending.size > 0)
        throw new RequestError(429, 'Pairing is busy. Try again shortly.')
      const input = parseExecutionEnrollment(await body(req))
      requireExecutionCompatibility(input)
      const active = offer
      if (
        !active ||
        active.expiresAt <= now() ||
        !timingSafeEqual(Buffer.from(active.secret), Buffer.from(input.secret))
      )
        throw new RequestError(410, 'Pairing details expired or already used')
      enrollmentBusy = true
      try {
        const publicKey = await csrPin(root, input.csr)
        if (offer !== active || active.expiresAt <= now())
          throw new RequestError(410, 'Pairing expired')
        offer = undefined
        const id = randomUUID()
        const row: Pending = {
          id,
          name: input.name,
          publicKey,
          expiresAt: new Date(active.expiresAt).toISOString(),
          readiness: input.readiness,
          csr: input.csr,
          approving: false,
          finish: (code, value) => answer(res, code, value),
          timer: setTimeout(
            () => {
              pending.delete(id)
              answer(res, 410, { error: 'Pairing expired. Create new details on the main Mac.' })
            },
            Math.max(1, active.expiresAt - now()),
          ),
        }
        pending.set(id, row)
        res.once('close', () => {
          clearTimeout(row.timer)
          if (pending.get(id) === row) pending.delete(id)
        })
      } finally {
        enrollmentBusy = false
      }
      return
    }
    if (req.method !== 'POST' || req.url !== '/heartbeat')
      throw new RequestError(404, 'No such execution operation')
    const socket = req.socket as TLSSocket
    if (!socket.authorized)
      throw new RequestError(403, 'A paired execution certificate is required')
    const cert = socket.getPeerCertificate().raw
    if (!cert) throw new RequestError(403, 'Missing execution identity')
    const presentedId = executionCertificateId(cert)
    const presented = store.pairing.grants().find((g) => g.certificateId === presentedId)
    if (!presented) throw new RequestError(403, 'Execution certificate has no approved grant')
    current(presented.id)
    const input = parseExecutionHeartbeat(await body(req))
    requireExecutionCompatibility(input)
    let grant = current(input.grantId)
    if (grant.certificateId !== presentedId || grant.publicKey !== certificatePin(cert))
      throw new RequestError(403, 'Execution identity does not match this grant')
    if (!(await scopesExist(grant.scopes)))
      throw new RequestError(403, 'Approved Factory or repo is no longer available; pair again')
    grant = current(input.grantId)
    if (closed) throw new RequestError(503, 'Execution listener is closing')
    const active = sessions.get(grant.id) ?? new Set<ServerResponse>()
    if (active.size >= 2) throw new RequestError(429, 'Too many execution connections')
    active.add(res)
    sessions.set(grant.id, active)
    snapshots.set(grant.id, input.readiness)
    lastSeen.set(grant.id, now())
    const timer = setTimeout(() => {
      try {
        current(grant.id)
        answer(res, 200, { connected: true })
      } catch {
        answer(res, 403, { stop: true, error: 'Execution access revoked' })
      }
    }, 2000)
    res.once('close', () => {
      clearTimeout(timer)
      active.delete(res)
      if (active.size === 0) sessions.delete(grant.id)
    })
  }
  async function listen(next: ExecutionEndpoint): Promise<void> {
    const addresses = Object.values(networkInterfaces())
      .flatMap((e) => e ?? [])
      .map((e) => e.address)
    if (!addresses.includes(next.address))
      throw new RequestError(400, 'Choose an address assigned to this Mac')
    if (server) {
      if (endpoint?.address === next.address && endpoint.port === next.port) return
      offer = undefined
      expirePending()
      for (const socket of sockets) socket.destroy()
      const activeServer = server
      await new Promise<void>((resolve) => activeServer.close(() => resolve()))
      server = undefined
      endpoint = undefined
    }
    identity ??= await controllerIdentity(root)
    const listening = https.createServer(
      {
        key: identity.key,
        cert: identity.cert,
        ca: identity.cert,
        requestCert: true,
        rejectUnauthorized: false,
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
        handshakeTimeout: 10_000,
      },
      (req, res) => {
        void route(req, res).catch((error: unknown) => {
          const code = error instanceof RequestError ? error.status : 400
          if (code === 403) res.once('finish', () => req.socket.end())
          answer(res, code, {
            error:
              code === 403
                ? 'Execution access refused; pairing or approval is required'
                : error instanceof RequestError
                  ? error.message
                  : 'Invalid or incompatible execution message',
          })
        })
      },
    )
    listening.maxConnections = 32
    listening.requestTimeout = 15_000
    listening.headersTimeout = 10_000
    listening.keepAliveTimeout = 1000
    listening.on('secureConnection', (socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
    await new Promise<void>((resolve, reject) => {
      listening.once('error', reject)
      listening.listen(next.port, next.address, () => {
        listening.removeListener('error', reject)
        resolve()
      })
    })
    listening.on('error', () => {
      problem = 'Execution listener failed. Restart TED and check the local address and port.'
      options.onProblem?.(problem)
    })
    server = listening
    endpoint = next
    problem = undefined
    options.onProblem?.(undefined)
  }
  return {
    async start() {
      const saved = store.pairing.endpoint()
      if (saved)
        try {
          await listen(saved)
        } catch {
          problem =
            'Could not restore execution listener. Check this Mac’s local address and restart TED.'
          options.onProblem?.(problem)
        }
    },
    configure(input: ExecutionEndpoint) {
      return serial(async () => {
        if (store.newWorkHold())
          throw new RequestError(507, 'New work is held while storage is unavailable')
        const next = parseExecutionEndpoint(input)
        await listen(next)
        store.pairing.configure(next)
        try {
          await store.persisted()
        } catch (error) {
          await this.close()
          throw error
        }
      })
    },
    cancelEnrollment() {
      offer = undefined
      expirePending()
    },
    createEnrollment(): ExecutionOffer {
      if (!server || !endpoint || !identity || closed)
        throw new RequestError(409, 'Configure the local execution listener first')
      if (store.newWorkHold())
        throw new RequestError(507, 'New work is held while storage is unavailable')
      expirePending()
      offer = { secret: randomBytes(32).toString('hex'), expiresAt: now() + enrollmentLifetimeMs }
      return {
        ...endpoint,
        ...executionHello(),
        controllerPin: identity.pin,
        secret: offer.secret,
        expiresAt: new Date(offer.expiresAt).toISOString(),
      }
    },
    async list(): Promise<ExecutionMachines> {
      return {
        ...(endpoint && { endpoint }),
        ...(identity && { controllerPin: identity.pin }),
        ...(problem && { problem }),
        addresses: localExecutionAddresses(),
        pending: [...pending.values()]
          .filter((p) => Date.parse(p.expiresAt) > now())
          .map(({ id, name, publicKey, expiresAt, readiness }) => ({
            id,
            name,
            publicKey,
            expiresAt,
            readiness,
          })),
        machines: store.pairing.grants().map((g) => ({
          ...g,
          connected:
            !g.revokedAt &&
            !disabled.has(g.id) &&
            (sessions.has(g.id) || now() - (lastSeen.get(g.id) ?? 0) < 10_000),
          ...(snapshots.get(g.id) ? { readiness: snapshots.get(g.id) as ExecutionReadiness } : {}),
        })),
        repos: await options.repos(),
      }
    },
    approve(input: ApproveExecution) {
      return serial(async () => {
        if (store.newWorkHold())
          throw new RequestError(507, 'Storage is unavailable; pairing approval is held')
        const row = validPending(input.id)
        const authority = identity
        if (!authority) throw new RequestError(409, 'Execution identity is unavailable')
        if (row.approving) throw new RequestError(409, 'Pairing is already being approved')
        row.approving = true
        try {
          if (!(await scopesExist(input.scopes)))
            throw new RequestError(400, 'Select existing Factory repos')
          const certificate = await issueCertificate(root, row.csr, row.id)
          if (validPending(row.id) !== row || closed) throw new RequestError(410, 'Pairing expired')
          if (!(await scopesExist(input.scopes)))
            throw new RequestError(400, 'Selected repos changed; review them again')
          validPending(row.id)
          const grant: ExecutionGrant = {
            id: row.id,
            name: row.name,
            publicKey: row.publicKey,
            certificateId: executionCertificateId(certificate),
            scopes: input.scopes,
            approvedAt: new Date(now()).toISOString(),
          }
          disabled.add(grant.id)
          store.pairing.approve(grant)
          await store.persisted()
          if (Date.parse(row.expiresAt) <= now() || pending.get(row.id) !== row) {
            store.pairing.revoke(grant.id)
            await store.persisted()
            throw new RequestError(410, 'Pairing expired before it could be saved')
          }
          disabled.delete(grant.id)
          pending.delete(row.id)
          clearTimeout(row.timer)
          const reply: ExecutionCertificate = {
            grantId: grant.id,
            certificate,
            ca: authority.cert,
            scopes: grant.scopes,
          }
          row.finish(200, reply)
          return grant
        } finally {
          row.approving = false
        }
      })
    },
    reject(id: string) {
      const row = validPending(id)
      if (row.approving) throw new RequestError(409, 'Pairing is being approved')
      pending.delete(id)
      clearTimeout(row.timer)
      row.finish(403, { error: 'Pairing rejected by the user' })
    },
    revoke(id: string) {
      return serial(async () => {
        current(id)
        disabled.add(id)
        store.pairing.revoke(id)
        await store.persisted()
        for (const res of sessions.get(id) ?? []) {
          const socket = res.socket
          answer(res, 403, { stop: true, error: 'Access revoked by the controller' })
          socket?.end()
        }
        sessions.delete(id)
      })
    },
    async forgetFactory(factoryId: string) {
      unavailableFactories.add(factoryId)
      for (const grant of store.pairing.grants())
        if (!grant.revokedAt && grant.scopes.some((s) => s.factoryId === factoryId))
          await this.revoke(grant.id)
      store.pairing.forgetFactory(factoryId)
      await store.persisted()
    },
    async close() {
      closed = true
      offer = undefined
      expirePending()
      for (const socket of sockets) socket.destroy()
      const activeServer = server
      if (activeServer) await new Promise<void>((resolve) => activeServer.close(() => resolve()))
      server = undefined
    },
  }
}
export type ExecutionController = ReturnType<typeof createExecutionController>
