import type { CoordinatorConfirmation, CoordinatorReceipt, Task } from '@ted/protocol'
import { expect, test } from 'vitest'
import { coordinatorReceipts, interrupted } from '../src/coordinators/coordinator-receipts.ts'
import { RequestError } from '../src/errors.ts'
import type { StoredCoordinator } from '../src/store/coordinators.ts'

function harness(taskIds: string[] = []) {
  let chat: StoredCoordinator = {
    id: 'chat-1',
    factoryId: 'factory-1',
    runId: 'run-1',
    runIds: ['run-1'],
    lead: { agent: 'claude' },
    phase: 'ready',
    opening: 'Hello',
    receipts: [],
    taskIds,
  }
  const tasks = new Map<string, Task>()
  const onDisk: StoredCoordinator[] = []
  const pending: (() => void)[] = []
  let holding = false
  const receipts = coordinatorReceipts({
    chat: () => chat,
    save: (next) => {
      chat = next
    },
    persisted: () => {
      const saved = structuredClone(chat)
      if (!holding) {
        onDisk.push(saved)
        return Promise.resolve()
      }
      return new Promise<void>((resolve) => {
        pending.push(() => {
          onDisk.push(saved)
          resolve()
        })
      })
    },
    task: (id) => tasks.get(id),
    snapshot: (t) => ({ stage: t.stage, priority: t.priority, rank: t.rank, childIds: [] }),
  })
  const addTask = (id: string, stage: Task['stage'] = 'backlog') => {
    const task = { id, displayId: id.toUpperCase(), stage, priority: 'none', rank: 1 } as Task
    tasks.set(id, task)
    return task
  }
  const hold = () => {
    holding = true
  }
  return { receipts, tasks, onDisk, pending, hold, addTask, chat: () => chat }
}

test('a recorded action saves a placeholder first, then the redacted result and the Task after', async () => {
  const h = harness()
  const task = h.addTask('task-1')
  const { receipt, done } = await h.receipts.record(
    'chat-1',
    { id: 'op-1', operation: 'start', fingerprint: 'f1', task },
    async () => {
      h.tasks.set(task.id, { ...task, stage: 'clarify' })
      return `Started TASK-1 with ghp_${'a'.repeat(30)}`
    },
    (error) => `Couldn’t start TASK-1: ${error.message}`,
  )
  expect(done).toBe(true)
  expect(h.onDisk[0]?.receipts).toMatchObject([{ id: 'op-1', text: interrupted.task }])
  expect(receipt).toMatchObject({
    text: 'Started TASK-1 with [redacted]',
    taskId: 'task-1',
    before: { stage: 'backlog' },
    after: { stage: 'clarify' },
  })
  expect(h.onDisk.at(-1)?.receipts).toEqual([receipt])
  expect(h.chat().taskIds).toEqual(['task-1'])
})

test('an action starts only once its placeholder is on disk, and returns only once its result is', async () => {
  const h = harness()
  h.hold()
  const task = h.addTask('task-1')
  let started = false
  let finished = false
  const recording = h.receipts
    .record(
      'chat-1',
      { id: 'op-1', operation: 'start', fingerprint: 'f1', task },
      async () => {
        started = true
        return 'Started TASK-1'
      },
      () => 'never',
    )
    .then((result) => {
      finished = true
      return result
    })
  await expect.poll(() => h.pending.length).toBe(1)
  expect(started).toBe(false)
  h.pending.shift()?.()
  await expect.poll(() => h.pending.length).toBe(1)
  expect(started).toBe(true)
  expect(finished).toBe(false)
  h.pending.shift()?.()
  await recording
  expect(h.onDisk.map((c) => c.receipts[0]?.text)).toEqual([interrupted.task, 'Started TASK-1'])
})

test('an action that throws leaves its “Couldn’t …” receipt and returns the error', async () => {
  const h = harness()
  const task = h.addTask('task-1')
  const refusal = new RequestError(409, 'Task changed')
  const { receipt, done, error } = await h.receipts.record(
    'chat-1',
    { id: 'op-1', operation: 'move', fingerprint: 'f1', task },
    async () => {
      throw refusal
    },
    (failed) => `Couldn’t move TASK-1: ${failed.message}`,
  )
  expect(done).toBe(false)
  expect(error).toBe(refusal)
  expect(receipt.text).toBe('Couldn’t move TASK-1: Task changed')
  expect(h.chat().receipts).toEqual([receipt])
})

