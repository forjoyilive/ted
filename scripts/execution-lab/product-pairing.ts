import { execFile } from 'node:child_process'
import dgram from 'node:dgram'
import { mkdir } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { redactSecrets } from '../../packages/daemon/src/redact.ts'
import { FixtureMachine } from '../../packages/daemon/test/support/execution-fixture.ts'
import {
  freeExecutionPort,
  pendingPairing,
} from '../../packages/daemon/test/support/execution-pairing.ts'
import {
  createExecutionRelay,
  type ExecutionRelay,
} from '../../packages/daemon/test/support/execution-relay.ts'
import type { WorkerStatus } from '../../packages/protocol/src/execution-pairing.ts'
import { productCommands } from './product-commands.ts'
import type { ProductWorkerAction } from './product-worker.ts'

export function supportedLanRoute(
  address: string,
  route: string,
  hardware: string,
  interfaces = networkInterfaces(),
): { address: string; interface: string; hardwarePort: string } {
  if (address.startsWith('127.'))
    throw new Error('Real two-Mac pairing requires a non-loopback local address')
  const device = /^\s*interface:\s*(\S+)\s*$/m.exec(route)?.[1]
  const ports = hardware.split(/\r?\n\s*\r?\n/)
  const port = ports.find((block) =>
    block.split(/\r?\n/).some((line) => line.trim() === `Device: ${device}`),
  )
  const hardwarePort = port && /^Hardware Port: (.+)$/m.exec(port)?.[1]
  if (
    !device ||
    !/^en\d+$/.test(device) ||
    !hardwarePort ||
    !/Wi-Fi|Ethernet/.test(hardwarePort) ||
    !interfaces[device]?.some((entry) => entry.address === address && !entry.internal)
  )
    throw new Error('Real two-Mac pairing requires a verified local Wi-Fi or Ethernet route')
  return { address, interface: device, hardwarePort }
}

async function localRoute(remote: string) {
  const socket = dgram.createSocket('udp4')
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject)
      socket.connect(22, remote, resolve)
    })
    const address = socket.address().address
    if (address.startsWith('127.'))
      throw new Error('Real two-Mac pairing requires a non-loopback local address')
    const exec = promisify(execFile)
    const [route, hardware] = await Promise.all([
      exec('/sbin/route', ['-n', 'get', remote]),
      exec('/usr/sbin/networksetup', ['-listallhardwareports']),
    ])
    return supportedLanRoute(address, route.stdout, hardware.stdout)
  } finally {
    socket.close()
  }
}
export async function productPairing(options: {
  run: string
  remoteAddress: string
  commands?: boolean
  worker(action: ProductWorkerAction): Promise<Record<string, unknown>>
}) {
  const root = path.join(options.run, 'ted-execution-pairing')
  await mkdir(root, { mode: 0o700 })
  const controller = new FixtureMachine(root, 'controller', 'daemon', path.basename(options.run))
  let workerStarted = false
  let relay: ExecutionRelay | undefined
  let step = 'prepare the controller fixture'
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
      relay?.close(),
    ])
    const failure = results.find((r) => r.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }
  try {
    await controller.prepare()
    await controller.start(60_000)
    step = 'add the synthetic Factory and open the listener'
    const factory = await controller.client.addFactory({ repo: controller.origin, key: 'LAB' })
    const local = await localRoute(options.remoteAddress)
    const { address } = local
    await controller.client.configureExecution({ address, port: await freeExecutionPort(address) })
    const listening = await controller.client.createExecutionEnrollment()
    if (options.commands) relay = await createExecutionRelay({ address, port: listening.port })
    const offer = { ...listening, port: relay?.port ?? listening.port }
    step = 'start the execution service and refuse a wrong identity'
    await options.worker({ operation: 'start' })
    workerStarted = true
    await options.worker({
      operation: 'pair',
      pair: { details: JSON.stringify({ ...offer, controllerPin: '0'.repeat(64) }), capacity: 2 },
    })
    const wrongIdentity = await state('refused')
    if (!wrongIdentity.status.message.includes('identity'))
      throw new Error('Wrong identity did not produce an identity refusal')
    step = 'refuse an incompatible version'
    const incompatible = await options.worker({
      operation: 'attempt',
      pair: { details: JSON.stringify(offer), capacity: 2 },
    })
    if (incompatible.refused !== true || incompatible.transport !== 'pinned-tls')
      throw new Error('Wrong protocol was not refused over product TLS')
    if ((await controller.client.executionMachines()).pending.length)
      throw new Error('Refused peer enrolled')
    await options.worker({
      operation: 'pair',
      pair: { details: JSON.stringify(offer), capacity: 2 },
    })
    step = 'pair and approve'
    const pending = await pendingPairing(controller)
    const beforeApproval = await state('pending')
    if (beforeApproval.status.publicKey !== pending.publicKey)
      throw new Error('Both Macs disagree on the worker identity')
    const scope = (await controller.client.executionMachines()).repos.find(
      (r) => r.factoryId === factory.id,
    )
    if (!scope) throw new Error('Missing approved synthetic repo')
    const grant = await controller.client.approveExecution({ id: pending.id, scopes: [scope] })
    step = 'connect with the approved credential'
    const connected = await state('connected')
    if (
      connected.status.controllerPin !== offer.controllerPin ||
      connected.status.grantId !== grant.id ||
      connected.status.readiness?.platform !== 'darwin' ||
      !connected.status.readiness.sandbox.available
    )
      throw new Error('Connected identities or actual native readiness differ')
    step = 'restart the execution service'
    await options.worker({ operation: 'restart' })
    const restarted = await state('connected')
    if (
      restarted.pid === connected.pid ||
      restarted.status.publicKey !== connected.status.publicKey ||
      restarted.status.grantId !== grant.id
    )
      throw new Error('Restart did not preserve identity/grant in a new process')
    const commands = relay
      ? await productCommands({
          controller,
          relay,
          grantId: grant.id,
          scope,
          factoryKey: factory.key,
          worker: options.worker,
          step(name) {
            step = name
          },
        })
      : undefined
    step = 'revoke the pairing'
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
        ...(commands?.invariants ?? []),
      ],
      ...(commands && { commands: commands.commands }),
      endpoint: { ...local, port: offer.port },
      controllerIdentity: offer.controllerPin,
      workerIdentity: pending.publicKey,
      grantId: grant.id,
      scopes: grant.scopes,
      authorization: {
        approval: 'app-authorized controller client',
        wrongIdentity: 'refused before enrollment',
        wrongVersion: 'refused by controller over pinned TLS',
        revocation: 'live connection stopped; restart refused',
      },
      workerPids: { before: connected.pid, after: restarted.pid },
      readiness: connected.status.readiness,
      taskExecution: false,
      relay: relay ? 'owned relay on the controller’s local address' : 'none',
    }
  } catch (error) {
    const output = redactSecrets(controller.diagnostic)
      .replace(/[^\x20-\x7e\n]/g, ' ')
      .slice(-2000)
    throw new Error(
      `Product checkpoint failed at step “${step}”: ${
        error instanceof Error ? error.message : 'unknown error'
      }\nController fixture output (last 2000 characters):\n${output}`,
      { cause: error },
    )
  } finally {
    await cleanup()
  }
}
