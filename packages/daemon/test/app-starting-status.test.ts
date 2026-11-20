import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { TaskStatus } from '@ted/protocol'
import { expect, test } from 'vitest'
import { openStore } from '../src/store/index.ts'

test('a starting App shows on the Task until it is no longer starting', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ted-app-starting-'))
  const store = await openStore({ directory })
  try {
    const task = await store.createTask({ title: 'Phone app' })
    const pushed: (TaskStatus | undefined)[] = []
    store.subscribe((event) => {
      if (event.type === 'task-updated' && event.task.id === task.id) pushed.push(event.task.status)
    })
    store.noteAppStarting(task.id, 'Ted iPhone')
    expect(store.getTask(task.id)?.status).toEqual({ kind: 'working', app: 'Ted iPhone' })
    expect(store.getTask(task.id)?.activity).toBe('Starting Ted iPhone')
    expect(store.getTask(task.id)?.statuses).toContain('working')
    store.noteAppStarting(task.id, 'Ted iPhone')
    store.noteAppStarting(task.id, undefined)
    expect(store.getTask(task.id)?.status).toBeUndefined()
    expect(pushed).toEqual([{ kind: 'working', app: 'Ted iPhone' }, undefined])
    store.noteAppStarting('no-such-task', 'Web')
  } finally {
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
})