test('an action interrupted before its result leaves the placeholder on disk', async () => {
  const h = harness()
  let started: () => void = () => {}
  const running = new Promise<void>((resolve) => {
    started = resolve
  })
  void h.receipts.record(
    'chat-1',
    { id: 'op-1', operation: 'create', fingerprint: 'f1' },
    async () => {
      started()
      return new Promise<string>(() => {})
    },
    () => 'never',
  )
  await running
  expect(h.onDisk).toHaveLength(1)
  expect(h.onDisk[0]?.receipts).toMatchObject([
    { id: 'op-1', operation: 'create', text: interrupted.factory },
  ])
  expect(h.onDisk[0]?.receipts[0]).not.toHaveProperty('taskId')
})

test('a repeated operation returns the first receipt and a different request with its ID is refused', () => {
  const h = harness()
  const first: CoordinatorReceipt = {
    id: 'op-1',
    operation: 'tell',
    taskId: 'task-1',
    text: 'Told TASK-1’s Task Lead',
    at: '2026-01-01T00:00:00.000Z',
    fingerprint: 'f1',
  }
  const chat = { ...h.chat(), receipts: [first] }
  expect(h.receipts.replay(chat, 'op-1', 'f1')).toBe(first)
  expect(h.receipts.replay(chat, 'op-2', 'f1')).toBeUndefined()
  expect(() => h.receipts.replay(chat, 'op-1', 'f2')).toThrow(
    'operation ID already used for another action',
  )
})

test('a grouped operation replays its receipts and confirmation and refuses another request', () => {
  const h = harness()
  const receipt = (id: string): CoordinatorReceipt => ({
    id,
    operation: 'archive',
    text: 'Archived',
    at: '2026-01-01T00:00:00.000Z',
    fingerprint: 'g1',
  })
  const done = { ...h.chat(), receipts: [receipt('op-1:a'), receipt('op-1:b')] }
  expect(h.receipts.replayGroup(done, 'op-1', 'g1')).toEqual({
    receipts: [receipt('op-1:a'), receipt('op-1:b')],
  })
  expect(() => h.receipts.replayGroup(done, 'op-1', 'g2')).toThrow(
    'operation ID already used for another action',
  )
  const asked = {
    ...h.chat(),
    confirmations: [
      { id: 'card-1', operation: 'op-2', fingerprint: 'g1' } as CoordinatorConfirmation,
    ],
  }
  expect(h.receipts.replayGroup(asked, 'op-2', 'g1')).toEqual({
    receipts: [],
    confirmation: { id: 'card-1', waiting: true },
  })
  const single = { ...h.chat(), receipts: [receipt('op-3')] }
  expect(() => h.receipts.replayGroup(single, 'op-3', 'g1')).toThrow(
    'operation ID already used for another action',
  )
  expect(h.receipts.replayGroup(h.chat(), 'op-4', 'g1')).toBeUndefined()
})

test('a chat remembers only its last 100 Tasks', async () => {
  const h = harness(Array.from({ length: 100 }, (_, i) => `old-${i}`))
  const task = h.addTask('task-new')
  await h.receipts.append('chat-1', {
    id: 'op-1:task-new',
    operation: 'transfer',
    taskId: task.id,
    text: 'Asked the user to move TASK-NEW',
    at: '2026-01-01T00:00:00.000Z',
    fingerprint: 'f1',
  })
  expect(h.chat().taskIds).toHaveLength(100)
  expect(h.chat().taskIds.at(-1)).toBe('task-new')
  expect(h.chat().taskIds[0]).toBe('old-1')
})

test('actions of one Factory run one at a time', async () => {
  const h = harness()
  const order: string[] = []
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const first = h.receipts.serial('factory-1', async () => {
    await gate
    order.push('first')
  })
  const second = h.receipts.serial('factory-1', async () => {
    order.push('second')
  })
  release()
  await Promise.all([first, second])
  expect(order).toEqual(['first', 'second'])
  await h.receipts.settled('factory-1')
  expect(h.receipts.queued()).toEqual([])
})
