import { randomUUID } from 'node:crypto'
import { statfs } from 'node:fs/promises'
import { hostname } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import {
  type ExecutionCertificate,
  type ExecutionOffer,
  executionCapacity,
  executionHello,
  executionLimits,
  parseExecutionCertificate,
  parseExecutionOffer,
  parseExecutionSyncResponse,
  requireExecutionCompatibility,
  type WorkerPairRequest,
  type WorkerStatus,
} from '@ted/protocol'
import { certificatePin, workerIdentity } from './certificates.ts'
import { privateDirectory, readPrivate, writePrivate } from './files.ts'
import { createExecutionOperations } from './operations.ts'
import { createExecutionReadiness } from './readiness.ts'
import { workerOperationsText } from './status-text.ts'
import { ExecutionRefused, executionRequest } from './transport.ts'

interface Saved {
  endpoint: Pick<ExecutionOffer, 'address' | 'port' | 'controllerPin'>
  credential: ExecutionCertificate
  capacity: number
}
export async function createExecutionWorker(home: string, env: NodeJS.ProcessEnv) {
  const root = await privateDirectory(home)
  const identity = await workerIdentity(root)
  const readiness = createExecutionReadiness(root, env)
  let saved: Saved | undefined
  try {
    saved = JSON.parse(await readPrivate(root, 'pairing.json')) as Saved
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (saved) {
    parseExecutionOffer({
      ...saved.endpoint,
      ...executionHello(),
      secret: '0'.repeat(64),
      expiresAt: new Date().toISOString(),
    })
    saved.credential = parseExecutionCertificate(saved.credential)
    executionCapacity(saved.capacity)
    if (
      certificatePin(saved.credential.certificate) !== identity.pin ||
      certificatePin(saved.credential.ca) !== saved.endpoint.controllerPin
    )
      throw new Error('Saved execution credential does not match the worker or controller identity')
  }
  let status: WorkerStatus = {
    state: 'stopped',
    message: 'Worker stopped. Start to reconnect, or paste pairing details to connect.',
    publicKey: identity.pin,
    scopes: saved?.credential.scopes ?? [],
    ...(saved && {
      controllerPin: saved.endpoint.controllerPin,
      grantId: saved.credential.grantId,
    }),
  }
  let abort: AbortController | undefined, working: Promise<void> | undefined
  let stopped = false
  let turn: AbortController | undefined
  const operations = await createExecutionOperations({
    home: root,
    changed: () => turn?.abort(),
    identity: () => saved && { grantId: saved.credential.grantId, scopes: saved.credential.scopes },
    async freeBytes() {
      const disk = await statfs(root)
      return Number(disk.bavail) * Number(disk.bsize)
    },
  })
  async function sync(): Promise<void> {
    let session = randomUUID()
    let inventory = true
    try {
      while (abort && !abort.signal.aborted && saved) {
        const signal = abort.signal
        const waiting = new AbortController()
        turn = waiting
        try {
          const response = parseExecutionSyncResponse(
            await executionRequest(
              saved.endpoint,
              '/sync',
              {
                ...executionHello(),
                grantId: saved.credential.grantId,
                session,
                ...(await operations.request(inventory)),
              },
              {
                key: identity.key,
                cert: saved.credential.certificate,
                signal: AbortSignal.any([signal, waiting.signal]),
                maxBytes: executionLimits.syncResponseBytes,
              },
            ),
          )
          if (signal.aborted) return
          inventory = response.needInventory
          if (inventory) operations.allow(false)
          else {
            await operations.handle(response)
            operations.allow(response.reconciled)
          }
        } catch {
          if (waiting.signal.aborted && !signal.aborted) continue
          operations.allow(false)
          if (signal.aborted) return
          session = randomUUID()
          inventory = true
          await delay(1000, undefined, { signal }).catch(() => undefined)
        }
      }
    } finally {
      operations.allow(false)
    }
  }
  const changeStatus = (change: Partial<WorkerStatus>) => {
    status = { ...status, ...change }
  }
  const connect = () => Promise.all([report(), sync()]).then(() => undefined)
  async function report(): Promise<void> {
    while (abort && !abort.signal.aborted && saved) {
      const signal = abort.signal
      try {
        const observed = await readiness(saved.capacity)
        if (signal.aborted) return
        changeStatus({ readiness: observed })
        await executionRequest(
          saved.endpoint,
          '/heartbeat',
          { ...executionHello(), grantId: saved.credential.grantId, readiness: observed },
          { key: identity.key, cert: saved.credential.certificate, signal },
        )
        changeStatus({
          state: 'connected',
          message: 'Connected. Reporting readiness; remote Task execution comes later.',
        })
      } catch (error) {
        if (signal.aborted) return
        if (error instanceof ExecutionRefused) {
          await writePrivate(root, 'refused', 'Fresh pairing requires user approval.\n')
          abort.abort()
          changeStatus({ state: 'refused', message: error.message })
          return
        }
        changeStatus({
          state: 'disconnected',
          message:
            'Controller unreachable. Check both Macs are awake, TED is running on the main Mac, and both are on the same reachable local network.',
        })
        await delay(2000, undefined, { signal }).catch(() => undefined)
      }
    }
  }
  async function halt(): Promise<void> {
    abort?.abort()
    await working
    working = undefined
    abort = undefined
  }
  async function refused(): Promise<boolean> {
    try {
      return (await readPrivate(root, 'refused')).trim() !== ''
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return false
    }
  }
  return {
    status(): WorkerStatus {
      const counts = operations.counts()
      const text = workerOperationsText(status.state, counts)
      return structuredClone({
        ...status,
        operations: counts,
        ...(text && {
          message:
            status.state === 'connected' ? `Connected. ${text}` : `${status.message} ${text}`,
        }),
      })
    },
    async start() {
      if (stopped) throw new Error('Execution service is stopping')
      if (working) return
      if (!saved) {
        status = {
          ...status,
          state: 'unpaired',
          message: 'Paste pairing details from the main Mac.',
        }
        return
      }
      if (await refused()) {
        status = {
          ...status,
          state: 'refused',
          message: 'This grant was refused. Fresh pairing needs approval on the main Mac.',
        }
        return
      }
      abort = new AbortController()
      status = { ...status, state: 'connecting', message: 'Connecting to the saved controller…' }
      working = connect()
        .catch(() => {
          status = {
            ...status,
            state: 'refused',
            message:
              'Worker could not safely save its connection state. Stop and inspect its isolated storage.',
          }
        })
        .finally(() => {
          working = undefined
          abort = undefined
        })
    },
    async pair(input: WorkerPairRequest) {
      if (stopped) throw new Error('Execution service is stopping')
      const offer = parseExecutionOffer(JSON.parse(input.details))
      requireExecutionCompatibility(offer)
      if (Date.parse(offer.expiresAt) <= Date.now())
        throw new ExecutionRefused('Pairing details expired. Create new details on the main Mac.')
      const capacity = executionCapacity(input.capacity)
      const observed = await readiness(capacity)
      if (observed.freeBytes < 1024 ** 3)
        throw new Error('Worker needs at least 1 GB free before starting a new connection')
      await halt()
      if (stopped) throw new Error('Execution service is stopping')
      abort = new AbortController()
      const signal = abort.signal
      status = {
        state: 'connecting',
        message: 'Verifying the controller identity…',
        publicKey: identity.pin,
        controllerPin: offer.controllerPin,
        readiness: observed,
        scopes: [],
      }
      working = (async () => {
        try {
          const response = await executionRequest(
            offer,
            '/enroll',
            {
              ...executionHello(),
              name:
                hostname()
                  .replace(/[^a-zA-Z0-9._ -]/g, '')
                  .slice(0, 80) || 'Execution Mac',
              csr: identity.csr,
              secret: offer.secret,
              readiness: observed,
            },
            {
              signal,
              onVerified: () => {
                if (!signal.aborted)
                  status = {
                    ...status,
                    state: 'pending',
                    message:
                      'Waiting for approval on the main Mac. Compare this worker identity on both screens.',
                  }
              },
              timeoutMs: Math.min(
                5 * 60_000,
                Math.max(1, Date.parse(offer.expiresAt) - Date.now()),
              ),
            },
          )
          const credential = parseExecutionCertificate(response)
          if (
            certificatePin(credential.ca) !== offer.controllerPin ||
            certificatePin(credential.certificate) !== identity.pin
          )
            throw new ExecutionRefused('Issued certificate does not match the paired identities')
          if (signal.aborted) return
          saved = {
            endpoint: {
              address: offer.address,
              port: offer.port,
              controllerPin: offer.controllerPin,
            },
            credential,
            capacity,
          }
          await writePrivate(root, 'pairing.json', JSON.stringify(saved))
          await writePrivate(root, 'refused', '')
          status = {
            ...status,
            grantId: credential.grantId,
            scopes: credential.scopes,
            state: 'connecting',
            message: 'Pairing approved. Connecting with this Mac’s credential…',
          }
          await connect()
        } catch (error) {
          if (!signal.aborted)
            status = {
              ...status,
              state: 'refused',
              message:
                error instanceof ExecutionRefused
                  ? error.message
                  : 'Pairing could not complete. Check the network and create fresh details on the main Mac.',
            }
        }
      })().finally(() => {
        working = undefined
        abort = undefined
      })
    },
    async stop() {
      await halt()
      status = { ...status, state: 'stopped', message: 'Worker stopped. Pairing is retained.' }
    },
    async close() {
      stopped = true
      await halt()
      await operations.close()
    },
  }
}
export type ExecutionWorker = Awaited<ReturnType<typeof createExecutionWorker>>
