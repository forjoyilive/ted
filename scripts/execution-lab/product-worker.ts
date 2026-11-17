import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { readPrivate } from '../../packages/daemon/src/execution/files.ts'
import {
  startExecutionService,
  stopExecutionService,
  workerRequest,
} from '../../packages/daemon/src/execution/service.ts'
import {
  ExecutionRefused,
  executionRequest,
} from '../../packages/daemon/src/execution/transport.ts'
import {
  executionHello,
  parseExecutionOffer,
  type WorkerPairRequest,
} from '../../packages/protocol/src/execution-pairing.ts'

export interface ProductWorkerAction {
  operation: 'start' | 'stop' | 'restart' | 'status' | 'pair' | 'attempt' | 'release' | 'effects'
  pair?: WorkerPairRequest
  operationId?: string
}
export async function productWorker(
  run: string,
  env: NodeJS.ProcessEnv,
  action: ProductWorkerAction,
) {
  const home = path.join(run, 'execution-worker')
  const environment = { ...env, TED_EXECUTION_HOME: home }
  if (action.operation === 'release' || action.operation === 'effects') {
    const id = action.operationId
    if (!id || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id))
      throw new Error('An operation ID is required')
    if (action.operation === 'release') {
      await writeFile(path.join(home, 'probe', `${id}.release`), '', { mode: 0o600 })
      return { released: true }
    }
    const lines = await readFile(path.join(home, 'probe', 'effects.log'), 'utf8').catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return ''
        throw error
      },
    )
    return { count: lines.split('\n').filter((line) => line === id).length }
  }
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
      const offer = parseExecutionOffer(JSON.parse(action.pair.details))
      const status = await workerRequest(home, 'status')
      if (!status.readiness) throw new Error('Worker has not reported readiness')
      try {
        await executionRequest({ ...offer, port: offer.pairingPort }, '/enroll', {
          ...executionHello(),
          protocol: 999,
          name: 'Lab version refusal',
          csr: await readPrivate(home, 'worker.csr'),
          secret: offer.secret,
          readiness: status.readiness,
        })
      } catch (error) {
        if (
          error instanceof ExecutionRefused &&
          error.message === 'Invalid or incompatible execution message'
        )
          return { refused: true, transport: 'pinned-tls', protocol: 999 }
        throw error
      }
      throw new Error('Expected incompatible version to be refused')
    }
    await workerRequest(home, 'stop')
    await workerRequest(home, 'pair', action.pair)
  }
  const { pid } = JSON.parse(await readPrivate(home, 'control.json')) as { pid: number }
  return { status: await workerRequest(home, 'status'), pid }
}
