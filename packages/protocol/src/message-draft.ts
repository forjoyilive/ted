import type { Attachment, AttachmentRef } from './task.ts'
import { parseAttachmentRefs } from './task-parsers.ts'
import { bodyObject, RequestValidationError } from './validation.ts'

export const messageBoxKinds = [
  'comment',
  'follow-up',
  'request',
  'plan-request',
  'run',
  'coordinator',
  'coordinator-new',
  'new-plan',
] as const

export type MessageBoxKind = (typeof messageBoxKinds)[number]

export interface MessageBox {
  kind: MessageBoxKind
  id: string
}

export interface MessageDraft {
  text: string
  attachments: Attachment[]
  fields?: string
}

export interface MessageDraftState {
  draft: MessageDraft | null
  refused?: string
}

export interface SaveMessageDraftRequest {
  text: string
  attachments: AttachmentRef[]
  fields?: string
}

export const maxMessageDraftText = 200_000
export const maxMessageDraftFields = 200_000

export function parseMessageBox(kind: string, id: string): MessageBox {
  const found = messageBoxKinds.find((k) => k === kind)
  if (!found) throw new RequestValidationError(404, 'no such message box')
  if (id === '' || id.length > 200) throw new RequestValidationError(400, 'invalid message box')
  return { kind: found, id }
}

export function parseSaveMessageDraftRequest(body: unknown): SaveMessageDraftRequest {
  const value = bodyObject(body)
  if (typeof value.text !== 'string') throw new RequestValidationError(400, 'text must be text')
  if (value.text.length > maxMessageDraftText)
    throw new RequestValidationError(400, 'text is too long to keep')
  if (value.fields !== undefined && typeof value.fields !== 'string')
    throw new RequestValidationError(400, 'fields must be text')
  if (value.fields !== undefined && value.fields.length > maxMessageDraftFields)
    throw new RequestValidationError(400, 'fields is too long to keep')
  return {
    text: value.text,
    attachments: parseAttachmentRefs(value.attachments),
    ...(value.fields !== undefined && { fields: value.fields }),
  }
}

export function emptyMessageDraft(draft: {
  text: string
  attachments: readonly unknown[]
  fields?: string | undefined
}): boolean {
  return draft.text === '' && draft.attachments.length === 0 && draft.fields === undefined
}
