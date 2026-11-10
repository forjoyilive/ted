import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Attachment, LinearFile, LinearUnfetched } from '@ted/protocol'
import { maxAttachmentBytes } from '../attachments.ts'

export const linearUploadsOrigin = 'https://uploads.linear.app'
export const maxLinearFiles = 20

export interface LinearFileStore {
  dir: string
  save(file: string, name: string, mediaType: string): Promise<Attachment>
}

export interface LinearIssueAttachment {
  url?: unknown
  title?: unknown
}

interface FileRef {
  url: string
  name: string
}

interface Downloaded {
  file: string
  mediaType: string
}

const maxRedirects = 3
const parallel = 4
const headBytes = 512
const urlPattern = /(?:(!?)\[([^\]\n]*)\]\()?(https?:\/\/[^\s<>()[\]"'`]+)/g
const bareUrlPattern = /https?:\/\/[^\s<>()[\]"'`]+/g

class DownloadError extends Error {}

export async function fetchLinearFiles(input: {
  key: string
  origins: ReadonlySet<string>
  description: string | undefined
  attachments: readonly LinearIssueAttachment[]
  store: LinearFileStore
  timeoutMs?: number
  totalMs?: number
}): Promise<{ files: LinearFile[]; unfetched: LinearUnfetched[] }> {
  const refs = fileRefs(input.description, input.attachments, input.origins)
  const taken = refs.slice(0, maxLinearFiles)
  const overall = AbortSignal.timeout(input.totalMs ?? 60_000)
  const results: (LinearFile | LinearUnfetched)[] = new Array(taken.length)
  let next = 0
  const worker = async () => {
    while (next < taken.length) {
      const index = next++
      const ref = taken[index]
      if (ref) results[index] = await fetchOne(ref)
    }
  }
  const fetchOne = async (ref: FileRef): Promise<LinearFile | LinearUnfetched> => {
    try {
      const signal = AbortSignal.any([overall, AbortSignal.timeout(input.timeoutMs ?? 30_000)])
      const got = await download(ref.url, input.key, input.origins, input.store.dir, signal)
      const attachment = await input.store
        .save(got.file, withExtension(ref.name, got.mediaType), got.mediaType)
        .finally(() => rm(got.file, { force: true }))
      return { ...attachment, url: ref.url }
    } catch (error) {
      return { name: ref.name, url: ref.url, reason: reasonOf(error) }
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallel, taken.length) }, worker))
  const files = results.filter((r): r is LinearFile => 'hash' in r)
  const unfetched = [
    ...results.filter((r): r is LinearUnfetched => 'reason' in r),
    ...refs.slice(maxLinearFiles).map((ref) => ({
      name: ref.name,
      url: ref.url,
      reason: `TED takes at most ${maxLinearFiles} files from an issue`,
    })),
  ]
  return { files, unfetched }
}

export function linkedFilesRewritten(
  text: string,
  files: readonly LinearFile[],
  to: (file: LinearFile) => string,
): string {
  const byUrl = new Map(files.map((file) => [file.url, file]))
  return text.replace(bareUrlPattern, (url) => {
    const file = byUrl.get(url)
    return file ? to(file) : url
  })
}

function fileRefs(
  description: string | undefined,
  attachments: readonly LinearIssueAttachment[],
  origins: ReadonlySet<string>,
): FileRef[] {
  const refs = new Map<string, FileRef>()
  const add = (url: string, name: string) => {
    if (refs.has(url) || !URL.canParse(url) || !origins.has(new URL(url).origin)) return
    refs.set(url, { url, name: name.trim() || 'file' })
  }
  for (const match of (description ?? '').matchAll(urlPattern)) {
    const [, bang, text, url = ''] = match
    add(url, text ?? (bang === '!' ? 'image' : ''))
  }
  for (const attachment of attachments) {
    if (typeof attachment.url !== 'string') continue
    add(attachment.url, typeof attachment.title === 'string' ? attachment.title : '')
  }
  return [...refs.values()]
}

async function download(
  url: string,
  key: string,
  origins: ReadonlySet<string>,
  dir: string,
  signal: AbortSignal,
): Promise<Downloaded> {
  let target = new URL(url)
  for (let hop = 0; ; hop++) {
    if (!origins.has(target.origin)) {
      throw new DownloadError('Linear redirected the download to another host')
    }
    let response: Response
    try {
      response = await fetch(target, {
        headers: { authorization: key },
        redirect: 'manual',
        signal,
      })
    } catch (error) {
      throw new DownloadError(
        error instanceof Error && error.name === 'TimeoutError'
          ? 'the download timed out'
          : 'TED couldn’t reach Linear',
      )
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      const location = response.headers.get('location')
      if (location === null || !URL.canParse(location, target.href)) {
        throw new DownloadError(`Linear answered ${response.status}`)
      }
      if (hop >= maxRedirects) throw new DownloadError('Linear redirected the download too often')
      target = new URL(location, target)
      continue
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new DownloadError(`Linear answered ${response.status}`)
    }
    if (Number(response.headers.get('content-length')) > maxAttachmentBytes) {
      await response.body.cancel()
      throw tooLarge()
    }
    return save(response, dir)
  }
}

async function save(response: Response, dir: string): Promise<Downloaded> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, `.linear-${randomUUID()}`)
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

function withExtension(name: string, mediaType: string): string {
  const ext = extensions[mediaType]
  if (!ext || path.extname(name) !== '') return name
  return `${name}${ext}`
}

function tooLarge(): DownloadError {
  return new DownloadError(`the file is over ${maxAttachmentBytes / 1024 / 1024} MB`)
}

function reasonOf(error: unknown): string {
  return error instanceof DownloadError ? error.message : 'TED couldn’t save the file'
}
