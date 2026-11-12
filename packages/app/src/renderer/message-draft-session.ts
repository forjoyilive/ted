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

  return {
    async load() {
      let kept: DraftContent | undefined
      try {
        kept = fromDraft((await options.read()).draft)
      } catch (error) {
        options.failed(error)
      }
      let recovery: DraftContent | undefined
      guarded(() => {
        const text = options.storage.getItem(key)
        if (text !== null) recovery = fromDraft(JSON.parse(text))
      })
      if (touched) return current
      current = recovery ?? kept ?? emptyDraftContent()
      options.changed(current)
      if (recovery) {
        dirty = true
        void persist()
      }
      return current
    },
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
    async flush() {
      if (dirty) await persist()
      else if (saving) await saving
    },
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

  return {
    find: (box: MessageBox): Session | undefined =>
      shared.get(messageDraftStorageKey(box))?.session,
    join(box: MessageBox, listener: (content: DraftContent) => void): () => void {
      const key = messageDraftStorageKey(box)
      let entry = shared.get(key)
      if (entry) {
        listener(entry.session.get())
      } else {
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
        entry = { session, listeners, users: 0 }
        shared.set(key, entry)
        void session.load()
      }
      const joined = entry
      joined.listeners.add(listener)
      joined.users += 1
      return () => {
        joined.listeners.delete(listener)
        joined.users -= 1
        if (joined.users > 0) return
        void joined.session.flush().then(() => {
          if (joined.users === 0 && shared.get(key) === joined) shared.delete(key)
        })
      }
    },
    async recover(): Promise<void> {
      const keys: string[] = []
      for (let i = 0; i < options.storage.length; i++) {
        const key = options.storage.key(i)
        if (key?.startsWith(storagePrefix)) keys.push(key)
      }
      for (const key of keys) {
        if (shared.has(key)) continue
        try {
          const stored = options.storage.getItem(key)
          if (stored === null) continue
          const [kind = '', ...rest] = key.slice(storagePrefix.length).split('.')
          let content: DraftContent | undefined
          try {
            content = fromDraft(JSON.parse(stored))
          } catch {
            content = undefined
          }
          if (content) {
            const box = { kind: kind as MessageBox['kind'], id: rest.join('.') }
            await options.save(box, toDraft(content))
          }
          if (!shared.has(key) && options.storage.getItem(key) === stored)
            options.storage.removeItem(key)
        } catch (error) {
          options.failed(error)
        }
      }
    },
  }
}
