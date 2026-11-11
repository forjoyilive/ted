import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { openStore } from '../src/store/index.ts'

test('base conflicts are kept per Task, survive a reopen and go when the Task is deleted', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ted-base-conflicts-'))
  let store = await openStore({ directory })
  try {
    const task = await store.createTask({ title: 'Conflicts' })
    const other = await store.createTask({ title: 'Other' })
    const conflict = {
      repo: 'widgets',
      base: 'main',
      tip: 'a'.repeat(40),
      fileCount: 60,
      files: ['src/a.ts', 'src/b.ts'],
    }
    const atWork = store.recordBaseConflict(task.id, { ...conflict, stage: 'work' })
    const sendBack = store.recordSendBack({
      taskId: task.id,
      from: 'review',
      to: 'work',
      findings: 'Conflicts with main.',
      counted: false,
      cause: 'base-conflict',
      conflict: { ...conflict, stage: 'review' },
    })
    store.recordBaseConflict(other.id, { ...conflict, stage: 'validate' })
    await store.persisted()
    await store.close()
    store = await openStore({ directory })

    expect(store.baseConflicts(task.id)).toEqual([
      { ...conflict, id: atWork.id, taskId: task.id, stage: 'work', at: atWork.at },
      {
        ...conflict,
        id: expect.any(String),
        taskId: task.id,
        stage: 'review',
        sendBackId: sendBack.id,
        at: sendBack.at,
      },
    ])
    expect(store.listSendBacks(task.id)).toMatchObject([{ cause: 'base-conflict' }])
    expect(store.baseConflicts()).toHaveLength(3)

    store.deleteTask(task.id)
    expect(store.baseConflicts(task.id)).toEqual([])
    expect(store.baseConflicts().map((c) => c.taskId)).toEqual([other.id])
  } finally {
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
})
