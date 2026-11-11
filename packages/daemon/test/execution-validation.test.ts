import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  type AssignTaskExecution,
  executionIds,
  type Task,
  type TaskAssignment,
} from '@ted/protocol'
import { expect, test } from 'vitest'
import { eventlogFile } from '../src/store/files.ts'
import { waitUntil } from './helpers.ts'
import { createExecutionFixture } from './support/execution-fixture.ts'
import { observe } from './support/execution-observations.ts'

async function assignments(directory: string) {
  const file = await eventlogFile(directory)
  if (!file) throw new Error('missing persisted event log')
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return db
      .prepare(
        "SELECT name, argsJson FROM eventlog WHERE name = 'v1.TaskExecutionAssigned' ORDER BY seqNumGlobal",
      )
      .all()
  } finally {
    db.close()
  }
}

test('row 1 ownership survives process restart and full replay with exactly one receipt', async () => {
  const fixture = await createExecutionFixture()
  try {
    const machine = await fixture.machine('controller', 'store')
    const task = await machine.rpc<Task>({ action: 'create' })
    const ready = machine.ready
    if (!ready) throw new Error('missing machine readiness')
    const input: AssignTaskExecution = {
      taskId: task.id,
      machineId: executionIds.machine(ready.machineId),
      expectedGeneration: 0,
      assignmentId: executionIds.assignment(randomUUID()),
      reservationId: executionIds.reservation(randomUUID()),
      operationId: executionIds.operation(randomUUID()),
    }
    const [first, retry] = await Promise.all([
      machine.rpc<TaskAssignment>({ action: 'assign', input }),
      machine.rpc<TaskAssignment>({ action: 'assign', input }),
    ])
    expect(retry).toEqual(first)
    const persisted = await assignments(path.join(machine.home, 'ownership-store'))
    expect(persisted).toHaveLength(1)
    await machine.kill()
    await machine.start()
    expect(machine.ready?.machineId).toBe(first.machineId)
    expect(await machine.rpc({ action: 'assign', input })).toEqual(first)
    expect(await machine.rpc({ action: 'replay' })).toMatchObject({ machineId: first.machineId })
    expect(await machine.rpc({ action: 'assign', input })).toEqual(first)
    await expect(
      machine.rpc({
        action: 'assign',
        input: { ...input, machineId: executionIds.machine('conflict') },
      }),
    ).rejects.toThrow('conflict')
    await expect(
      machine.rpc({ action: 'require', assignment: { ...first, generation: 0 } }),
    ).rejects.toThrow()
    expect(await assignments(path.join(machine.home, 'ownership-store'))).toEqual(persisted)
    const remote = await machine.rpc<Task>({ action: 'create' })
    await machine.rpc({
      action: 'assign',
      input: {
        ...input,
        taskId: remote.id,
        machineId: executionIds.machine('other-machine'),
        assignmentId: executionIds.assignment(randomUUID()),
        reservationId: executionIds.reservation(randomUUID()),
        operationId: executionIds.operation(randomUUID()),
      },
    })
    await expect(machine.rpc({ action: 'local', taskId: remote.id })).rejects.toThrow(
      'another machine',
    )
    await observe('ownership-replay', {
      machineId: first.machineId,
      receiptsBeforeAndAfterReplay: 1,
      conflictsRejected: true,
      remoteLocalStartRejected: true,
    })
  } finally {
    await fixture.close()
  }
})

test('row 1 synthetic daemon start persists assignment first and restart keeps the assignment', async () => {
  const fixture = await createExecutionFixture()
  try {
    const machine = await fixture.machine('controller')
    const factory = await machine.client.addFactory({
      repo: machine.origin,
      key: 'OWN',
    })
    const task = await machine.client.createTask({
      factory: factory.key,
      title: JSON.stringify({
        steps: [{ waitFor: path.join(machine.root, 'release-agent') }, { endTurn: true }],
      }),
    })
    await machine.client.startTask(task.id)
    await waitUntil(
      async () => (await machine.client.listTasks()).find((t) => t.id === task.id)?.leadRunId,
      'real Task Lead start',
      30_000,
    )
    const directory = path.join(machine.home, 'store')
    await waitUntil(async () => (await machine.agentStarts()) === 1, 'one actual agent start')
    const before = await assignments(directory)
    expect(before).toHaveLength(1)
    const file = await eventlogFile(directory)
    if (!file) throw new Error('missing log')
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      const events = db
        .prepare(
          "SELECT name FROM eventlog WHERE json_extract(argsJson, '$.taskId') = ? ORDER BY seqNumGlobal",
        )
        .all(task.id)
        .map((row) => row.name)
      expect(events.indexOf('v1.TaskExecutionAssigned')).toBeLessThan(
        events.indexOf('v1.TaskStarted'),
      )
    } finally {
      db.close()
    }
    await machine.rpc({ action: 'stop' })
    await machine.kill()
    await machine.start()
    expect((await machine.client.listTasks()).find((t) => t.id === task.id)?.stage).toBe('intake')
    expect(await assignments(directory)).toEqual(before)
    expect(await machine.agentStarts()).toBe(1)
    await observe('ownership-start', {
      assignmentBeforeTaskStarted: true,
      assignments: 1,
      retainedAfterRestart: true,
    })
  } finally {
    await fixture.close()
  }
}, 60_000)
