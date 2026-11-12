import dgram from 'node:dgram'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { FixtureMachine } from '../../packages/daemon/test/support/execution-fixture.ts'
import {
  freeExecutionPort,
  pendingPairing,
} from '../../packages/daemon/test/support/execution-pairing.ts'
import type { WorkerStatus } from '../../packages/protocol/src/execution-pairing.ts'
import type { ProductWorkerAction } from './product-worker.ts'

async function localRoute(remote: string): Promise<string> {
  const socket = dgram.createSocket('udp4')
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject)
      socket.connect(22, remote, resolve)
    })
    return socket.address().address
  } finally {
    socket.close()
  }
}
export async function productPairing(options: {
  run: string
  remoteAddress: string
  worker(action: ProductWorkerAction): Promise<Record<string, unknown>>
}) {
  const root = path.join(options.run, 'pairing-fixture')
  await mkdir(root, { mode: 0o700 })
  const controller = new FixtureMachine(root, 'controller', 'daemon', path.basename(options.run))
  let workerStarted = false
  async function state(wanted: WorkerStatus['state']) {
    const until = Date.now() + 45_000
    while (Date.now() < until) {
      const value = await options.worker({ operation: 'status' })
      const status = value.status as WorkerStatus
      if (status.state === wanted) return { status, pid: value.pid }
      await delay(150)
    }
    throw new Error(`Actual execution Mac did not reach ${wanted}`)
  }
  async function cleanup() {
    const results = await Promise.allSettled([
      workerStarted ? options.worker({ operation: 'stop' }) : Promise.resolve(),
      controller.close(),
    ])
    const failure = results.find((r) => r.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }
  try {
    await controller.prepare()
    await controller.start(60_000)
    const factory = await controller.client.addFactory({ repo: controller.origin, key: 'LAB' })
    const address = await localRoute(options.remoteAddress)
    if (address === '127.0.0.1')
      throw new Error('Real two-Mac pairing requires a non-loopback local address')
    await controller.client.configureExecution({ address, port: await freeExecutionPort(address) })
    const offer = await controller.client.createExecutionEnrollment()
    await options.worker({ operation: 'start' })
    workerStarted = true
    await options.worker({
      operation: 'pair',
      pair: { details: JSON.stringify({ ...offer, controllerPin: '0'.repeat(64) }), capacity: 2 },
    })
    const wrongIdentity = await state('refused')
    if (!wrongIdentity.status.message.includes('identity'))
      throw new Error('Wrong identity did not produce an identity refusal')
    const incompatible = await options.worker({
      operation: 'attempt',
      pair: { details: JSON.stringify({ ...offer, protocol: 999 }), capacity: 2 },
    })
    if (incompatible.refused !== true) throw new Error('Wrong protocol was not refused')
    if ((await controller.client.executionMachines()).pending.length)
      throw new Error('Refused peer enrolled')
    await options.worker({
      operation: 'pair',
      pair: { details: JSON.stringify(offer), capacity: 2 },
    })
    const pending = await pendingPairing(controller)
    const beforeApproval = await state('pending')
    if (beforeApproval.status.publicKey !== pending.publicKey)
      throw new Error('Both Macs disagree on the worker identity')
    const scope = (await controller.client.executionMachines()).repos.find(
      (r) => r.factoryId === factory.id,
    )
    if (!scope) throw new Error('Missing approved synthetic repo')
    const grant = await controller.client.approveExecution({ id: pending.id, scopes: [scope] })
    const connected = await state('connected')
    if (
      connected.status.controllerPin !== offer.controllerPin ||
      connected.status.grantId !== grant.id ||
      connected.status.readiness?.platform !== 'darwin' ||
      !connected.status.readiness.sandbox.available
    )
      throw new Error('Connected identities or actual native readiness differ')
    await options.worker({ operation: 'restart' })
    const restarted = await state('connected')
    if (
      restarted.pid === connected.pid ||
      restarted.status.publicKey !== connected.status.publicKey ||
      restarted.status.grantId !== grant.id
    )
      throw new Error('Restart did not preserve identity/grant in a new process')
    await controller.client.revokeExecution({ id: grant.id })
    await state('refused')
    if (
      (await controller.client.executionMachines()).machines.find((m) => m.id === grant.id)
        ?.connected
    )
      throw new Error('Revoked peer remains connected')
    await options.worker({ operation: 'restart' })
    await state('refused')
    if ((await controller.agentStarts()) !== 0) throw new Error('Pairing started an agent')
    return {
      invariants: [
        'two-mac-pairing',
        'two-mac-worker-restart',
        'two-mac-peer-refusal',
        'two-mac-revocation',
      ],
      endpoint: { address, port: offer.port },
      controllerIdentity: offer.controllerPin,
      workerIdentity: pending.publicKey,
      grantId: grant.id,
      scopes: grant.scopes,
      authorization: {
        approval: 'app-authorized controller client',
        wrongIdentity: 'refused before enrollment',
        wrongVersion: 'refused',
        revocation: 'live connection stopped; restart refused',
      },
      workerPids: { before: connected.pid, after: restarted.pid },
      readiness: connected.status.readiness,
      taskExecution: false,
    }
  } finally {
    await cleanup()
  }
}
