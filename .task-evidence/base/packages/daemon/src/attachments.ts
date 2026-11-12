import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import type http from 'node:http'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Attachment, AttachmentBytes } from '@ted/protocol'
import { RequestError } from './errors.ts'

export const maxAttachmentBytes = 25 * 1024 * 1024

const hashPattern = /^[0-9a-f]{64}$/
const mediaTypePattern = /^[\w.+-]+\/[\w.+-]+$/

export interface Attachments {
  save(req: http.IncomingMessage): Promise<Attachment>
  saveFile(source: string, name: string, mediaType: string): Promise<Attachment>
  find(input: { hash: string; name: string; mediaType: string }): Promise<Attachment>
  file(attachment: Pick<Attachment, 'hash' | 'name'>): string
  read(attachment: Pick<Attachment, 'hash' | 'name'>): Promise<AttachmentBytes>
}

export function createAttachments(dir: string): Attachments {
  const file = ({ hash, name }: Pick<Attachment, 'hash' | 'name'>) =>
    path.join(dir, `${hash}${extension(name)}`)

  return {
    file,

    async save(req) {
      const name = cleanName(headerName(req.headers['x-ted-name']))
      if (name === '') throw new RequestError(400, 'an attachment needs a name')
      const mediaType = cleanMediaType(req.headers['content-type'])
      if (Number(req.headers['content-length']) > maxAttachmentBytes) throw tooLarge()

      await mkdir(dir, { recursive: true, mode: 0o700 })
      const temp = path.join(dir, `.upload-${randomUUID()}`)
      const hash = createHash('sha256')
      let size = 0
      try {
        await pipeline(
          req,
          async function* (chunks: AsyncIterable<Buffer>) {
            for await (const chunk of chunks) {
              size += chunk.length
              if (size > maxAttachmentBytes) throw tooLarge()
              hash.update(chunk)
              yield chunk
            }
          },
          createWriteStream(temp, { mode: 0o600 }),
        )
        const attachment = { hash: hash.digest('hex'), name, size, mediaType }
        await rename(temp, file(attachment))
        return attachment
      } finally {
        await rm(temp, { force: true })
      }
    },

    async saveFile(source, name, mediaType) {
      const clean = cleanName(name)
      if (clean === '') throw new RequestError(400, 'an attachment needs a name')
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const hash = createHash('sha256')
      let size = 0
      await pipeline(createReadStream(source), async (chunks: AsyncIterable<Buffer>) => {
        for await (const chunk of chunks) {
          size += chunk.length
          hash.update(chunk)
        }
      })
      const attachment = { hash: hash.digest('hex'), name: clean, size, mediaType }
      await rename(source, file(attachment))
      return attachment
    },

    async read({ hash, name }) {
      const clean = cleanName(name)
      if (!hashPattern.test(hash) || clean === '') {
        throw new RequestError(400, 'an attachment needs a hash and a name')
      }
      const target = file({ hash, name: clean })
      const found = await stat(target).catch(() => undefined)
      if (!found?.isFile()) throw new RequestError(404, `no attachment ${clean}`)
      const data = await readFile(target)
      return { data: data.toString('base64') }
    },

    async find({ hash, name, mediaType }) {
      const clean = cleanName(name)
      if (!hashPattern.test(hash) || clean === '') {
        throw new RequestError(400, 'an attachment needs a hash and a name')
      }
      const found = await stat(file({ hash, name: clean })).catch(() => undefined)
      if (!found?.isFile()) throw new RequestError(400, `no uploaded attachment ${clean}`)
      return { hash, name: clean, size: found.size, mediaType: cleanMediaType(mediaType) }
    },
  }
}

function tooLarge(): RequestError {
  return new RequestError(413, `attachments must be under ${maxAttachmentBytes / 1024 / 1024} MB`)
}

function headerName(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

function cleanName(name: string): string {
  const last = name.split(/[\\/]/).at(-1) ?? ''
  return last
    .replace(/\p{Cc}/gu, '')
    .trim()
    .replace(/^\.+$/, '')
    .slice(0, 255)
}

function cleanMediaType(value: string | string[] | undefined): string {
  const type = (Array.isArray(value) ? value[0] : value)?.split(';')[0]?.trim().toLowerCase()
  return type && mediaTypePattern.test(type) ? type : 'application/octet-stream'
}

function extension(name: string): string {
  const ext = path.extname(name).toLowerCase()
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : ''
}
