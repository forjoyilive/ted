import type { MessageBox, MessageDraft, MessageDraftState } from '@ted/protocol'
import { describe, expect, test, vi } from 'vitest'
import { messageDraftSession, messageDraftSessions } from '../src/renderer/message-draft-session.ts'

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
    get length() {
      return values.size
    },
    key: (index: number) => [...values.keys()][index] ?? null,
  }
}

const options = () => ({
  storage: memoryStorage(),
  read: async (): Promise<MessageDraftState> => ({ draft: null }),
  save: async (draft: MessageDraft): Promise<MessageDraftState> => ({ draft }),
  changed: vi.fn(),
  failed: vi.fn(),
  delayMs: 60_000,
})

const box = { kind: 'comment', id: 'task-1' } as const
const key = 'ted.messageDraft.v1.comment.task-1'
const file = { hash: 'a'.repeat(64), name: 'shot.png', mediaType: 'image/png', size: 3 }

describe('unsent message text', () => {
  test('opens with what the daemon kept and saves a change with its files and fields', async () => {
    const setup = options()
    const save = vi.fn(setup.save)
    const session = messageDraftSession(box, {
      ...setup,
      save,
      read: async () => ({ draft: { text: 'Kept', attachments: [file], fields: '{"skip":[2]}' } }),
    })
    expect(await session.load()).toEqual({
      text: 'Kept',
      attachments: [file],
      fields: { skip: [2] },
    })
    expect(save).not.toHaveBeenCalled()
    session.update((c) => ({ ...c, text: 'Kept and more', fields: { ...c.fields, start: true } }))
    expect(setup.changed).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: 'Kept and more' }),
    )
    expect(save).not.toHaveBeenCalled()
    expect(setup.storage.getItem(key)).toContain('Kept and more')
    await session.flush()
    expect(save).toHaveBeenCalledExactlyOnceWith({
      text: 'Kept and more',
      attachments: [file],
      fields: '{"skip":[2],"start":true}',
    })
    expect(setup.storage.getItem(key)).toBeNull()
  })

  test('saves after the delay without a flush', async () => {
    vi.useFakeTimers()
    try {
      const setup = options()
      const save = vi.fn(setup.save)
      const session = messageDraftSession(box, { ...setup, save, delayMs: 500 })
      await session.load()
      session.update((c) => ({ ...c, text: 'A' }))
      await vi.advanceTimersByTimeAsync(400)
      session.update((c) => ({ ...c, text: 'AB' }))
      await vi.advanceTimersByTimeAsync(400)
      expect(save).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(100)
      expect(save).toHaveBeenCalledExactlyOnceWith({ text: 'AB', attachments: [] })
    } finally {
      vi.useRealTimers()
    }
  })

  test('recovers the last keystrokes after a quit and sends them', async () => {
    const setup = options()
    const never = new Promise<MessageDraftState>(() => {})
    const first = messageDraftSession(box, { ...setup, save: () => never })
    await first.load()
    first.update((c) => ({ ...c, text: 'Typed before the quit' }))
    void first.flush()
    const save = vi.fn(setup.save)
    const reopened = messageDraftSession(box, {
      ...setup,
      save,
      read: async () => ({ draft: { text: 'Older', attachments: [] } }),
    })
    expect(await reopened.load()).toMatchObject({ text: 'Typed before the quit' })
    await reopened.flush()
    expect(save).toHaveBeenCalledExactlyOnceWith({ text: 'Typed before the quit', attachments: [] })
    expect(setup.storage.getItem(key)).toBeNull()
  })

  test('a clear after sending follows a save still in flight', async () => {
    const setup = options()
    const delayed = Promise.withResolvers<MessageDraftState>()
    const save = vi.fn(setup.save).mockImplementationOnce(() => delayed.promise)
    const session = messageDraftSession(box, { ...setup, save })
    await session.load()
    session.update((c) => ({ ...c, text: 'Sent now' }))
    void session.flush()
    const cleared = session.clear()
    expect(session.get()).toEqual({ text: '', attachments: [], fields: {} })
    expect(save).toHaveBeenCalledTimes(1)
    delayed.resolve({ draft: null })
    await cleared
    expect(save.mock.calls.map(([draft]) => draft.text)).toEqual(['Sent now', ''])
    expect(setup.storage.getItem(key)).toBeNull()
  })

  test('a failed save keeps the local copy for the next try, and boxes stay separate', async () => {
    const setup = options()
    const save = vi.fn(setup.save).mockRejectedValueOnce(new Error('offline'))
    const session = messageDraftSession(box, { ...setup, save })
    await session.load()
    session.update((c) => ({ ...c, text: 'Keep me' }))
    await session.flush()
    expect(setup.failed).toHaveBeenCalledOnce()
    expect(setup.storage.getItem(key)).toContain('Keep me')
    const other = messageDraftSession({ kind: 'comment', id: 'task-2' }, setup)
    expect((await other.load()).text).toBe('')
    await session.flush()
    expect(save.mock.calls.at(-1)?.[0].text).toBe('Keep me')
    expect(setup.storage.getItem(key)).toBeNull()
  })

  test('a refused save drops the local copy, so the text does not come back', async () => {
    const setup = options()
    const session = messageDraftSession(box, {
      ...setup,
      save: async () => ({ draft: null, refused: 'an archived Task keeps no unsent text' }),
    })
    await session.load()
    session.update((c) => ({ ...c, text: 'Typed as the Task was archived' }))
    await session.flush()
    expect(setup.storage.getItem(key)).toBeNull()
    expect((await messageDraftSession(box, setup).load()).text).toBe('')
  })

  test('typing before the daemon answers is not replaced, and bad local data is ignored', async () => {
    const setup = options()
    const reading = Promise.withResolvers<MessageDraftState>()
    const session = messageDraftSession(box, { ...setup, read: () => reading.promise })
    const loading = session.load()
    session.update((c) => ({ ...c, text: 'Fast typing' }))
    reading.resolve({ draft: { text: 'Kept', attachments: [] } })
    expect((await loading).text).toBe('Fast typing')
    await session.flush()

    const broken = options()
    broken.storage.setItem(key, '{"text":4}')
    expect(await messageDraftSession(box, broken).load()).toEqual({
      text: '',
      attachments: [],
      fields: {},
    })
    broken.storage.setItem(key, 'not json')
    const session2 = messageDraftSession(box, broken)
    expect((await session2.load()).text).toBe('')
    expect(broken.failed).toHaveBeenCalledOnce()
  })

  test('a box reopened while a save is in flight keeps one queue, so sent text is not saved again', async () => {
    const setup = options()
    const first = Promise.withResolvers<MessageDraftState>()
    const save = vi
      .fn(async (_box: MessageBox, draft: MessageDraft): Promise<MessageDraftState> => ({ draft }))
      .mockImplementationOnce(() => first.promise)
    const sessions = messageDraftSessions({
      storage: setup.storage,
      read: setup.read,
      save,
      failed: setup.failed,
      delayMs: 60_000,
    })
    const seen = vi.fn()
    const leave = sessions.join(box, seen)
    await vi.waitFor(() => expect(seen).toHaveBeenCalled())
    const session = sessions.find(box)
    session?.update((c) => ({ ...c, text: 'A' }))
    void session?.flush()
    session?.update((c) => ({ ...c, text: 'AB' }))
    leave()

    const again = vi.fn()
    const leaveAgain = sessions.join(box, again)
    expect(sessions.find(box)).toBe(session)
    expect(again).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'AB' }))
    const cleared = sessions.find(box)?.clear()
    first.resolve({ draft: null })
    await cleared
    expect(save.mock.calls.map(([, draft]) => draft.text)).toEqual(['A', ''])
    expect(setup.storage.getItem(key)).toBeNull()
    leaveAgain()
    await vi.waitFor(() => expect(sessions.find(box)).toBeUndefined())
  })

  test('at start, leftover local copies go to the daemon and are removed, also when refused', async () => {
    const setup = options()
    const answer = 'ted.messageDraft.v1.request.c.1'
    const chat = 'ted.messageDraft.v1.run.r1'
    const offline = 'ted.messageDraft.v1.coordinator.f1'
    setup.storage.setItem(key, JSON.stringify({ text: 'Left by a quit', attachments: [] }))
    setup.storage.setItem(
      answer,
      JSON.stringify({ text: 'Answer', attachments: [], fields: '{"a":1}' }),
    )
    setup.storage.setItem(chat, 'not json')
    setup.storage.setItem(offline, JSON.stringify({ text: 'Later', attachments: [] }))
    setup.storage.setItem('ted.other', 'keep')
    let online = false
    const save = vi.fn(
      async (asked: MessageBox, draft: MessageDraft): Promise<MessageDraftState> => {
        if (asked.kind === 'coordinator' && !online) throw new Error('offline')
        return asked.kind === 'request'
          ? { draft: null, refused: 'this request is already answered' }
          : { draft }
      },
    )
    const sessions = messageDraftSessions({
      storage: setup.storage,
      read: setup.read,
      save,
      failed: setup.failed,
    })
    await sessions.recover()
    expect(save.mock.calls).toHaveLength(3)
    expect(save.mock.calls).toEqual(
      expect.arrayContaining([
        [box, { text: 'Left by a quit', attachments: [] }],
        [
          { kind: 'request', id: 'c.1' },
          { text: 'Answer', attachments: [], fields: '{"a":1}' },
        ],
        [
          { kind: 'coordinator', id: 'f1' },
          { text: 'Later', attachments: [] },
        ],
      ]),
    )
    expect(setup.storage.getItem(key)).toBeNull()
    expect(setup.storage.getItem(answer)).toBeNull()
    expect(setup.storage.getItem(chat)).toBeNull()
    expect(setup.storage.getItem(offline)).toContain('Later')
    expect(setup.failed).toHaveBeenCalledTimes(2)
    expect(setup.storage.getItem('ted.other')).toBe('keep')
    expect(sessions.find(box)).toBeUndefined()

    online = true
    await sessions.recover()
    expect(save).toHaveBeenCalledTimes(4)
    expect(save.mock.calls.at(-1)).toEqual([
      { kind: 'coordinator', id: 'f1' },
      { text: 'Later', attachments: [] },
    ])
    expect(setup.storage.getItem(offline)).toBeNull()
  })

  test('the next pass saves an open box whose save failed', async () => {
    const setup = options()
    const save = vi
      .fn(async (_box: MessageBox, draft: MessageDraft): Promise<MessageDraftState> => ({ draft }))
      .mockRejectedValueOnce(new Error('offline'))
    const sessions = messageDraftSessions({
      storage: setup.storage,
      read: setup.read,
      save,
      failed: setup.failed,
      delayMs: 60_000,
    })
    const seen = vi.fn()
    const leave = sessions.join(box, seen)
    await vi.waitFor(() => expect(seen).toHaveBeenCalled())
    const session = sessions.find(box)
    session?.update((c) => ({ ...c, text: 'Typed while offline' }))
    await session?.flush()
    expect(setup.failed).toHaveBeenCalledOnce()
    expect(setup.storage.getItem(key)).toContain('Typed while offline')

    await sessions.recover()
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls.at(-1)?.[1].text).toBe('Typed while offline')
    expect(setup.storage.getItem(key)).toBeNull()
    expect(sessions.find(box)).toBe(session)
    leave()
    await vi.waitFor(() => expect(sessions.find(box)).toBeUndefined())
  })

  test('a session stays while a second pass retries a failed save', async () => {
    const setup = options()
    setup.storage.setItem(key, JSON.stringify({ text: 'Left by a quit', attachments: [] }))
    const first = Promise.withResolvers<MessageDraftState>()
    const second = Promise.withResolvers<MessageDraftState>()
    const save = vi
      .fn(async (_box: MessageBox, draft: MessageDraft): Promise<MessageDraftState> => ({ draft }))
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    const sessions = messageDraftSessions({
      storage: setup.storage,
      read: setup.read,
      save,
      failed: setup.failed,
      delayMs: 60_000,
    })
    const firstPass = sessions.recover()
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    const session = sessions.find(box)
    const secondPass = sessions.recover()
    first.reject(new Error('offline'))
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    await new Promise((done) => setTimeout(done, 0))
    expect(sessions.find(box)).toBe(session)

    const seen = vi.fn()
    const leave = sessions.join(box, seen)
    expect(sessions.find(box)).toBe(session)
    expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'Left by a quit' }))
    const cleared = session?.clear()
    second.resolve({ draft: null })
    await cleared
    await firstPass
    await secondPass
    expect(save.mock.calls.map(([, draft]) => draft.text)).toEqual([
      'Left by a quit',
      'Left by a quit',
      '',
    ])
    expect(setup.storage.getItem(key)).toBeNull()
    expect(sessions.find(box)).toBe(session)
    leave()
    await vi.waitFor(() => expect(sessions.find(box)).toBeUndefined())
  })

  test('a box opened while the start-up pass saves its text shares that queue', async () => {
    const setup = options()
    setup.storage.setItem(key, JSON.stringify({ text: 'Left by a quit', attachments: [] }))
    const first = Promise.withResolvers<MessageDraftState>()
    const save = vi
      .fn(async (_box: MessageBox, draft: MessageDraft): Promise<MessageDraftState> => ({ draft }))
      .mockImplementationOnce(() => first.promise)
    const sessions = messageDraftSessions({
      storage: setup.storage,
      read: setup.read,
      save,
      failed: setup.failed,
      delayMs: 60_000,
    })
    const recovering = sessions.recover()
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    const seen = vi.fn()
    const leave = sessions.join(box, seen)
    expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'Left by a quit' }))
    const cleared = sessions.find(box)?.clear()
    first.resolve({ draft: null })
    await cleared
    await recovering
    expect(save.mock.calls.map(([, draft]) => draft.text)).toEqual(['Left by a quit', ''])
    expect(setup.storage.getItem(key)).toBeNull()
    expect(sessions.find(box)).toBeDefined()
    leave()
    await vi.waitFor(() => expect(sessions.find(box)).toBeUndefined())
  })

  test('a box closed during its first read and reopened keeps the same session', async () => {
    const setup = options()
    setup.storage.setItem(key, JSON.stringify({ text: 'Left by a quit', attachments: [] }))
    const reading = Promise.withResolvers<MessageDraftState>()
    const read = vi.fn(() => reading.promise)
    const save = vi.fn(
      async (_box: MessageBox, draft: MessageDraft): Promise<MessageDraftState> => ({ draft }),
    )
    const sessions = messageDraftSessions({
      storage: setup.storage,
      read,
      save,
      failed: setup.failed,
      delayMs: 60_000,
    })
    const leave = sessions.join(box, vi.fn())
    const session = sessions.find(box)
    leave()
    const seen = vi.fn()
    const leaveAgain = sessions.join(box, seen)
    expect(sessions.find(box)).toBe(session)
    reading.resolve({ draft: null })
    await vi.waitFor(() =>
      expect(seen).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'Left by a quit' })),
    )
    expect(read).toHaveBeenCalledTimes(1)
    await sessions.find(box)?.clear()
    expect(save.mock.calls.map(([, draft]) => draft.text)).toEqual(['Left by a quit', ''])
    expect(setup.storage.getItem(key)).toBeNull()
    leaveAgain()
    await vi.waitFor(() => expect(sessions.find(box)).toBeUndefined())
  })
})
