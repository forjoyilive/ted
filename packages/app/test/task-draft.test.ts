import type { NewTaskDraft, TaskDraftState } from '@ted/protocol'
import { describe, expect, test, vi } from 'vitest'
import { emptyTaskDraft, taskDraftSession } from '../src/renderer/task-draft.ts'

function memoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const options = () => ({
  storage: memoryStorage(),
  read: async (): Promise<TaskDraftState> => ({ draft: null }),
  save: async (draft: NewTaskDraft): Promise<TaskDraftState> => ({ draft }),
  changed: vi.fn(),
  failed: vi.fn(),
})

describe('New Task recovery and ordered saves', () => {
  test('recovers the last edit after a restart even when the last save is still in flight', async () => {
    const setup = options()
    const delayed = deferred<TaskDraftState>()
    const first = taskDraftSession('one', { ...setup, save: () => delayed.promise })
    await first.load()
    first.update({ description: 'First line' })
    first.update({ description: 'First line\nLast keystroke', start: false })
    const reopened = taskDraftSession('one', setup)
    expect(await reopened.load()).toMatchObject({
      description: 'First line\nLast keystroke',
      start: false,
    })
    await reopened.flush()
    delayed.resolve({ draft: null })
    await first.flush()
  })

  test('serializes saves and coalesces edits without an older response erasing the recovery copy', async () => {
    const setup = options()
    const delayed = deferred<TaskDraftState>()
    const save = vi.fn(setup.save).mockImplementationOnce(() => delayed.promise)
    const session = taskDraftSession('one', { ...setup, save })
    await session.load()
    session.update({ description: 'A' })
    session.update({ description: 'AB' })
    session.update({ description: 'ABC' })
    expect(save).toHaveBeenCalledTimes(1)
    delayed.resolve({ draft: null })
    await session.flush()
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[1]?.[0].description).toBe('ABC')
    expect(setup.storage.getItem('ted.newTaskDraft.v1.one')).toBeNull()
  })

  test('retains a failed save for retry and keeps Factories separate', async () => {
    const setup = options()
    const save = vi.fn(setup.save).mockRejectedValueOnce(new Error('offline'))
    const session = taskDraftSession('one', { ...setup, save })
    await session.load()
    session.update({ description: 'Keep me' })
    await expect(session.flush()).rejects.toThrow('offline')
    expect(setup.storage.getItem('ted.newTaskDraft.v1.one')).toContain('Keep me')
    const other = taskDraftSession('two', setup)
    expect((await other.load()).description).toBe('')
    await session.flush()
    expect(save.mock.calls.at(-1)?.[0].description).toBe('Keep me')
  })

  test('a server consumption marker prevents recovery after creation succeeded but the app quit before clearing its cache', async () => {
    const setup = options()
    const draft = { ...emptyTaskDraft(), description: 'Already created' }
    setup.storage.setItem('ted.newTaskDraft.v1.one', JSON.stringify(draft))
    const save = vi.fn(setup.save)
    const session = taskDraftSession('one', {
      ...setup,
      save,
      read: async () => ({ draft: null, clearedRevision: draft.revision }),
    })
    expect((await session.load()).description).toBe('')
    expect(save).not.toHaveBeenCalled()
    expect(setup.storage.getItem('ted.newTaskDraft.v1.one')).toBeNull()
  })

  test('ignores malformed recovery data instead of rendering invalid form fields', async () => {
    const setup = options()
    setup.storage.setItem(
      'ted.newTaskDraft.v1.one',
      JSON.stringify({ ...emptyTaskDraft(), lead: { agent: 'unknown' } }),
    )
    const session = taskDraftSession('one', setup)
    expect((await session.load()).lead).toBeUndefined()
  })

  test('storage failures do not prevent a durable save or clearing a successfully created draft', async () => {
    const setup = options()
    const storage = {
      getItem: () => {
        throw new Error('unavailable')
      },
      setItem: () => {
        throw new Error('unavailable')
      },
      removeItem: () => {
        throw new Error('unavailable')
      },
    }
    const save = vi.fn(setup.save)
    const session = taskDraftSession('one', { ...setup, storage, save })
    await session.load()
    session.update({ description: 'Saved in the daemon' })
    await session.flush()
    expect(save).toHaveBeenCalled()
    session.consumed(session.get().revision)
    expect(session.get().description).toBe('')
  })

  test('consuming the submitted revision leaves newer edits intact', async () => {
    const session = taskDraftSession('one', options())
    await session.load()
    session.update({ description: 'Submitted' })
    await session.flush()
    const submitted = session.get().revision
    session.update({ description: 'Newer' })
    session.consumed(submitted)
    expect(session.get().description).toBe('Newer')
    await session.flush()
    session.consumed(session.get().revision)
    expect(session.get()).toMatchObject({ description: '', attachments: [], start: true })
  })
})
