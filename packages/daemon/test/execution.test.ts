import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { executionHandle, executionIds, type Factory, type Task } from '@ted/protocol'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { eventlogFile } from '../src/store/files.ts'
import { openStore, type TedStore } from '../src/store/index.ts'
import { createTaskExecution } from '../src/tasks/execution.ts'
import { api, killRunHosts, makeOriginRepo, stubClaudePath, waitUntil } from './helpers.ts'

let dir: string
let store: TedStore

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ted-local-execution-'))
  store = await openStore({ directory: dir })
})

afterEach(async () => {
  await store.close()
  await rm(dir, { recursive: true, force: true })
})

test('local execution persists ownership before returning, and concurrent retries reuse it', async () => {
  const task = await store.createTask({ title: 'Local start' })
  const execution = createTaskExecution(store)
  const [first, second] = await Promise.all([execution.local(task.id), execution.local(task.id)])
  expect(first).toEqual(second)
  expect(first.machineId).toBe(store.execution.localMachineId)
  const file = await eventlogFile(dir)
  if (!file) throw new Error('missing event log')
  const log = new DatabaseSync(file, { readOnly: true })
  try {
    const rows = log
      .prepare("SELECT argsJson FROM eventlog WHERE name = 'v1.TaskExecutionAssigned'")
      .all()
    expect(rows.map((row) => JSON.parse(String(row.argsJson)))).toEqual([first])
  } finally {
    log.close()
  }
})

test('a failed persistence barrier never grants permission to start', async () => {
  const task = await store.createTask({ title: 'Disk failure' })
  const execution = createTaskExecution({
    execution: store.execution,
    persisted: async () => {
      throw new Error('event log unavailable')
    },
  })
  await expect(execution.local(task.id)).rejects.toThrow('event log unavailable')
})

test('a Task assigned to another machine cannot start locally', async () => {
  const task = await store.createTask({ title: 'Remote ownership' })
  const execution = createTaskExecution(store)
  const saved = execution.assign({
    taskId: task.id,
    machineId: executionIds.machine('trusted-mac'),
    assignmentId: executionIds.assignment(randomUUID()),
    operationId: executionIds.operation(randomUUID()),
    reservationId: executionIds.reservation(randomUUID()),
    expectedGeneration: 0,
  })
  await expect(execution.local(task.id)).rejects.toThrow('another machine')
  expect(execution.require(saved)).toEqual(saved)
})

test('execution handles are structured references and reject path-shaped IDs', async () => {
  const task = await store.createTask({ title: 'Handle' })
  const saved = await createTaskExecution(store).local(task.id)
  const handle = executionHandle({ ...saved, id: executionIds.handle(randomUUID()) })
  expect(handle).toEqual({
    taskId: saved.taskId,
    machineId: saved.machineId,
    assignmentId: saved.assignmentId,
    generation: saved.generation,
    reservationId: saved.reservationId,
    id: handle.id,
  })
  for (const id of ['/remote/worktree', '../file', 'file:///tmp', 'C:\\work', '', 'x\n']) {
    expect(() => executionIds.handle(id)).toThrow('invalid execution handle ID')
  }
  expect(() => executionHandle({ ...handle, generation: 0 })).toThrow()
})

test('a normal daemon Task saves local ownership before starting and keeps it on restart', async () => {
  const home = path.join(dir, 'daemon')
  const origin = await makeOriginRepo(path.join(dir, 'source'))
  let daemon: RunningDaemon | undefined
  const start = async () => {
    daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
    return api(daemon.port, { appKey: daemon.appToken })
  }
  try {
    const client = await start()
    const factory = await client.call('POST', '/dev/factories', { repo: origin, key: 'NB' })
    expect(factory.status).toBe(201)
    const added = factory.body as Factory
    const response = await client.call('POST', '/tasks', {
      factory: added.key,
      title: 'Local ownership {"steps":[{"endTurn":true}]}',
    })
    expect(response.status).toBe(201)
    const task = response.body as Task
    expect((await client.call('POST', `/tasks/${task.id}/start`)).status).toBe(200)
    await waitUntil(async () => {
      const tasks = await client.call('GET', '/tasks')
      return (tasks.body as Task[]).find((t) => t.id === task.id)?.leadRunId
    }, 'the local Task Lead')
    const file = await eventlogFile(path.join(home, 'store'))
    if (!file) throw new Error('missing daemon event log')
    const assigned = () => {
      const log = new DatabaseSync(file, { readOnly: true })
      try {
        return log
          .prepare(
            "SELECT name, argsJson FROM eventlog WHERE json_extract(argsJson, '$.taskId') = ? ORDER BY seqNumGlobal",
          )
          .all(task.id)
      } finally {
        log.close()
      }
    }
    const before = assigned()
    const ownership = before.filter((row) => row.name === 'v1.TaskExecutionAssigned')
    expect(ownership).toHaveLength(1)
    expect(before.findIndex((row) => row.name === 'v1.TaskExecutionAssigned')).toBeLessThan(
      before.findIndex((row) => row.name === 'v1.TaskStarted'),
    )
    await daemon?.stop()
    daemon = undefined
    const restarted = await start()
    const tasks = await restarted.call('GET', '/tasks')
    expect(tasks.status).toBe(200)
    expect((tasks.body as Task[]).find((t) => t.id === task.id)?.stage).toBe('intake')
    expect(assigned().filter((row) => row.name === 'v1.TaskExecutionAssigned')).toEqual(ownership)
  } finally {
    await daemon?.stop()
    await killRunHosts(home)
  }
})
