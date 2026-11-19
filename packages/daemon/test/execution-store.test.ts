import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { type AssignTaskExecution, executionIds } from '@ted/protocol'
import { afterEach, beforeEach, expect, expectTypeOf, test } from 'vitest'
import { eventlogFile } from '../src/store/files.ts'
import { openStore, type TedStore } from '../src/store/index.ts'
import type { MachineArea } from '../src/store/machine.ts'

expectTypeOf<TedStore>().toExtend<MachineArea>()

let dir: string
let store: TedStore

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ted-execution-'))
  store = await openStore({ directory: dir })
})

afterEach(async () => {
  await store.close()
  await rm(dir, { recursive: true, force: true })
})

function assignment(taskId: string): AssignTaskExecution {
  return {
    taskId,
    machineId: store.execution.localMachineId,
    assignmentId: executionIds.assignment(randomUUID()),
    reservationId: executionIds.reservation(randomUUID()),
    operationId: executionIds.operation(randomUUID()),
    expectedGeneration: 0,
  }
}

async function clearState() {
  for (const name of await readdir(path.join(dir, 'ted'))) {
    if (name.startsWith('state')) await rm(path.join(dir, 'ted', name), { force: true })
  }
}

test('old v1/v2 Task events replay as local without editing their history', async () => {
  const old = await store.createTask({ title: 'v1 Task' })
  const newer = await store.createTask({ title: 'v2 Task' })
  await store.persisted()
  await store.close()
  const file = await eventlogFile(dir)
  if (!file) throw new Error('missing event log')
  const log = new DatabaseSync(file)
  let history: unknown[]
  try {
    log
      .prepare(
        "UPDATE eventlog SET name = 'v1.MachineSettingsChanged', argsJson = ? WHERE name = 'v1.LocalMachineIdentified'",
      )
      .run(JSON.stringify({ changes: '{}', at: old.createdAt }))
    log
      .prepare(
        "UPDATE eventlog SET name = 'v1.TaskCreated', argsJson = ? WHERE name = 'v2.TaskCreated' AND json_extract(argsJson, '$.id') = ?",
      )
      .run(
        JSON.stringify({
          id: old.id,
          factoryId: old.factoryId,
          number: old.number,
          title: old.title,
          createdAt: old.createdAt,
        }),
        old.id,
      )
    history = log
      .prepare(
        "SELECT name, argsJson FROM eventlog WHERE name IN ('v1.TaskCreated', 'v2.TaskCreated') ORDER BY seqNumGlobal",
      )
      .all()
  } finally {
    log.close()
  }
  await clearState()
  store = await openStore({ directory: dir })
  for (const task of [old, newer]) {
    expect(store.getTask(task.id)?.title).toBe(task.title)
    expect(store.execution.ownership(task.id)).toEqual({
      machineId: store.execution.localMachineId,
      generation: 0,
    })
  }
  const machine = store.execution.localMachineId
  await store.close()
  await clearState()
  store = await openStore({ directory: dir })
  expect(store.execution.localMachineId).toBe(machine)
  const read = new DatabaseSync(file, { readOnly: true })
  try {
    expect(
      read
        .prepare(
          "SELECT name, argsJson FROM eventlog WHERE name IN ('v1.TaskCreated', 'v2.TaskCreated') ORDER BY seqNumGlobal",
        )
        .all(),
    ).toEqual(history)
  } finally {
    read.close()
  }
})

test('unassigned Tasks resolve locally without manufacturing an assignment', async () => {
  const task = await store.createTask({ title: 'Existing local Task' })
  expect(store.execution.ownership(task.id)).toEqual({
    machineId: store.execution.localMachineId,
    generation: 0,
  })
  expect(store.execution.assignment(task.id)).toBeUndefined()
})

