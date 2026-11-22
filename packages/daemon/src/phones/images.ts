import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, stat, unlink } from 'node:fs/promises'
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
  tedPaths,
} from '@ted/protocol'
import { redactSecrets } from '../redact.ts'
import { cutChars } from './fit.ts'
import type { PhoneOutcome } from './requests.ts'

export type ImageShrinker = (input: string, output: string) => Promise<void>

export interface PhoneImageSource {
  comment(id: string): Pick<Comment, 'taskId' | 'held' | 'attachments' | 'design'> | undefined
  task(id: string): Pick<Task, 'archived'> | undefined
  file(attachment: Pick<Attachment, 'hash' | 'name'>): string
}

export interface PhoneImageOptions extends PhoneImageSource {
  home: string
  shrink?: ImageShrinker
}

export interface PhoneImages {
  read(image: string, part: number): Promise<PhoneOutcome>
  readAttachment(file: Attachment, part: number): Promise<PhoneOutcome>
}

interface PhoneImageCache extends PhoneImages {
  prune(now?: Date): Promise<void>
}

const hashPattern = /^[0-9a-f]{64}$/
const cachedName = /^[0-9a-f]{64}\.jpg$/u
const tempName = /^\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/u
const keepMs = 7 * 24 * 60 * 60 * 1000
const cantShow = 'This image can’t be shown on your phone. Open it on your Mac.'

export function phoneImageId(commentId: string, hash: string): string | undefined {
  const id = Buffer.from(`${commentId}:${hash}`, 'utf8').toString('base64url')
  return id.length <= phoneImageIdMax ? id : undefined
}

export function parseImageId(image: string): { commentId: string; hash: string } | undefined {
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

async function cacheDirectory(home: string, create: boolean): Promise<string | undefined> {
  const root = tedPaths(await realpath(home)).phoneImages
  for (const dir of [path.dirname(root), root]) {
    const entry = await lstat(dir).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      if (!create) return undefined
      await mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      })
      return lstat(dir)
    })
    if (!entry?.isDirectory() || (await realpath(dir)) !== dir) return undefined
  }
  return root
}

async function readCached(file: string): Promise<Buffer | undefined> {
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => undefined)
  if (!handle) return undefined
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1) return undefined
    const bytes = await handle.readFile()
    await handle.utimes(info.atime, new Date()).catch((error: NodeJS.ErrnoException) => {
      console.error(redactSecrets(`couldn’t refresh a cached phone image: ${String(error)}`))
    })
    return bytes.length ? bytes : undefined
  } finally {
    await handle.close()
  }
}

async function removeCacheFile(file: string, cutoff: number): Promise<void> {
  const entry = await lstat(file)
  if (entry.isFile() && entry.mtimeMs <= cutoff && (await realpath(file)) === file) {
    await unlink(file)
  }
}

function logRemovalError(error: NodeJS.ErrnoException): void {
  if (error.code !== 'ENOENT') {
    console.error(redactSecrets(`couldn’t remove a cached phone image: ${String(error)}`))
  }
}

export function createPhoneImages(options: PhoneImageOptions): PhoneImageCache {
  const shrink = options.shrink ?? sipsShrink
  const loading = new Map<string, Promise<Buffer | undefined>>()
  const converting = new Set<string>()
  let removing: { name: string; done: Promise<void> } | undefined
  let pruning: Promise<void> | undefined

  async function sweep(now: Date): Promise<void> {
    const root = await cacheDirectory(options.home, false)
    if (!root) return
    const cutoff = now.getTime() - keepMs
    for (const name of await readdir(root)) {
      if (!cachedName.test(name) && !tempName.test(name)) continue
      if (loading.has(name) || converting.has(name)) continue
      const done = removeCacheFile(path.join(root, name), cutoff).catch(logRemovalError)
      removing = { name, done }
      await done
      removing = undefined
    }
  }

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

  async function convert(input: string, root: string, cached: string): Promise<Buffer | undefined> {
    const name = `.${randomUUID()}.jpg`
    const temp = path.join(root, name)
    converting.add(name)
    try {
      await shrink(input, temp)
      const bytes = await readCached(temp)
      if (!bytes?.length) return undefined
      await rename(temp, cached)
      return bytes
    } catch (error) {
      console.error(redactSecrets(`a phone image couldn’t be converted: ${String(error)}`))
      return undefined
    } finally {
      await removeCacheFile(temp, Infinity).catch(logRemovalError)
      converting.delete(name)
    }
  }

  async function load(name: string, input: string): Promise<Buffer | undefined> {
    if (removing?.name === name) await removing.done
    const root = await cacheDirectory(options.home, true)
    if (!root) return undefined
    const cached = path.join(root, name)
    return (await readCached(cached)) ?? convert(input, root, cached)
  }

  function jpeg(hash: string, input: string): Promise<Buffer | undefined> {
    const name = `${hash}.jpg`
    const pending = loading.get(name)
    if (pending) return pending
    const started = load(name, input)
      .catch((error: Error) => {
        console.error(redactSecrets(`couldn’t load a cached phone image: ${String(error)}`))
        return undefined
      })
      .finally(() => loading.delete(name))
    loading.set(name, started)
    return started
  }

  return {
    prune(now = new Date()) {
      pruning ??= sweep(now).finally(() => {
        pruning = undefined
      })
      return pruning
    },
    async readAttachment(file, part) {
      if (file.size > 10 * 1024 * 1024) {
        return { code: 'refused', message: 'This file is too large to open on your phone.' }
      }
      const handle = await open(
        options.file(file),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      ).catch(() => undefined)
      if (!handle) return { code: 'gone' }
      try {
        const info = await handle.stat()
        if (!info.isFile() || info.nlink !== 1 || info.size !== file.size) return { code: 'gone' }
        const parts = Math.max(1, Math.ceil(info.size / phoneImagePartBytes))
        if (part >= parts) return { code: 'bad-request' }
        const start = part * phoneImagePartBytes
        const bytes = Buffer.alloc(Math.min(phoneImagePartBytes, info.size - start))
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, start)
        if (bytesRead !== bytes.length) return { code: 'gone' }
        return {
          body: { mediaType: file.mediaType, parts, part, data: bytes.toString('base64url') },
        }
      } finally {
        await handle.close()
      }
    },
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
