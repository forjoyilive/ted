import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  type Attachment,
  type Comment,
  fromBase64Url,
  type PhoneImage,
  phoneImageCaptionMax,
  phoneImageIdMax,
  phoneImagePartBytes,
  phoneImageWidthMax,
  type Task,
} from '@ted/protocol'
import { redactSecrets } from '../redact.ts'
import { cutChars } from './fit.ts'
import type { PhoneOutcome } from './requests.ts'

export type ImageShrinker = (input: string, output: string) => Promise<void>

export interface PhoneImageSource {
  comment(id: string): Comment | undefined
  task(id: string): Task | undefined
  file(attachment: Pick<Attachment, 'hash' | 'name'>): string
}

export interface PhoneImageOptions extends PhoneImageSource {
  cacheDir: string
  shrink?: ImageShrinker
}

export interface PhoneImages {
  read(image: string, part: number): Promise<PhoneOutcome>
}

const hashPattern = /^[0-9a-f]{64}$/
const cantShow = 'This image can’t be shown on your phone. Open it on your Mac.'

export function phoneImageId(commentId: string, hash: string): string | undefined {
  const id = Buffer.from(`${commentId}:${hash}`, 'utf8').toString('base64url')
  return id.length <= phoneImageIdMax ? id : undefined
}

function parseImageId(image: string): { commentId: string; hash: string } | undefined {
  const bytes = fromBase64Url(image)
  if (!bytes) return undefined
  const text = Buffer.from(bytes).toString('utf8')
  const at = text.lastIndexOf(':')
  const commentId = text.slice(0, at)
  const hash = text.slice(at + 1)
  return at > 0 && hashPattern.test(hash) ? { commentId, hash } : undefined
}

export function phoneCaption(text: string): string {
  return cutChars(redactSecrets(text), phoneImageCaptionMax)
}

export function isImage(file: Pick<Attachment, 'mediaType'>): boolean {
  return file.mediaType.startsWith('image/')
}

export interface PhoneImageList {
  images: PhoneImage[]
  others: number
}

export function phoneImageList(commentId: string, files: readonly Attachment[]): PhoneImageList {
  const images = files.flatMap((file) => {
    const image = isImage(file) ? phoneImageId(commentId, file.hash) : undefined
    return image === undefined ? [] : [{ image, caption: phoneCaption(file.name) }]
  })
  return { images, others: files.length - images.length }
}

const run = promisify(execFile)

export const sipsShrink: ImageShrinker = async (input, output) => {
  const sips = '/usr/bin/sips'
  const { stdout } = await run(sips, ['-g', 'pixelWidth', input], { timeout: 30_000 })
  const width = Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1])
  if (!Number.isInteger(width) || width < 1) throw new Error('sips found no pixel width')
  const resample = width > phoneImageWidthMax ? ['--resampleWidth', String(phoneImageWidthMax)] : []
  await run(
    sips,
    ['-s', 'format', 'jpeg', '-s', 'formatOptions', '75', ...resample, input, '--out', output],
    { timeout: 60_000 },
  )
}

export function createPhoneImages(options: PhoneImageOptions): PhoneImages {
  const shrink = options.shrink ?? sipsShrink
  const loading = new Map<string, Promise<Buffer | undefined>>()

  function resolve(image: string): Pick<Attachment, 'hash' | 'name'> | undefined {
    const ref = parseImageId(image)
    const comment = ref && options.comment(ref.commentId)
    if (!ref || !comment || comment.held) return undefined
    const task = options.task(comment.taskId)
    if (!task || task.archived) return undefined
    return (
      comment.attachments?.find((file) => file.hash === ref.hash && isImage(file)) ??
      comment.design?.screenshots?.find((file) => file.hash === ref.hash)
    )
  }

  async function convert(input: string, cached: string): Promise<Buffer | undefined> {
    const temp = path.join(options.cacheDir, `.${randomUUID()}.jpg`)
    try {
      await mkdir(options.cacheDir, { recursive: true, mode: 0o700 })
      await shrink(input, temp)
      const bytes = await readFile(temp)
      if (bytes.length === 0) return undefined
      await rename(temp, cached)
      return bytes
    } catch (error) {
      console.error(redactSecrets(`a phone image couldn’t be converted: ${String(error)}`))
      return undefined
    } finally {
      await rm(temp, { force: true })
    }
  }

  async function load(hash: string, input: string): Promise<Buffer | undefined> {
    const cached = path.join(options.cacheDir, `${hash}.jpg`)
    return (await readFile(cached).catch(() => undefined)) ?? convert(input, cached)
  }

  function jpeg(hash: string, input: string): Promise<Buffer | undefined> {
    const pending = loading.get(hash)
    if (pending) return pending
    const started = load(hash, input).finally(() => loading.delete(hash))
    loading.set(hash, started)
    return started
  }

  return {
    async read(image, part) {
      const found = resolve(image)
      if (!found) return { code: 'gone' }
      const input = options.file(found)
      const there = await stat(input).then(
        (info) => info.isFile(),
        () => false,
      )
      if (!there) return { code: 'gone' }
      const bytes = await jpeg(found.hash, input)
      if (!bytes) return { code: 'refused', message: cantShow }
      const parts = Math.max(1, Math.ceil(bytes.length / phoneImagePartBytes))
      if (part >= parts) return { code: 'bad-request' }
      const start = part * phoneImagePartBytes
      return {
        body: {
          mediaType: 'image/jpeg',
          parts,
          part,
          data: bytes.subarray(start, start + phoneImagePartBytes).toString('base64url'),
        },
      }
    },
  }
}
