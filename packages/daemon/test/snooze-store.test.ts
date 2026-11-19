import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, expectTypeOf, test } from 'vitest'
import { openStore, type TedStore } from '../src/store/index.ts'
import type { TaskTreeArea } from '../src/store/task-tree.ts'
import type { TasksArea } from '../src/store/tasks.ts'

expectTypeOf<TedStore>().toExtend<TasksArea>()
expectTypeOf<TedStore>().toExtend<TaskTreeArea>()

test('snooze replay, Activity and lifecycle commits agree', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ted-snooze-store-'))
  let store = await openStore({ directory })
  try {
    const task = await store.createTask({ title: 'Later' })
    const until = '2099-11-11T09:00:00.000Z'
    store.setStartRequested(task.id, true)
    store.setTaskSnooze(task.id, until)
    expect(store.getTask(task.id)?.startRequested).toBe(false)
    expect(store.activity().scheduledTasks).toBe(1)
    await store.close()
    store = await openStore({ directory })
    expect(store.getTask(task.id)?.snoozedUntil).toBe(until)
    store.queueTask(task.id, 'intake')
    expect(store.getTask(task.id)?.snoozedUntil).toBeUndefined()
    expect(store.activity().scheduledTasks).toBe(0)
    expect(
      store
        .taskLog(task.id)
        .slice(-2)
        .map((e) => e.name),
    ).toContain('v1.TaskQueued')
    store.moveToBacklog(task.id)
    store.setStartRequested(task.id, true)
    store.queueTask(task.id, 'intake')
    expect(store.getTask(task.id)?.startRequested).toBe(false)
    store.moveToBacklog(task.id)
    store.setTaskSnooze(task.id, until)
    store.archiveTask(task.id)
    expect(store.getTask(task.id)?.snoozedUntil).toBeUndefined()
    expect(store.taskLog(task.id).map((e) => e.name)).toContain('v1.TaskSnoozeCleared')
  } finally {
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
})
