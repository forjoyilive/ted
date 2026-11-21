import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, lstat, mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import {
  type Attachment,
  phoneFileMaxBytes,
  phoneFileMissing,
  phoneFilePartBytes,
  phoneFileParts,
  phoneFilesWaiting,
  phoneFileTooBig,
  phoneStagedBytesMax,
  phoneUploadLifetimeMs,
} from '@ted/protocol'
import { cleanMediaType } from '../attachments.ts'
import { redactSecrets } from '../redact.ts'
import type { PhoneOutcome } from './requests.ts'

export interface PhoneFileDone {
  uploadId: string
  name: string
  mediaType: string
  size: number
  sha256: string
}

export interface PhoneUploadsOptions {
  dir: string
  now: () => number
  stagedBytesMax?: number
  save(source: string, name: string, mediaType: string): Promise<Attachment>
}

export interface PhoneUploads {
  part(phoneId: string, uploadId: string, index: number, data: string): Promise<PhoneOutcome>
  done(phoneId: string, file: PhoneFileDone): Promise<PhoneOutcome>
  attach(phoneId: string, uploadIds: readonly string[]): Promise<Attachment[] | undefined>
  consume(phoneId: string, uploadIds: readonly string[]): Promise<void>
  sweep(): Promise<void>
  clear(): Promise<void>
}

export type PhoneFiles = Pick<PhoneUploads, 'attach' | 'consume'>

export async function consumeSent(
  files: PhoneFiles,
  phoneId: string,
  uploadIds: readonly string[],
): Promise<void> {
  await files.consume(phoneId, uploadIds).catch((error: Error) => {
    console.error(redactSecrets(`Ted couldn’t remove a phone’s sent files: ${String(error)}`))
  })
}

interface Upload {
  phoneId: string
  uploadId: string
  dir: string
  parts: Map<number, number>
  done?: PhoneFileDone
  touchedAt: number
  busy: number
  queue: Promise<void>
}

const safeName = /^[A-Za-z0-9_-]{1,100}$/

