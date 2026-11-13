import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  type ExecutionCommand,
  type ExecutionGrant,
  type ExecutionLimits,
  type ExecutionReport,
  type ExecutionSyncRequest,
  executionHello,
  executionIds,
  executionLimits,
  type ProbeInput,
  type TaskAssignment,
} from '@ted/protocol'
import { expect, test } from 'vitest'
import { createExecutionCommands } from '../src/execution/commands.ts'
import { readPrivate } from '../src/execution/files.ts'
import { createExecutionOperations } from '../src/execution/operations.ts'
import { machineOperationsText, workerOperationsText } from '../src/execution/status-text.ts'
import { executionRequest } from '../src/execution/transport.ts'
import type { StoredOperation } from '../src/store/execution-operations.ts'
import { openStore } from '../src/store/index.ts'
import { createTaskExecution } from '../src/tasks/execution.ts'
import { waitUntil } from './helpers.ts'
import { createExecutionFixture } from './support/execution-fixture.ts'
import { observe } from './support/execution-observations.ts'
import {
  executionWorkerFixture,
  pendingPairing,
  preparePairingController,
} from './support/execution-pairing.ts'
import { createExecutionRelay } from './support/execution-relay.ts'

const refOf = ({ operationId: _, assignedAt: __, ...ref }: TaskAssignment) => ref