test('identity and assignment receipts survive reopen and full event replay', async () => {
  const task = await store.createTask({ title: 'Persist ownership' })
  const input = assignment(task.id)
  const saved = store.execution.assign(input)
  const machineId = store.execution.localMachineId
  expect(saved.generation).toBe(1)
  await store.persisted()
  await store.close()
  await clearState()
  store = await openStore({ directory: dir })
  expect(store.execution.localMachineId).toBe(machineId)
  expect(store.execution.assignment(task.id)).toEqual(saved)
  expect(store.execution.assign(input)).toEqual(saved)
  expect(store.execution.require(saved)).toEqual(saved)
})

test('conflicting attempts and reused identifiers cannot replace ownership', async () => {
  const a = await store.createTask({ title: 'A' })
  const b = await store.createTask({ title: 'B' })
  const input = assignment(a.id)
  const saved = store.execution.assign(input)
  for (const changed of [
    { ...assignment(a.id) },
    { ...input, expectedGeneration: 1 },
    { ...input, machineId: executionIds.machine('another-machine') },
    { ...input, taskId: b.id },
    { ...assignment(b.id), assignmentId: input.assignmentId },
    { ...assignment(b.id), reservationId: input.reservationId },
    { ...assignment(b.id), operationId: input.operationId },
  ]) {
    expect(() => store.execution.assign(changed)).toThrow()
    expect(store.execution.assignment(a.id)).toEqual(saved)
    expect(store.execution.assignment(b.id)).toBeUndefined()
  }
})

test('operations match all ownership fields and reject stale or invalid generations', async () => {
  const task = await store.createTask({ title: 'Validate reference' })
  const saved = store.execution.assign(assignment(task.id))
  for (const generation of [-1, 0, 2, 1.5, NaN, Infinity]) {
    expect(() => store.execution.require({ ...saved, generation })).toThrow()
  }
  for (const ref of [
    { ...saved, taskId: randomUUID() },
    { ...saved, machineId: executionIds.machine(randomUUID()) },
    { ...saved, assignmentId: executionIds.assignment(randomUUID()) },
    { ...saved, reservationId: executionIds.reservation(randomUUID()) },
  ])
    expect(() => store.execution.require(ref)).toThrow()
  expect(store.execution.require(saved)).toEqual(saved)
})

test('invalid initial generations and unknown Tasks have no side effects', async () => {
  const task = await store.createTask({ title: 'Generation check' })
  for (const expectedGeneration of [-1, 1, 0.5, NaN, Infinity]) {
    expect(() => store.execution.assign({ ...assignment(task.id), expectedGeneration })).toThrow()
  }
  expect(() => store.execution.assign(assignment('missing'))).toThrow()
  expect(store.execution.assignment(task.id)).toBeUndefined()
})

test('an already-started legacy Task can only acquire a local assignment', async () => {
  const task = await store.createTask({ title: 'Already working' })
  store.startTask({
    taskId: task.id,
    stage: 'intake',
    branch: 'legacy',
    worktree: '/legacy/worktree',
    entry: { layers: [], order: [{ stage: 'intake', enabled: true }] },
    repo: { name: 'widgets', repo: 'acme/widgets', copied: [], skipped: [] },
  })
  expect(() =>
    store.execution.assign({
      ...assignment(task.id),
      machineId: executionIds.machine('other-mac'),
    }),
  ).toThrow('conflicts')
  expect(store.execution.assign(assignment(task.id)).machineId).toBe(store.execution.localMachineId)
})

test('two concurrent assignment attempts produce exactly one owner', async () => {
  const task = await store.createTask({ title: 'Concurrent attempts' })
  const results = await Promise.allSettled([
    Promise.resolve().then(() => store.execution.assign(assignment(task.id))),
    Promise.resolve().then(() => store.execution.assign(assignment(task.id))),
  ])
  expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
  const winner = results[0]
  if (winner?.status !== 'fulfilled') throw new Error('missing assignment')
  expect(store.execution.assignment(task.id)).toEqual(winner.value)
})

test('deleting a Task removes its assignment and refuses late traffic', async () => {
  const task = await store.createTask({ title: 'Delete' })
  const saved = store.execution.assign(assignment(task.id))
  store.deleteTask(task.id)
  expect(() => store.execution.ownership(task.id)).toThrow()
  expect(() => store.execution.require(saved)).toThrow()
})
