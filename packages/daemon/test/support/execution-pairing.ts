import net from 'node:net'
import type { ExecutionOffer, ExecutionPending, WorkerStatus } from '@ted/protocol'
import {
  startExecutionService,
  stopExecutionService,
  workerRequest,
} from '../../src/execution/service.ts'
import { fixtureEnvironment, waitUntil } from '../helpers.ts'
import type { FixtureMachine } from './execution-fixture.ts'

export async function freeExecutionPort(address = '127.0.0.1'): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, address, resolve)
  })
  const endpoint = server.address()
  if (!endpoint || typeof endpoint === 'string') throw new Error('No port')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return endpoint.port
}
export async function preparePairingController(
  controller: FixtureMachine,
  address = '127.0.0.1',
): Promise<{ offer: ExecutionOffer; factoryId: string }> {
  const factory = await controller.client.addFactory({ repo: controller.origin, key: 'PAIR' })
  await controller.client.configureExecution({ address, port: await freeExecutionPort(address) })
  return { offer: await controller.client.createExecutionEnrollment(), factoryId: factory.id }
}
export function executionWorkerFixture(home: string, owner?: string) {
  const env = { ...fixtureEnvironment(home), TED_EXECUTION_HOME: home }
  let started = false
  return {
    home,
    async start() {
      const result = await startExecutionService(home, env, owner)
      started = true
      return result
    },
    request: (
      operation: 'status' | 'start' | 'stop' | 'pair',
      input?: { details: string; capacity: number },
    ) => workerRequest(home, operation, input),
    async state(state: WorkerStatus['state']) {
      return waitUntil(
        async () => {
          const s = await workerRequest(home, 'status')
          return s.state === state ? s : undefined
        },
        `worker ${state}`,
        45_000,
      )
    },
    async close() {
      if (started) {
        await stopExecutionService(home)
        started = false
      }
    },
  }
}
export async function pendingPairing(controller: FixtureMachine): Promise<ExecutionPending> {
  return waitUntil(
    async () => (await controller.client.executionMachines()).pending[0],
    'pending execution approval',
    30_000,
  )
}