export function createPhoneUploads(options: PhoneUploadsOptions): PhoneUploads {
  const { dir, now } = options
  const stagedBytesMax = options.stagedBytesMax ?? phoneStagedBytesMax
  const phones = new Map<string, Map<string, Upload>>()

  const staged = (phoneId: string) => {
    let total = 0
    for (const upload of phones.get(phoneId)?.values() ?? []) {
      total += upload.done
        ? upload.done.size
        : [...upload.parts.values()].reduce((a, b) => a + b, 0)
    }
    return total
  }

  const find = (phoneId: string, uploadId: string) => phones.get(phoneId)?.get(uploadId)

  const open = (phoneId: string, uploadId: string): Upload | undefined => {
    if (!safeName.test(phoneId) || !safeName.test(uploadId)) return undefined
    const found = find(phoneId, uploadId)
    if (found) return found
    const upload: Upload = {
      phoneId,
      uploadId,
      dir: path.join(dir, phoneId, uploadId),
      parts: new Map(),
      touchedAt: now(),
      busy: 0,
      queue: Promise.resolve(),
    }
    const uploads = phones.get(phoneId) ?? new Map<string, Upload>()
    uploads.set(uploadId, upload)
    phones.set(phoneId, uploads)
    return upload
  }

  const forget = (upload: Upload) => {
    const uploads = phones.get(upload.phoneId)
    if (uploads?.get(upload.uploadId) !== upload) return
    uploads.delete(upload.uploadId)
    if (uploads.size === 0) phones.delete(upload.phoneId)
  }

  const removeUnder = async (relative: string) => {
    const target = path.join(dir, relative)
    const info = await lstat(target).catch(() => undefined)
    if (!info) return
    if (info.isSymbolicLink() || !info.isDirectory()) {
      await rm(target, { force: true })
      return
    }
    const root = await realpath(dir)
    if ((await realpath(target)) !== path.join(root, relative)) return
    await rm(target, { recursive: true, force: true })
  }

  const remove = async (upload: Upload) => {
    forget(upload)
    await removeUnder(path.join(upload.phoneId, upload.uploadId))
  }

  const locked = <T>(upload: Upload, work: () => Promise<T>): Promise<T> => {
    const result = upload.queue.then(work)
    upload.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  const failed = (error: Error, doing: string): PhoneOutcome => {
    console.error(redactSecrets(`a phone file couldn’t be ${doing}: ${String(error)}`))
    return { code: 'refused', message: phoneFileMissing }
  }

  const sweep = async () => {
    const old = [...phones.values()]
      .flatMap((uploads) => [...uploads.values()])
      .filter((upload) => upload.busy === 0 && now() - upload.touchedAt >= phoneUploadLifetimeMs)
    await Promise.all(old.map(remove))
  }

  const partFile = (upload: Upload, index: number) => path.join(upload.dir, `part-${index}`)
  const finishedFile = (upload: Upload) => path.join(upload.dir, 'file')

  const missing: PhoneOutcome = { code: 'refused', message: phoneFileMissing }

  async function join(upload: Upload, file: PhoneFileDone): Promise<PhoneOutcome> {
    const count = phoneFileParts(file.size)
    const complete =
      upload.parts.size === count &&
      [...upload.parts].every(([index, size]) =>
        index < count - 1
          ? size === phoneFilePartBytes
          : index === count - 1 && size === file.size - phoneFilePartBytes * (count - 1),
      )
    if (!complete) return missing
    await mkdir(upload.dir, { recursive: true, mode: 0o700 })
    const temp = path.join(upload.dir, `.join-${randomUUID()}`)
    const hash = createHash('sha256')
    try {
      await pipeline(
        async function* () {
          for (let index = 0; index < count; index++) {
            for await (const chunk of createReadStream(partFile(upload, index))) {
              if (Buffer.isBuffer(chunk)) {
                hash.update(chunk)
                yield chunk
              }
            }
          }
        },
        createWriteStream(temp, { mode: 0o600 }),
      )
      if (hash.digest('hex') !== file.sha256) return missing
      await rename(temp, finishedFile(upload))
    } finally {
      await rm(temp, { force: true })
    }
    await Promise.all([...upload.parts.keys()].map((index) => rm(partFile(upload, index))))
    upload.parts.clear()
    upload.done = file
    upload.touchedAt = now()
    return { body: {} }
  }

  const same = (a: PhoneFileDone, b: PhoneFileDone) =>
    a.name === b.name && a.mediaType === b.mediaType && a.size === b.size && a.sha256 === b.sha256

  return {
    async part(phoneId, uploadId, index, data) {
      await sweep()
      const upload = open(phoneId, uploadId)
      if (!upload) return missing
      return locked(upload, async () => {
        upload.touchedAt = now()
        if (upload.done) return { body: {} }
        const bytes = Buffer.from(data, 'base64')
        const earlier = upload.parts.get(index) ?? 0
        if (staged(phoneId) - earlier + bytes.length > stagedBytesMax) {
          if (upload.parts.size === 0) forget(upload)
          return { code: 'refused', message: phoneFilesWaiting }
        }
        upload.parts.set(index, bytes.length)
        try {
          await mkdir(upload.dir, { recursive: true, mode: 0o700 })
          await writeFile(partFile(upload, index), bytes, { mode: 0o600 })
        } catch (error) {
          upload.parts.delete(index)
          return failed(error instanceof Error ? error : new Error(String(error)), 'saved')
        }
        return { body: {} }
      })
    },

    async done(phoneId, file) {
      await sweep()
      if (file.size > phoneFileMaxBytes) {
        const upload = find(phoneId, file.uploadId)
        if (upload) await locked(upload, () => remove(upload))
        return { code: 'refused', message: phoneFileTooBig }
      }
      const upload =
        find(phoneId, file.uploadId) ?? (file.size === 0 ? open(phoneId, file.uploadId) : undefined)
      if (!upload) return missing
      return locked(upload, async () => {
        upload.touchedAt = now()
        if (upload.done) return same(upload.done, file) ? { body: {} } : missing
        try {
          return await join(upload, file)
        } catch (error) {
          return failed(error instanceof Error ? error : new Error(String(error)), 'joined')
        }
      })
    },

    async attach(phoneId, uploadIds) {
      await sweep()
      const uploads = uploadIds.map((id) => find(phoneId, id))
      const ready = uploads.filter((upload): upload is Upload => upload?.done !== undefined)
      if (ready.length !== uploadIds.length) return undefined
      for (const upload of ready) upload.busy++
      try {
        const attachments: Attachment[] = []
        for (const upload of ready) {
          const file = upload.done
          if (!file) return undefined
          const copy = path.join(upload.dir, `.attach-${randomUUID()}`)
          try {
            await copyFile(finishedFile(upload), copy)
            attachments.push(await options.save(copy, file.name, cleanMediaType(file.mediaType)))
          } finally {
            await rm(copy, { force: true })
          }
        }
        return attachments
      } finally {
        for (const upload of ready) upload.busy--
      }
    },

    async consume(phoneId, uploadIds) {
      const uploads = uploadIds.flatMap((id) => find(phoneId, id) ?? [])
      await Promise.all(uploads.map((upload) => locked(upload, () => remove(upload))))
    },

    sweep,

    async clear() {
      phones.clear()
      const info = await lstat(dir).catch(() => undefined)
      if (!info) return
      if (info.isSymbolicLink() || !info.isDirectory()) {
        await rm(dir, { force: true })
        return
      }
      const parent = await realpath(path.dirname(dir))
      if ((await realpath(dir)) !== path.join(parent, path.basename(dir))) return
      await rm(dir, { recursive: true, force: true })
    },
  }
}
