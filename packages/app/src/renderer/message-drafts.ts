import type { Attachment, MessageBox } from '@ted/protocol'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  type DraftContent,
  emptyDraftContent,
  messageDraftSession,
  messageDraftStorageKey,
} from './message-draft-session.ts'
import { ted } from './ted.ts'

type Session = ReturnType<typeof messageDraftSession>

interface Shared {
  session: Session
  listeners: Set<(content: DraftContent) => void>
  users: number
}

const shared = new Map<string, Shared>()

function join(box: MessageBox, listener: (content: DraftContent) => void): () => void {
  const key = messageDraftStorageKey(box)
  let entry = shared.get(key)
  if (!entry) {
    const listeners = new Set<(content: DraftContent) => void>()
    const session = messageDraftSession(box, {
      storage: localStorage,
      read: () => ted.messageDraft(box),
      save: (draft) => ted.saveMessageDraft(box, draft),
      changed: (content) => {
        for (const each of listeners) each(content)
      },
      failed: (error) => console.warn('couldn’t keep unsent text:', error),
    })
    entry = { session, listeners, users: 0 }
    shared.set(key, entry)
    void session.load()
  } else {
    listener(entry.session.get())
  }
  const joined = entry
  joined.listeners.add(listener)
  joined.users += 1
  return () => {
    joined.listeners.delete(listener)
    joined.users -= 1
    if (joined.users > 0) return
    if (shared.get(key) === joined) shared.delete(key)
    void joined.session.flush()
  }
}

export interface MessageDraftHandle {
  text: string
  attachments: Attachment[]
  fields: Record<string, unknown>
  setText(text: string): void
  setAttachments(next: (files: Attachment[]) => Attachment[]): void
  setField(name: string, value: unknown): void
  clear(): void
}

export function useMessageDraft(box: MessageBox | undefined): MessageDraftHandle {
  const kind = box?.kind
  const id = box?.id
  const [content, setContent] = useState(emptyDraftContent)

  useEffect(() => {
    setContent(emptyDraftContent())
    if (kind === undefined || id === undefined) return
    return join({ kind, id }, setContent)
  }, [kind, id])

  const update = useCallback(
    (next: (content: DraftContent) => DraftContent) => {
      const entry =
        kind !== undefined && id !== undefined && shared.get(messageDraftStorageKey({ kind, id }))
      if (entry) entry.session.update(next)
      else setContent(next)
    },
    [kind, id],
  )

  const clear = useCallback(() => {
    const entry =
      kind !== undefined && id !== undefined && shared.get(messageDraftStorageKey({ kind, id }))
    if (entry) void entry.session.clear()
    else setContent(emptyDraftContent())
  }, [kind, id])

  return useMemo(
    () => ({
      ...content,
      setText: (text) => update((c) => ({ ...c, text })),
      setAttachments: (next) => update((c) => ({ ...c, attachments: next(c.attachments) })),
      setField: (name, value) => update((c) => ({ ...c, fields: { ...c.fields, [name]: value } })),
      clear,
    }),
    [content, update, clear],
  )
}

export function draftField<T>(
  draft: MessageDraftHandle,
  name: string,
  initial: T,
  valid: (value: unknown) => value is T,
): [T, (value: T) => void] {
  const kept = draft.fields[name]
  return [valid(kept) ? kept : initial, (value) => draft.setField(name, value)]
}
