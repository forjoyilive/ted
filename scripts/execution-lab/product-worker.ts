import path from 'node:path'
import { readPrivate } from '../../packages/daemon/src/execution/files.ts'
import {
  startExecutionService,
  stopExecutionService,
  workerRequest,
} from '../../packages/daemon/src/execution/service.ts'
import type { WorkerPairRequest } from '../../packages/protocol/src/execution-pairing.ts'

export interface ProductWorkerAction {
  operation: 'start' | 'stop' | 'restart' | 'status' | 'pair' | 'attempt'
  pair?: WorkerPairRequest
}
export async function productWorker(
  run: string,
  env: NodeJS.ProcessEnv,
  action: ProductWorkerAction,
) {
  const home = path.join(run, 'execution-worker')
  const environment = { ...env, TED_EXECUTION_HOME: home }
  if (action.operation === 'stop') {
    await stopExecutionService(home)
    return { stopped: true }
  }
  if (action.operation === 'restart') {
    await stopExecutionService(home)
    await startExecutionService(home, environment)
    await workerRequest(home, 'start')
  }
  if (action.operation === 'start') await startExecutionService(home, environment)
  if (action.operation === 'pair' || action.operation === 'attempt') {
    if (!action.pair) throw new Error('Pairing input is required')
    if (action.operation === 'attempt') {
      try {
        await workerRequest(home, 'pair', action.pair)
      } catch {
        return { refused: true, status: await workerRequest(home, 'status') }
      }
      throw new Error('Expected incompatible version to be refused')
    }
    await workerRequest(home, 'stop')
    await workerRequest(home, 'pair', action.pair)
  }
  const { pid } = JSON.parse(await readPrivate(home, 'control.json')) as { pid: number }
  return { status: await workerRequest(home, 'status'), pid }
}
