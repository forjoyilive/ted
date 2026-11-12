import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { StoredOperation } from '../../packages/daemon/src/store/execution-operations.ts'
import type { FixtureMachine } from '../../packages/daemon/test/support/execution-fixture.ts'
import type { ExecutionRelay } from '../../packages/daemon/test/support/execution-relay.ts'
import { executionIds, type TaskAssignment } from '../../packages/protocol/src/execution.ts'
import type { ExecutionCommand } from '../../packages/protocol/src/execution-commands.ts'
import type { ExecutionScope, WorkerStatus } from '../../packages/protocol/src/execution-pairing.ts'
import type { ProductWorkerAction } from './product-worker.ts'

export async function productCommands(options: {
  controller: FixtureMachine
  relay: ExecutionRelay
  grantId: string
  scope: ExecutionScope
  factoryKey: string
  worker(action: ProductWorkerAction): Promise<Record<string, unknown>>
  step?(name: string): void
}) {
  const { controller, relay } = options
  const step = options.step ?? (() => undefined)
  const scope = { factoryId: options.scope.factoryId, repo: options.scope.repo }
  async function until<T>(what: string, check: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + 90_000
    for (;;) {
      const value = await check().catch(() => undefined)
      if (value !== undefined) return value
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
      await delay(200)
    }
  }
  const row = (id: string) => controller.rpc<StoredOperation | null>({ action: 'operation', id })
  const state = (id: string, wanted: StoredOperation['state']) =>
    until(`operation ${wanted}`, async () => {
      const found = await row(id)
      return found?.state === wanted ? found : undefined
    })
  const status = async () =>
    (await options.worker({ operation: 'status' })) as { status: WorkerStatus; pid: number }
  const effects = async (operationId: string) =>
    (await options.worker({ operation: 'effects', operationId })).count as number

  step('commands: create and assign a synthetic Task')
  const task = await controller.client.createTask({
    factory: options.factoryKey,
    title: 'Synthetic lab command Task',
  })
  const assignment = await controller.rpc<TaskAssignment>({
    action: 'assign-remote',
    taskId: task.id,
    machineId: options.grantId,
  })
  step('commands: issue a waiting dummy operation')
  const operationId = `op-${randomUUID()}`
  await controller.rpc({
    action: 'issue',
    input: { operationId, taskId: task.id, scope, input: { wait: true } },
  })
  await state(operationId, 'running')
  step('commands: drop the acknowledgment of the result')
  relay.dropResponses(true)
  await options.worker({ operation: 'release', operationId })
  const recorded = await state(operationId, 'finished')
  const seen = relay.counts().connections
  await until('a repeated report without acknowledgment', async () =>
    relay.counts().connections >= seen + 2 ? true : undefined,
  )
  const unacknowledged = (await status()).status.operations?.waiting
  if (unacknowledged !== 1) throw new Error('The dropped acknowledgment reached the execution Mac')
  if ((await effects(operationId)) !== 1) throw new Error('The dummy operation did not run once')

  step('commands: cut the product connection and restart the execution service')
  relay.cut()
  await until('execution Mac to see the cut connection', async () =>
    (await status()).status.state === 'disconnected' ? true : undefined,
  )
  const before = await status()
  await options.worker({ operation: 'restart' })
  const after = await until('restarted execution service', async () => {
    const next = await status()
    return next.pid !== before.pid ? next : undefined
  })
  if (after.status.operations?.waiting !== 1)
    throw new Error('The execution service lost its unconfirmed result across a restart')
  step('commands: restart the controller')
  const controllerBefore = controller.pid
  await controller.kill()
  await controller.start(60_000)
  if (controller.pid === controllerBefore) throw new Error('The controller did not restart')
  if ((await row(operationId))?.state !== 'finished')
    throw new Error('The controller lost its recorded result across a restart')
  step('commands: reconnect and confirm the result')
  relay.dropResponses(false)
  relay.restore()
  await until('acknowledgment after reconnecting', async () =>
    (await status()).status.operations?.waiting === 0 ? true : undefined,
  )
  const counter = await effects(operationId)
  if (counter !== 1) throw new Error(`The durable side-effect counter is ${counter}, not one`)
  if (JSON.stringify(await row(operationId)) !== JSON.stringify(recorded))
    throw new Error('The recorded result changed after the duplicate report')

  step('commands: refuse a stale-generation command')
  const { operationId: _, assignedAt: __, ...ref } = assignment
  const newer: ExecutionCommand = {
    operationId: executionIds.operation(`op-${randomUUID()}`),
    ref: { ...ref, generation: 2 },
    scope,
    order: 2,
    kind: 'probe',
    input: {},
  }
  await controller.rpc({ action: 'inject', command: newer })
  await state(newer.operationId, 'finished')
  const stale = `op-${randomUUID()}`
  await controller.rpc({
    action: 'issue',
    input: { operationId: stale, taskId: task.id, scope, input: {} },
  })
  const refused = await state(stale, 'refused')
  if (refused.report?.refusal !== 'stale' || (await effects(stale)) !== 0)
    throw new Error('A stale-generation command was not refused before its side effect')

  return {
    invariants: ['two-mac-command-once', 'two-mac-service-restarts', 'two-mac-stale-refused'],
    commands: {
      operationId,
      droppedAcknowledgment: 'result recorded on the controller; execution Mac kept it unconfirmed',
      connectionCut: 'owned relay only',
      executionServicePids: { before: before.pid, after: after.pid },
      controllerRestarted: true,
      sideEffectCounter: counter,
      staleGeneration: { current: 2, refused: 1, refusal: refused.report?.refusal, sideEffects: 0 },
    },
  }
}
