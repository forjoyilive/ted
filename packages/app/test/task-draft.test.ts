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
    first.update({ description: 'First line\nLast keystroke', start: false, startChosen: true })
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

  test('does not recover an earlier consumed revision over a later draft', async () => {
    const setup = options()
    const submitted = { ...emptyTaskDraft(), description: 'Already submitted' }
    const current = { ...emptyTaskDraft(), description: 'Keep this newer draft' }
    setup.storage.setItem('ted.newTaskDraft.v1.one', JSON.stringify(submitted))
    const save = vi.fn(setup.save)
    const session = taskDraftSession('one', {
      ...setup,
      save,
      read: async () => ({
        draft: current,
        clearedRevision: 'later-submission',
        clearedRevisions: [submitted.revision, 'later-submission'],
      }),
    })
    expect(await session.load()).toEqual(current)
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

  test('a new draft starts with the Start now choice of the last Task created', async () => {
    let remembered = false
    let saving: Promise<void> = Promise.reject(new Error('daemon away'))
    void saving.catch(() => {})
    const rememberStart = vi.fn((start: boolean) => {
      const attempt = saving.then(() => {
        remembered = start
      })
      saving = Promise.resolve()
      return attempt
    })
    const setup = { ...options(), startDefault: async () => remembered, rememberStart }
    const session = taskDraftSession('one', setup)
    expect(await session.load()).toMatchObject({ start: false })
    session.update({ description: 'Closed without creating', start: true, startChosen: true })
    const reopened = taskDraftSession('one', { ...setup, storage: memoryStorage() })
    expect(await reopened.load()).toMatchObject({ start: false })

    session.consumed(session.get().revision)
    expect(rememberStart).toHaveBeenCalledWith(true)
    expect(session.get()).toMatchObject({ description: '', start: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(remembered).toBe(false)
    session.update({ description: 'Created after the failed save' })
    session.consumed(session.get().revision)
    expect(rememberStart).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => expect(remembered).toBe(true))
    session.update({ description: 'Created once the save went through' })
    session.consumed(session.get().revision)
    await Promise.resolve()
    expect(rememberStart).toHaveBeenCalledTimes(2)
    await session.flush()

    const failing = taskDraftSession('two', {
      ...options(),
      startDefault: () => Promise.reject(new Error('daemon away')),
    })
    expect(await failing.load()).toMatchObject({ start: true })
  })

  test('a saved draft keeps Start now only when the user chose it', async () => {
    const saved = (startChosen?: boolean): NewTaskDraft => ({
      ...emptyTaskDraft(true),
      description: 'Half written',
      ...(startChosen !== undefined && { startChosen }),
    })
    const load = (draft: NewTaskDraft) =>
      taskDraftSession('one', {
        ...options(),
        read: async () => ({ draft }),
        startDefault: async () => false,
      }).load()
    expect(await load(saved())).toMatchObject({ description: 'Half written', start: false })
    expect(await load(saved(true))).toMatchObject({ description: 'Half written', start: true })
  })

  test('a Start now save still running doesn’t overwrite a newer choice', async () => {
    let remembered = true
    const held: Array<() => void> = []
    const rememberStart = vi.fn(
      (start: boolean) =>
        new Promise<void>((done) => {
          held.push(() => {
            remembered = start
            done()
          })
        }),
    )
    const session = taskDraftSession('one', {
      ...options(),
      startDefault: async () => remembered,
      rememberStart,
    })
    await session.load()
    session.update({ description: 'Unticked', start: false, startChosen: true })
    session.consumed(session.get().revision)
    session.update({ description: 'Ticked again', start: true, startChosen: true })
    session.consumed(session.get().revision)
    expect(rememberStart).toHaveBeenCalledTimes(1)
    held.shift()?.()
    await vi.waitFor(() => expect(rememberStart).toHaveBeenCalledTimes(2))
    held.shift()?.()
    await vi.waitFor(() => expect(remembered).toBe(true))
    expect(rememberStart.mock.calls).toEqual([[false], [true]])
    await session.flush()
  })

  test('a Create during a failing Start now save is saved after the failure', async () => {
    let remembered = true
    const held: Array<(ok: boolean) => void> = []
    const rememberStart = vi.fn(
      (start: boolean) =>
        new Promise<void>((done, fail) => {
          held.push((ok) => {
            if (!ok) return fail(new Error('daemon away'))
            remembered = start
            done()
          })
        }),
    )
    const session = taskDraftSession('one', {
      ...options(),
      startDefault: async () => remembered,
      rememberStart,
    })
    await session.load()
    session.update({ description: 'First', start: false, startChosen: true })
    session.consumed(session.get().revision)
    session.update({ description: 'Second' })
    session.consumed(session.get().revision)
    expect(rememberStart).toHaveBeenCalledTimes(1)
    held.shift()?.(false)
    await vi.waitFor(() => expect(rememberStart).toHaveBeenCalledTimes(2))
    held.shift()?.(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(rememberStart).toHaveBeenCalledTimes(2)
    session.update({ description: 'Third' })
    session.consumed(session.get().revision)
    held.shift()?.(true)
    await vi.waitFor(() => expect(remembered).toBe(false))
    expect(rememberStart.mock.calls).toEqual([[false], [false], [false]])
    await session.flush()
  })
})
