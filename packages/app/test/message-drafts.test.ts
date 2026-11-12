import type { MessageDraft, MessageDraftState } from '@ted/protocol'
import { describe, expect, test, vi } from 'vitest'
import { messageDraftSession } from '../src/renderer/message-draft-session.ts'

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
})