test('a dummy operation runs once through lost messages, restarts of either service, a stop and stale commands', async () => {
  const fixture = await createExecutionFixture()
  const worker = executionWorkerFixture(path.join(fixture.root, 'execution-worker'))
  let relay: Awaited<ReturnType<typeof createExecutionRelay>> | undefined
  try {
    const controller = await fixture.machine('controller')
    const { offer, factoryId } = await preparePairingController(controller)
    relay = await createExecutionRelay({ address: offer.address, port: offer.port })
    const link = relay
    await worker.start()
    await worker.request('pair', {
      details: JSON.stringify({ ...offer, port: link.port }),
      capacity: 2,
    })
    const pending = await pendingPairing(controller)
    const scope = (await controller.client.executionMachines()).repos.find(
      (r) => r.factoryId === factoryId,
    )
    if (!scope) throw new Error('No approved repo')
    const grant = await controller.client.approveExecution({ id: pending.id, scopes: [scope] })
    await worker.state('connected')

    const newTask = async () => {
      const task = await controller.client.createTask({ factory: 'PAIR', title: 'Synthetic' })
      const assignment = await controller.rpc<TaskAssignment>({
        action: 'assign-remote',
        taskId: task.id,
        machineId: grant.id,
      })
      return { id: task.id, assignment }
    }
    const issue = async (taskId: string, input: ProbeInput = {}) => {
      const operationId = `op-${randomUUID()}`
      await controller.rpc({ action: 'issue', input: { operationId, taskId, scope, input } })
      return operationId
    }
    const row = (id: string) => controller.rpc<StoredOperation | null>({ action: 'operation', id })
    const until = (id: string, state: StoredOperation['state'], timeoutMs = 45_000) =>
      waitUntil(
        async () => {
          const found = await row(id).catch(() => null)
          return found?.state === state ? found : undefined
        },
        `operation ${state}`,
        timeoutMs,
      )
    const effectLines = async () =>
      (await readFile(path.join(worker.home, 'probe', 'effects.log'), 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
    const effects = async (id: string) => (await effectLines()).filter((l) => l === id).length
    const release = (id: string) =>
      writeFile(path.join(worker.home, 'probe', `${id}.release`), '', { mode: 0o600 })
    const workerCounts = async () => (await worker.request('status')).operations
    const machine = async () =>
      (await controller.client.executionMachines()).machines.find((m) => m.id === grant.id)
    const connections = (more: number) => {
      const from = link.counts().connections
      return waitUntil(() => link.counts().connections >= from + more, 'more connections', 30_000)
    }

    const first = await newTask()
    const a = await issue(first.id, { wait: true })
    const b = await issue(first.id)
    const c = await issue(first.id)
    await until(a, 'running')
    await until(b, 'accepted')
    expect(await effects(b)).toBe(0)
    await release(a)
    for (const id of [a, b, c]) expect((await until(id, 'finished')).report?.result?.value).toBe(1)
    expect(await effectLines()).toEqual([a, b, c])
    await observe('command-order', { issued: 3, ranInOrder: true, countEach: 1 })

    link.dropResponses(true)
    const lost = await issue(first.id)
    await connections(3)
    expect((await row(lost))?.state).toBe('issued')
    expect(await effects(lost)).toBe(0)
    link.dropResponses(false)
    await until(lost, 'finished')
    expect(await effects(lost)).toBe(1)
    await observe('command-lost-request', { deliveredAfterLoss: true, count: 1 })

    const acked = await issue(first.id, { wait: true })
    await until(acked, 'running')
    link.dropResponses(true)
    await release(acked)
    const recorded = await until(acked, 'finished')
    await connections(2)
    expect((await workerCounts())?.waiting).toBe(1)
    link.dropResponses(false)
    await waitUntil(async () => (await workerCounts())?.waiting === 0, 'result confirmed', 30_000)
    expect(await effects(acked)).toBe(1)
    expect(await row(acked)).toEqual(recorded)
    await observe('command-lost-ack', { reportedAgain: true, count: 1 })
    await observe('command-duplicate-completion', { appliedOnce: true, count: 1 })

    const stopped = await issue(first.id, { wait: true })
    await until(stopped, 'running')
    link.cut()
    const offline = await worker.state('disconnected')
    expect(offline.message).toContain('1 operation running')
    expect(offline.message).toContain('Nothing new starts until this Mac reconnects')
    await controller.rpc({ action: 'stop-operation', id: stopped })
    expect((await row(stopped))?.state).toBe('running')
    const unconfirmed = await machine()
    expect(unconfirmed?.operations).toMatchObject({ stopsUnconfirmed: 1 })
    expect(unconfirmed?.operations?.text).toContain('1 stop requested, not confirmed')
    link.restore()
    await until(stopped, 'stopped')
    expect(await effects(stopped)).toBe(0)
    expect((await machine())?.operations?.stopsUnconfirmed ?? 0).toBe(0)
    await observe('command-stop-ack', {
      whileDisconnected: 'stop requested, not confirmed',
      afterAcknowledgment: 'stopped',
      count: 0,
    })

    const finishing = await issue(first.id, { wait: true })
    const queued = await issue(first.id)
    await until(finishing, 'running')
    await until(queued, 'accepted')
    link.cut()
    await worker.state('disconnected')
    await release(finishing)
    await waitUntil(async () => (await workerCounts())?.waiting === 1, 'result journaled', 30_000)
    await delay(500)
    expect(await workerCounts()).toMatchObject({ waiting: 1, queued: 1, running: 0 })
    expect(await effects(queued)).toBe(0)
    link.restore()
    await until(finishing, 'finished')
    await until(queued, 'finished')
    expect([await effects(finishing), await effects(queued)]).toEqual([1, 1])
    await observe('command-disconnected-hold', {
      runningFinishedAndJournaled: true,
      newStartWhileDisconnected: false,
    })

    const survived = await issue(first.id, { wait: true })
    await until(survived, 'running')
    await controller.kill()
    await release(survived)
    await waitUntil(async () => (await workerCounts())?.waiting === 1, 'result journaled', 30_000)
    await controller.start(60_000)
    await until(survived, 'finished')
    expect(await effects(survived)).toBe(1)
    for (const point of ['controller-after-issue', 'controller-after-report']) {
      await controller.kill()
      controller.extraEnv = { TED_EXECUTION_CRASH_AT: point }
      await controller.start(60_000)
      const operationId = `op-${randomUUID()}`
      const sent = controller
        .rpc({ action: 'issue', input: { operationId, taskId: first.id, scope, input: {} } })
        .catch(() => undefined)
      await sent
      await waitUntil(() => {
        const child = controller.child
        return !child || child.exitCode !== null || child.signalCode !== null || undefined
      }, 'controller crash')
      await controller.kill()
      controller.extraEnv = {}
      await controller.start(60_000)
      await until(operationId, 'finished')
      expect(await effects(operationId)).toBe(1)
    }
    await observe('command-controller-restart', {
      killedWhileRunning: 'result applied once after restart',
      crashAfterIntentSaved: 'sent after restart',
      crashAfterResultSaved: 'confirmed after restart',
      countEach: 1,
    })

    await worker.request('stop')
    const saved = JSON.parse(await readPrivate(worker.home, 'pairing.json')) as {
      endpoint: { address: string; port: number; controllerPin: string }
      credential: { grantId: string; certificate: string }
    }
    const key = await readPrivate(worker.home, 'worker-key.pem')
    const beat = {
      ...executionHello(),
      grantId: saved.credential.grantId,
      readiness: (await worker.request('status')).readiness,
    }
    for (let attempt = 0; attempt < 12; attempt++) {
      const dropped = new AbortController()
      await executionRequest(saved.endpoint, '/heartbeat', beat, {
        key,
        cert: saved.credential.certificate,
        signal: dropped.signal,
        onVerified: () => setTimeout(() => dropped.abort(), attempt % 6),
      }).catch(() => undefined)
    }
    await worker.request('start')
    await worker.state('connected')
    await observe('command-reconnect-after-drops', { droppedHeartbeats: 12, reconnected: true })

    const crashWorker = async (point: string, taskId: string, input: ProbeInput = {}) => {
      await worker.close()
      await worker.start({ TED_EXECUTION_CRASH_AT: point })
      await worker.state('connected')
      const id = await issue(taskId, input)
      await waitUntil(
        () =>
          worker.request('status').then(
            () => undefined,
            () => true,
          ),
        'worker crash',
        45_000,
      )
      await worker.start()
      return id
    }
    for (const point of [
      'worker-after-accept',
      'worker-after-start',
      'worker-before-effect',
      'worker-after-effect',
      'worker-after-finish',
    ]) {
      const id = await crashWorker(point, first.id)
      expect((await until(id, 'finished')).report?.result).toEqual({ ok: true, value: 1 })
      expect(await effects(id)).toBe(1)
    }
    await observe('command-worker-restart', {
      crashPoints: 5,
      countEach: 1,
    })

    const second = await newTask()
    const unsure = await crashWorker('worker-after-start', second.id, { evidence: false })
    await until(unsure, 'uncertain')
    expect(await effects(unsure)).toBe(0)
    await expect(
      controller.rpc({
        action: 'issue',
        input: { operationId: `op-${randomUUID()}`, taskId: second.id, scope, input: {} },
      }),
    ).rejects.toThrow(/unresolved/)
    expect((await worker.request('status')).message).toContain('may or may not have started')
    expect((await machine())?.operations).toMatchObject({ uncertain: 1 })
    expect((await machine())?.operations?.text).toContain('1 operation unresolved')
    await delay(500)
    expect(await effects(unsure)).toBe(0)
    await observe('command-uncertain-held', { rerun: false, newStartsForTask: 'refused' })

    const third = await newTask()
    const inject = async (changes: Partial<ExecutionCommand>, order: number) => {
      const command: ExecutionCommand = {
        operationId: executionIds.operation(`op-${randomUUID()}`),
        ref: refOf(third.assignment),
        scope,
        order,
        kind: 'probe',
        input: {},
        ...changes,
      }
      await controller.rpc({ action: 'inject', command })
      return command.operationId
    }
    const outOfScope = await inject({ scope: { ...scope, repo: 'other/unapproved' } }, 1)
    expect((await until(outOfScope, 'refused')).report?.refusal).toBe('scope')
    const otherAssignment = await inject(
      {
        ref: { ...refOf(third.assignment), assignmentId: executionIds.assignment(randomUUID()) },
      },
      2,
    )
    const newer = await inject({ ref: { ...refOf(third.assignment), generation: 2 } }, 3)
    await until(newer, 'finished')
    expect(await effects(newer)).toBe(1)
    expect((await until(otherAssignment, 'finished')).report?.result?.value).toBe(1)
    const sameGeneration = await inject(
      {
        ref: {
          ...refOf(third.assignment),
          generation: 2,
          assignmentId: executionIds.assignment(randomUUID()),
        },
      },
      4,
    )
    expect((await until(sameGeneration, 'refused')).report?.refusal).toBe('stale')
    const older = await issue(third.id)
    expect((await until(older, 'refused')).report?.refusal).toBe('stale')
    expect([
      await effects(outOfScope),
      await effects(sameGeneration),
      await effects(older),
    ]).toEqual([0, 0, 0])
    await controller.client.revokeExecution({ id: grant.id })
    await expect(
      controller.rpc({
        action: 'issue',
        input: { operationId: `op-${randomUUID()}`, taskId: first.id, scope, input: {} },
      }),
    ).rejects.toThrow(/paired/)
    await observe('command-stale-refused', {
      olderGeneration: 'refused',
      otherAssignmentSameGeneration: 'refused',
      repoOutOfScope: 'refused',
      revokedPairing: 'refused by the controller',
      sideEffects: 0,
    })
  } finally {
    await worker.close().catch(() => undefined)
    await relay?.close()
    await fixture.close()
  }
}, 600_000)

test('the controller reconciles before it sends, applies a result once and holds what it cannot place', async () => {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'ted-commands-'))
  const store = await openStore({ directory })
  try {
    const scope = { factoryId: 'factory-1', repo: 'owner/repo' }
    const grant: ExecutionGrant = {
      id: 'grant-1',
      name: 'Mac',
      publicKey: 'a'.repeat(64),
      certificateId: 'b'.repeat(64),
      scopes: [scope],
      approvedAt: new Date().toISOString(),
    }
    store.pairing.approve(grant)
    const lines: string[] = []
    const commands = createExecutionCommands({ store, pollMs: 5, log: (l) => lines.push(l) })
    const assigned = async () => {
      const task = await store.createTask({ title: 'Synthetic' })
      const assignment = createTaskExecution(store).assign({
        taskId: task.id,
        machineId: executionIds.machine(grant.id),
        assignmentId: executionIds.assignment(randomUUID()),
        reservationId: executionIds.reservation(randomUUID()),
        operationId: executionIds.operation(randomUUID()),
        expectedGeneration: 0,
      })
      return { id: task.id, ref: refOf(assignment) }
    }
    const sync = (session: string, more: Partial<ExecutionSyncRequest> = {}) =>
      commands.sync(grant, {
        ...executionHello(),
        grantId: grant.id,
        session,
        reports: [],
        accepting: true,
        ...more,
      })
    const report = (
      command: ExecutionCommand,
      state: ExecutionReport['state'],
      value?: number,
    ): ExecutionReport => ({
      operationId: command.operationId,
      ref: command.ref,
      state,
      ...(value !== undefined && { result: { ok: true, value } }),
    })

    const task = await assigned()
    const input = { operationId: 'op-1', taskId: task.id, scope, input: {} }
    const command = await commands.issue(input)
    expect(await commands.issue(input)).toEqual(command)
    await expect(commands.issue({ ...input, input: { wait: true } })).rejects.toThrow(/already/)
    await expect(
      commands.issue({ ...input, operationId: 'op-x', scope: { ...scope, repo: 'other/repo' } }),
    ).rejects.toThrow(/not approved/)

    expect(await sync('s1')).toMatchObject({ needInventory: true, reconciled: false, commands: [] })
    expect(await sync('s1', { inventory: [] })).toMatchObject({ reconciled: true, commands: [] })
    expect((await sync('s1', { accepting: 'limit' })).commands).toEqual([])
    expect((await sync('s1')).commands).toEqual([command])
    expect((await sync('s1', { reports: [report(command, 'accepted')] })).confirmed).toEqual([])
    expect((await sync('s1', { reports: [report(command, 'finished', 1)] })).confirmed).toEqual([
      'op-1',
    ])
    const saved = commands.operation('op-1')
    expect((await sync('s1', { reports: [report(command, 'finished', 1)] })).confirmed).toEqual([
      'op-1',
    ])
    expect((await sync('s1', { reports: [report(command, 'finished', 2)] })).confirmed).toEqual([
      'op-1',
    ])
    expect(commands.operation('op-1')).toEqual(saved)
    expect(lines.some((l) => l.includes('second, different outcome'))).toBe(true)
    await observe('command-duplicate-completion', { differentSecondOutcome: 'first kept' })

    const ghost = { operationId: executionIds.operation('ghost'), ref: task.ref }
    expect(await sync('s2')).toMatchObject({ needInventory: true })
    await sync('s2', { inventory: [{ ...ghost, state: 'running' }] })
    expect(commands.operation('ghost')).toMatchObject({ state: 'unknown', machineId: grant.id })
    const finishedGhost = { ...ghost, state: 'finished' as const, result: { ok: true, value: 1 } }
    expect((await sync('s2', { reports: [finishedGhost] })).confirmed).toEqual([])
    expect(commands.operation('ghost')).toMatchObject({ state: 'unknown' })
    await expect(commands.issue({ ...input, operationId: 'op-2' })).rejects.toThrow(/unresolved/)
    expect(commands.summary(grant.id, true)).toMatchObject({ unknown: 1 })
    expect(commands.summary(grant.id, true)?.text).toContain('is not in this Mac’s records')
    await observe('command-reconcile-unknown', { resultApplied: false, newStarts: 'refused' })

    const removed = await assigned()
    const gone = await commands.issue({ ...input, operationId: 'op-3', taskId: removed.id })
    expect((await sync('s2')).commands).toEqual([gone])
    await sync('s2', { reports: [report(gone, 'running')] })
    store.deleteTask(removed.id)
    expect(commands.operation('op-3')).toBeUndefined()
    expect((await sync('s2', { reports: [report(gone, 'finished', 1)] })).confirmed).toEqual([
      'op-3',
    ])
    expect(lines.filter((l) => l.includes('deleted Task'))).toHaveLength(1)
    const orphan = await sync('s3', { inventory: [{ ...report(gone, 'running') }] })
    expect(orphan.stops.map((s) => s.operationId)).toEqual(['op-3'])
    await observe('command-deleted-task', { acknowledged: true, recordedOnTask: false })

    const closed = new AbortController()
    closed.abort()
    const token = `github_pat_${'A1b2C3d4E5'.repeat(3)}`
    const leaked = {
      operationId: executionIds.operation(token),
      ref: { ...gone.ref, taskId: 'no-such-task' },
      state: 'stopped' as const,
    }
    await expect(
      commands.sync(
        grant,
        {
          ...executionHello(),
          grantId: grant.id,
          session: 's3',
          reports: [leaked],
          accepting: true,
        },
        closed.signal,
      ),
    ).rejects.toThrow(/closed/)
    expect(lines.join('\n')).not.toContain(token)
    expect((await sync('s3', { reports: [leaked] })).confirmed).toEqual([token])
    expect(lines.filter((l) => l.includes('deleted Task'))).toHaveLength(2)
    expect(lines.join('\n')).not.toContain(token)

    const halted = await assigned()
    const stopping = await commands.issue({ ...input, operationId: 'op-5', taskId: halted.id })
    await sync('s3', { reports: [report(stopping, 'running')] })
    await commands.stop('op-5')
    expect((await sync('s3')).stops.map((s) => s.operationId)).toEqual(['op-5'])
    expect((await sync('s3')).stops).toEqual([])
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect((await sync('s3')).stops.map((s) => s.operationId)).toEqual(['op-5'])
    await sync('s3', { reports: [report(stopping, 'stopped')] })
    expect((await sync('s3')).stops).toEqual([])

    const missing = await assigned()
    const lostOnWorker = await commands.issue({ ...input, operationId: 'op-4', taskId: missing.id })
    await sync('s3', { reports: [report(lostOnWorker, 'running')] })
    await sync('s4', { inventory: [] })
    expect(commands.operation('op-4')).toMatchObject({ state: 'uncertain' })
    expect(commands.summary(grant.id, false)?.text).toContain('may or may not have started')

    const capped = createExecutionCommands({ store, pollMs: 5, maxPerAnswer: 2 })
    const cappedSync = (more: Partial<ExecutionSyncRequest> = {}) =>
      capped.sync(grant, {
        ...executionHello(),
        grantId: grant.id,
        session: 'capped',
        reports: [],
        accepting: true,
        ...more,
      })
    const backlog: ExecutionCommand[] = []
    for (const n of [6, 7, 8, 9]) {
      const next = await assigned()
      backlog.push(await capped.issue({ ...input, operationId: `op-${n}`, taskId: next.id }))
    }
    await capped.stop('op-9')
    const sendable = backlog.slice(0, 3)
    const lost = (n: number) => ({
      operationId: executionIds.operation(`lost-${n}`),
      ref: { ...gone.ref, taskId: 'no-such-task' },
      state: 'running' as const,
    })
    await cappedSync()
    const firstAnswer = await cappedSync({ inventory: [lost(1), lost(2), lost(3)] })
    expect(firstAnswer.stops.map((s) => s.operationId)).toEqual(['lost-1', 'lost-2'])
    const secondAnswer = await cappedSync()
    expect(secondAnswer.stops.map((s) => s.operationId)).toEqual(['lost-3', 'op-9'])
    expect(secondAnswer.commands).toHaveLength(2)
    expect(sendable).toEqual(expect.arrayContaining(secondAnswer.commands))
    const thirdAnswer = await cappedSync({
      reports: secondAnswer.commands.map((c) => report(c, 'accepted')),
    })
    const sent = secondAnswer.commands.map((c) => c.operationId)
    expect(thirdAnswer.commands).toEqual(sendable.filter((c) => !sent.includes(c.operationId)))
  } finally {
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('the execution Mac refuses work at its limits, keeps what it stored and says why', async () => {
  const home = await mkdtemp(path.join(await realpath(tmpdir()), 'ted-operations-'))
  const scope = { factoryId: 'factory-1', repo: 'owner/repo' }
  let free = 500e9
  const open = (limits: ExecutionLimits = { ...executionLimits, unconfirmed: 2 }) =>
    createExecutionOperations({
      home,
      identity: () => ({ grantId: 'grant-1', scopes: [scope] }),
      freeBytes: async () => free,
      limits,
    })
  const command = (n: number, input: ProbeInput = { wait: true }): ExecutionCommand => ({
    operationId: executionIds.operation(`op-${n}`),
    ref: {
      taskId: `task-${n}`,
      machineId: executionIds.machine('grant-1'),
      assignmentId: executionIds.assignment(`assignment-${n}`),
      generation: 1,
      reservationId: executionIds.reservation(`reservation-${n}`),
    },
    scope,
    order: 1,
    kind: 'probe',
    input,
  })
  const answer = (commands: ExecutionCommand[]) => ({
    needInventory: false,
    reconciled: true,
    confirmed: [],
    commands,
    stops: [],
  })
  let operations = await open()
  try {
    await operations.handle(answer([command(1), command(2)]))
    expect((await operations.request(false)).accepting).toBe('limit')
    await operations.handle(answer([command(3)]))
    const refused = await operations.request(true)
    expect(refused.reports).toContainEqual({
      operationId: 'op-3',
      ref: command(3).ref,
      state: 'refused',
      refusal: 'limit',
    })
    expect(refused.inventory?.map((o) => o.operationId)).toEqual(['op-1', 'op-2'])
    expect(operations.counts()).toMatchObject({ queued: 2, refusing: 'limit', reconciling: true })
    expect(workerOperationsText('disconnected', operations.counts())).toContain(
      'Not accepting new work: stored operations are at the limit. Nothing stored is deleted.',
    )
    await operations.close()

    operations = await open({ ...executionLimits, journalBytes: executionLimits.resultBytes * 3 })
    expect((await operations.request(true)).inventory).toHaveLength(2)
    await operations.handle(answer([command(4)]))
    expect((await operations.request(false)).reports).toContainEqual(
      expect.objectContaining({ operationId: 'op-4', refusal: 'limit' }),
    )
    await operations.close()

    operations = await open(executionLimits)
    free = executionLimits.minFreeBytes - 1
    await operations.handle(answer([command(5)]))
    const low = await operations.request(false)
    expect(low.accepting).toBe('disk')
    expect(low.reports).toContainEqual(
      expect.objectContaining({ operationId: 'op-5', refusal: 'disk' }),
    )
    expect(workerOperationsText('connected', operations.counts())).toContain(
      'less than 1 GB is free on this Mac',
    )
    free = 500e9
    await operations.handle(answer([command(6, {})]))
    expect(operations.counts()).toMatchObject({ queued: 3, running: 0 })
    operations.allow(true)
    await waitUntil(() => operations.counts().waiting === 1 || undefined, 'operation finished')
    expect(workerOperationsText('connected', operations.counts())).toBe('2 operations running.')
    await observe('command-spool-limit', {
      atCountLimit: 'refused with reason',
      atJournalLimit: 'refused with reason',
      lowDisk: 'refused with reason',
      storedOperationsKept: 2,
    })

    const stop = (target: ExecutionCommand, ref: Partial<ExecutionCommand['ref']> = {}) => ({
      operationId: target.operationId,
      ref: { ...target.ref, ...ref },
      order: target.order,
    })
    const stateOf = async (n: number) =>
      (await operations.request(false)).reports.find((r) => r.operationId === `op-${n}`)?.state
    await operations.handle({
      ...answer([]),
      stops: [
        stop(command(1), { generation: 2 }),
        stop(command(1), { assignmentId: executionIds.assignment('assignment-other') }),
        stop(command(1), { reservationId: executionIds.reservation('reservation-other') }),
        stop(command(1), { machineId: executionIds.machine('grant-2') }),
        stop(command(2)),
      ],
    })
    await waitUntil(async () => (await stateOf(2)) === 'stopped', 'operation 2 stopped')
    expect(await stateOf(1)).toBe('running')

    const starting = operations.handle(answer([command(7, {})]))
    const stopping = operations.handle({ ...answer([]), stops: [stop(command(7))] })
    await Promise.all([starting, stopping])
    await waitUntil(async () => (await stateOf(7)) === 'stopped', 'operation 7 stopped')
    await operations.handle(answer([command(8, {})]))
    await waitUntil(async () => (await stateOf(8)) === 'finished', 'operation 8 finished')

    operations.allow(false)
    await operations.handle(answer([command(9, {})]))
    const stopQueued = operations.handle({ ...answer([]), stops: [stop(command(9))] })
    await new Promise((resolve) => setImmediate(resolve))
    operations.allow(true)
    await stopQueued
    await operations.handle(answer([{ ...command(10, {}), ref: command(9).ref, order: 2 }]))
    await waitUntil(async () => (await stateOf(10)) === 'finished', 'operation 10 finished')
    const effects = await readFile(path.join(home, 'probe', 'effects.log'), 'utf8')
    expect(effects.split('\n').filter(Boolean)).toEqual(['op-6', 'op-8', 'op-10'])
    expect(await stateOf(7)).toBe('stopped')
    expect(await stateOf(9)).toBe('stopped')

    const fullHome = await mkdtemp(path.join(await realpath(tmpdir()), 'ted-operations-'))
    const full = await createExecutionOperations({
      home: fullHome,
      identity: () => ({ grantId: 'grant-1', scopes: [scope] }),
      freeBytes: async () => free,
      limits: { ...executionLimits, unconfirmed: 1 },
    })
    try {
      await full.handle(answer([command(11)]))
      await full.handle({ ...answer([]), stops: [stop(command(12))] })
      const atLimit = await full.request(true)
      expect(atLimit.inventory?.map((o) => o.operationId)).toEqual(['op-11'])
      expect(atLimit.reports).toContainEqual({
        operationId: 'op-12',
        ref: command(12).ref,
        state: 'refused',
        refusal: 'limit',
      })
      await full.handle({ ...answer([]), stops: [stop(command(11))] })
      await full.handle({
        ...answer([]),
        confirmed: [executionIds.operation('op-11')],
        stops: [stop(command(12))],
      })
      expect((await full.request(true)).inventory).toEqual([
        { operationId: 'op-12', ref: command(12).ref, state: 'stopped' },
      ])
    } finally {
      await full.close()
      await rm(fullHome, { recursive: true, force: true })
    }

    expect(
      machineOperationsText(
        {
          running: 1,
          unconfirmed: 3,
          stopsUnconfirmed: 0,
          uncertain: 0,
          unknown: 0,
          reconciling: false,
        },
        false,
      ),
    ).toBe(
      '3 operations not confirmed. Their Tasks stay assigned to this Mac; nothing is started elsewhere.',
    )
    expect(
      workerOperationsText('connected', {
        running: 1,
        queued: 1,
        waiting: 1,
        uncertain: 0,
        reconciling: true,
      }),
    ).toBe('Checking 3 operations with the main Mac before starting new work.')
    await observe('command-status-text', { worker: 'composed', machine: 'composed' })
  } finally {
    await operations.close()
    await rm(home, { recursive: true, force: true })
  }
})
