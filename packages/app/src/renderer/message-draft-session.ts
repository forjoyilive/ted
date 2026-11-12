import type { Attachment, MessageBox, MessageDraft, MessageDraftState } from '@ted/protocol'

export interface DraftContent {
  text: string
  attachments: Attachment[]
  fields: Record<string, unknown>
}

export const emptyDraftContent = (): DraftContent => ({ text: '', attachments: [], fields: {} })

export interface DraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  readonly length: number
  key(index: number): string | null
}

export const messageDraftDelayMs = 500

const storagePrefix = 'ted.messageDraft.v1.'

export const messageDraftStorageKey = (box: MessageBox) => `${storagePrefix}${box.kind}.${box.id}`

function toDraft(content: DraftContent): MessageDraft {
  const fields = Object.fromEntries(
    Object.entries(content.fields).filter(([, value]) => value !== undefined),
  )
  return {
    text: content.text,
    attachments: content.attachments,
    ...(Object.keys(fields).length > 0 && { fields: JSON.stringify(fields) }),
  }
}

function fromDraft(value: unknown): DraftContent | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const { text, attachments, fields } = value as Record<string, unknown>
  if (typeof text !== 'string' || !Array.isArray(attachments)) return undefined
  const files = attachments.filter(
    (file): file is Attachment =>
      file !== null &&
      typeof file === 'object' &&
      typeof file.hash === 'string' &&
      typeof file.name === 'string' &&
      typeof file.mediaType === 'string' &&
      typeof file.size === 'number',
  )
  let parsed: unknown = {}
  if (typeof fields === 'string') {
    try {
      parsed = JSON.parse(fields)
    } catch {
      parsed = {}
    }
  }
  return {
    text,
    attachments: files,
    fields:
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {},
  }
}

export function messageDraftSession(
  box: MessageBox,
  options: {
    storage: DraftStorage
    read(): Promise<MessageDraftState>
    save(draft: MessageDraft): Promise<MessageDraftState>
    changed(content: DraftContent): void
    failed(error: unknown): void
    delayMs?: number
  },
) {
  const key = messageDraftStorageKey(box)
  const delayMs = options.delayMs ?? messageDraftDelayMs
  let current = emptyDraftContent()
  let touched = false
  let dirty = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let saving: Promise<void> | undefined
  let loading: Promise<DraftContent> | undefined
  let reading = false
  let retrying = 0

  const guarded = (action: () => void) => {
    try {
      action()
    } catch (error) {
      options.failed(error)
    }
  }

  async function drain() {
    while (dirty) {
      dirty = false
      const sent = JSON.stringify(toDraft(current))
      try {
        await options.save(JSON.parse(sent) as MessageDraft)
      } catch (error) {
        dirty = true
        throw error
      }
      guarded(() => {
        if (options.storage.getItem(key) === sent) options.storage.removeItem(key)
      })
    }
  }

  function persist(): Promise<void> {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    saving ??= drain()
      .catch(options.failed)
      .finally(() => {
        saving = undefined
      })
    return saving
  }

  function change(next: DraftContent) {
    touched = true
    current = next
    dirty = true
    guarded(() => options.storage.setItem(key, JSON.stringify(toDraft(current))))
    options.changed(current)
  }

  async function read(): Promise<DraftContent> {
    let kept: DraftContent | undefined
    try {
      kept = fromDraft((await options.read()).draft)
    } catch (error) {
      options.failed(error)
    }
    let recovery: DraftContent | undefined
    guarded(() => {
      const text = options.storage.getItem(key)
      if (text === null) return
      try {
        recovery = fromDraft(JSON.parse(text))
      } finally {
        if (!recovery && options.storage.getItem(key) === text) options.storage.removeItem(key)
      }
    })
    if (touched) return current
    current = recovery ?? kept ?? emptyDraftContent()
    options.changed(current)
    if (recovery) {
      dirty = true
      void persist()
    }
    return current
  }

  async function flush() {
    if (dirty) await persist()
    else if (saving) await saving
  }

  const load = (): Promise<DraftContent> => {
    if (!loading) {
      reading = true
      loading = read().finally(() => {
        reading = false
      })
    }
    return loading
  }

  return {
    load,
    async settled() {
      await load()
      while (saving) await saving
    },
    async retry() {
      retrying += 1
      try {
        await load()
        if (saving) await saving
        if (dirty) await persist()
      } finally {
        retrying -= 1
      }
    },
    busy: () => reading || saving !== undefined || retrying > 0,
    get: () => current,
    update(next: (content: DraftContent) => DraftContent) {
      change(next(current))
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => void persist(), delayMs)
    },
    clear() {
      change(emptyDraftContent())
      return persist()
    },
    flush,
  }
}

type Session = ReturnType<typeof messageDraftSession>

interface Shared {
  session: Session
  listeners: Set<(content: DraftContent) => void>
  users: number
}

export function messageDraftSessions(options: {
  storage: DraftStorage
  read(box: MessageBox): Promise<MessageDraftState>
  save(box: MessageBox, draft: MessageDraft): Promise<MessageDraftState>
  failed(error: unknown): void
  delayMs?: number
}) {
  const shared = new Map<string, Shared>()

  function open(box: MessageBox): Shared {
    const key = messageDraftStorageKey(box)
    const known = shared.get(key)
    if (known) return known
    const listeners = new Set<(content: DraftContent) => void>()
    const session = messageDraftSession(box, {
      storage: options.storage,
      read: () => options.read(box),
      save: (draft) => options.save(box, draft),
      changed: (content) => {
        for (const each of listeners) each(content)
      },
      failed: options.failed,
      ...(options.delayMs !== undefined && { delayMs: options.delayMs }),
    })
    const entry = { session, listeners, users: 0 }
    shared.set(key, entry)
    void session.load()
    return entry
  }

  async function release(box: MessageBox, entry: Shared): Promise<void> {
    do {
      await entry.session.settled()
    } while (entry.session.busy())
    const key = messageDraftStorageKey(box)
    if (entry.users === 0 && shared.get(key) === entry) shared.delete(key)
  }

  return {
    find: (box: MessageBox): Session | undefined =>
      shared.get(messageDraftStorageKey(box))?.session,
    join(box: MessageBox, listener: (content: DraftContent) => void): () => void {
      const fresh = !shared.has(messageDraftStorageKey(box))
      const joined = open(box)
      if (!fresh) listener(joined.session.get())
      joined.listeners.add(listener)
      joined.users += 1
      return () => {
        joined.listeners.delete(listener)
        joined.users -= 1
        if (joined.users > 0) return
        void joined.session.flush()
        void release(box, joined)
      }
    },
    async recover(): Promise<void> {
      const waiting: Promise<void>[] = []
      for (let i = 0; i < options.storage.length; i++) {
        const key = options.storage.key(i)
        if (!key?.startsWith(storagePrefix)) continue
        const existing = shared.get(key)
        if (existing) {
          waiting.push(existing.session.retry())
          continue
        }
        const [kind = '', ...rest] = key.slice(storagePrefix.length).split('.')
        const box = { kind: kind as MessageBox['kind'], id: rest.join('.') }
        waiting.push(release(box, open(box)))
      }
      await Promise.all(waiting)
    },
  }
}
