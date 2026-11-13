import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Attachment } from '@ted/protocol'
import { maxAttachmentBytes } from './attachments.ts'

export class DownloadError extends Error {}

export interface FileStore {
  dir: string
  save(file: string, name: string, mediaType: string): Promise<Attachment>
}

export interface Downloaded {
  file: string
  mediaType: string
}

const headBytes = 512

export async function saveDownload(
  response: Response,
  dir: string,
  prefix: string,
): Promise<Downloaded> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, `.${prefix}-${randomUUID()}`)
  let head = Buffer.alloc(0)
  let size = 0
  try {
    await pipeline(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          size += chunk.length
          if (size > maxAttachmentBytes) throw tooLarge()
          if (head.length < headBytes) head = Buffer.concat([head, chunk]).subarray(0, headBytes)
          yield chunk
        }
      },
      createWriteStream(file, { mode: 0o600 }),
    )
  } catch (error) {
    await rm(file, { force: true })
    if (error instanceof DownloadError) throw error
    throw new DownloadError('the download stopped partway')
  }
  return { file, mediaType: mediaTypeOf(head, response.headers.get('content-type')) }
}

const signatures: [string, (head: Buffer) => boolean][] = [
  ['image/png', (h) => h.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))],
  ['image/jpeg', (h) => h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff],
  ['image/gif', (h) => h.subarray(0, 4).toString('latin1') === 'GIF8'],
  [
    'image/webp',
    (h) =>
      h.subarray(0, 4).toString('latin1') === 'RIFF' &&
      h.subarray(8, 12).toString('latin1') === 'WEBP',
  ],
  ['application/pdf', (h) => h.subarray(0, 5).toString('latin1') === '%PDF-'],
]

function mediaTypeOf(head: Buffer, header: string | null): string {
  const sniffed = signatures.find(([, matches]) => matches(head))?.[0]
  if (sniffed) return sniffed
  const declared = header?.split(';')[0]?.trim().toLowerCase() ?? ''
  if (declared === 'image/svg+xml' && /^\s*(<\?xml|<svg|<!--)/i.test(head.toString('utf8'))) {
    return declared
  }
  const checked = declared.startsWith('image/') || declared === 'application/pdf'
  if (checked || declared === 'text/html' || !/^[\w.+-]+\/[\w.+-]+$/.test(declared)) {
    return 'application/octet-stream'
  }
  return declared
}

const extensions: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
}

export function withExtension(name: string, mediaType: string): string {
  const ext = extensions[mediaType]
  if (!ext || path.extname(name) !== '') return name
  return `${name}${ext}`
}

export function tooLarge(): DownloadError {
  return new DownloadError(`the file is over ${maxAttachmentBytes / 1024 / 1024} MB`)
}
