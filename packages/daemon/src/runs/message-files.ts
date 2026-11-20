import type { Attachment, AttachmentRef, RunMessage } from '@ted/protocol'
import type { Attachments } from '../attachments.ts'

const heading = 'Attached files:\n'

export interface MessageWithFiles {
  text: string
  files: Attachment[]
}

export function filesBlock(
  files: readonly Attachment[],
  fileOf: (attachment: Attachment) => string,
): string {
  return `${heading}${files.map((a) => `- ${a.name}: ${fileOf(a)}`).join('\n')}`
}

export async function messageWithFiles(
  text: string,
  refs: readonly AttachmentRef[] | undefined,
  attachments: Attachments,
): Promise<MessageWithFiles> {
  const files = await Promise.all((refs ?? []).map((ref) => attachments.find(ref)))
  if (files.length === 0) return { text, files }
  const block = filesBlock(files, (a) => attachments.file(a))
  return { text: [text.trim(), block].filter((part) => part !== '').join('\n\n'), files }
}

export function shownText(message: Pick<RunMessage, 'text' | 'attachments'>): string {
  if (message.attachments === undefined || message.attachments.length === 0) return message.text
  if (message.text.startsWith(heading)) return ''
  const at = message.text.lastIndexOf(`\n\n${heading}`)
  return at === -1 ? message.text : message.text.slice(0, at)
}

export function shownMessage(message: RunMessage): RunMessage {
  return message.attachments === undefined ? message : { ...message, text: shownText(message) }
}
