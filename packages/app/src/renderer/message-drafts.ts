import type { Attachment, MessageBox } from '@ted/protocol'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  type DraftContent,
  emptyDraftContent,
  messageDraftSessions,
} from './message-draft-session.ts'
import { ted } from './ted.ts'

const sessions = messageDraftSessions({
  storage: {
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
    removeItem: (key) => localStorage.removeItem(key),
    get length() {
      return localStorage.length
    },
    key: (index) => localStorage.key(index),
  },
  read: (box) => ted.messageDraft(box),
  save: (box, draft) => ted.saveMessageDraft(box, draft),
  failed: (error) => console.warn('couldn’t keep unsent text:', error),
})

export const recoverMessageDrafts = (): Promise<void> => sessions.recover()

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
    return sessions.join({ kind, id }, setContent)
  }, [kind, id])

  const update = useCallback(
    (next: (content: DraftContent) => DraftContent) => {
      const session = kind !== undefined && id !== undefined && sessions.find({ kind, id })
      if (session) session.update(next)
      else setContent(next)
    },
    [kind, id],
  )

  const clear = useCallback(() => {
    const session = kind !== undefined && id !== undefined && sessions.find({ kind, id })
    if (session) void session.clear()
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
