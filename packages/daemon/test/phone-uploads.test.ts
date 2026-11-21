import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  phoneFileMaxBytes,
  phoneFileMissing,
  phoneFilePartBytes,
  phoneFilesWaiting,
  phoneFileTooBig,
  phoneUploadLifetimeMs,
  toBase64Url,
} from '@ted/protocol'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createAttachments } from '../src/attachments.ts'
import { createPhoneUploads, type PhoneUploads } from '../src/phones/uploads.ts'

let scratch: string
let staging: string
let store: string
let clock: number
let uploads: PhoneUploads

const phone = 'phone-a'
const other = 'phone-b'
const ok = { body: {} }
const missing = { code: 'refused', message: phoneFileMissing }

const uploadId = () => toBase64Url(randomBytes(16))
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

function parts(bytes: Buffer): string[] {
  const out: string[] = []
  for (let at = 0; at < bytes.length; at += phoneFilePartBytes) {
    out.push(bytes.subarray(at, at + phoneFilePartBytes).toString('base64'))
  }
  return out
}

async function sendParts(phoneId: string, id: string, bytes: Buffer): Promise<void> {
  const all = parts(bytes)
  const order = [...all.keys()].reverse()
  for (const index of order) {
    expect(await uploads.part(phoneId, id, index, all[index] ?? '')).toEqual(ok)
  }
}

const doneOf = (id: string, bytes: Buffer, name = 'IMG_2031.jpg') => ({
  uploadId: id,
  name,
  mediaType: 'image/jpeg',
  size: bytes.length,
  sha256: sha(bytes),
})

function make(stagedBytesMax?: number): PhoneUploads {
  const attachments = createAttachments(store)
  return createPhoneUploads({
    dir: staging,
    now: () => clock,
    ...(stagedBytesMax !== undefined && { stagedBytesMax }),
    save: (source, name, mediaType) => attachments.saveFile(source, name, mediaType),
  })
}

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-phone-uploads-'))
  staging = path.join(scratch, 'phone-uploads')
  store = path.join(scratch, 'attachments')
  clock = 1_000_000
  uploads = make()
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

test('parts sent in any order, with one sent again, join into the file and attach to the store', async () => {
  const bytes = randomBytes(phoneFilePartBytes * 2 + 100)
  const id = uploadId()
  expect(
    await uploads.part(phone, id, 1, randomBytes(phoneFilePartBytes).toString('base64')),
  ).toEqual(ok)
  await sendParts(phone, id, bytes)
  expect(await uploads.done(phone, doneOf(id, bytes))).toEqual(ok)
  expect(await uploads.done(phone, doneOf(id, bytes))).toEqual(ok)
  expect(await uploads.done(phone, doneOf(id, bytes, 'other.jpg'))).toEqual(missing)

  const attached = await uploads.attach(phone, [id])
  expect(attached).toEqual([
    { hash: sha(bytes), name: 'IMG_2031.jpg', size: bytes.length, mediaType: 'image/jpeg' },
  ])
  expect(await readFile(path.join(store, `${sha(bytes)}.jpg`))).toEqual(bytes)
  expect(await uploads.attach(phone, [id])).toHaveLength(1)

  await uploads.consume(phone, [id])
  expect(await uploads.attach(phone, [id])).toBeUndefined()
  expect(await readdir(path.join(staging, phone))).toEqual([])
})

test('an empty file needs no parts', async () => {
  const id = uploadId()
  const empty = Buffer.alloc(0)
  expect(await uploads.done(phone, doneOf(id, empty, 'empty.txt'))).toEqual(ok)
  expect(await uploads.attach(phone, [id])).toMatchObject([{ name: 'empty.txt', size: 0 }])
})

test('a wrong hash, a missing part, a short middle part or a wrong size is refused and leaves nothing to attach', async () => {
  const bytes = randomBytes(phoneFilePartBytes * 3)
  const all = parts(bytes)

  const wrongHash = uploadId()
  await sendParts(phone, wrongHash, bytes)
  expect(
    await uploads.done(phone, { ...doneOf(wrongHash, bytes), sha256: 'a'.repeat(64) }),
  ).toEqual(missing)
  expect(await uploads.attach(phone, [wrongHash])).toBeUndefined()
  expect(await uploads.done(phone, doneOf(wrongHash, bytes))).toEqual(ok)

  const gap = uploadId()
  await uploads.part(phone, gap, 0, all[0] ?? '')
  await uploads.part(phone, gap, 2, all[2] ?? '')
  expect(await uploads.done(phone, doneOf(gap, bytes))).toEqual(missing)

  const short = uploadId()
  await uploads.part(phone, short, 0, all[0] ?? '')
  await uploads.part(phone, short, 1, randomBytes(10).toString('base64'))
  await uploads.part(phone, short, 2, all[2] ?? '')
  expect(await uploads.done(phone, doneOf(short, bytes))).toEqual(missing)

  const sized = uploadId()
  await sendParts(phone, sized, bytes)
  expect(await uploads.done(phone, { ...doneOf(sized, bytes), size: bytes.length - 1 })).toEqual(
    missing,
  )
  expect(await uploads.done(phone, { ...doneOf(sized, bytes), size: bytes.length + 1 })).toEqual(
    missing,
  )

  expect(await uploads.done(phone, doneOf(uploadId(), bytes))).toEqual(missing)
})

test('a file over 10 MB is refused with its own sentence', async () => {
  const id = uploadId()
  await uploads.part(phone, id, 0, randomBytes(phoneFilePartBytes).toString('base64'))
  expect(
    await uploads.done(phone, {
      uploadId: id,
      name: 'big.mov',
      mediaType: 'video/quicktime',
      size: phoneFileMaxBytes + 1,
      sha256: 'a'.repeat(64),
    }),
  ).toEqual({ code: 'refused', message: phoneFileTooBig })
  expect(await uploads.attach(phone, [id])).toBeUndefined()
})

test('an upload is deleted one hour after its last part or done message', async () => {
  const bytes = randomBytes(phoneFilePartBytes + 1)
  const all = parts(bytes)
  const slow = uploadId()
  await uploads.part(phone, slow, 0, all[0] ?? '')
  clock += phoneUploadLifetimeMs - 1
  await uploads.part(phone, slow, 1, all[1] ?? '')
  clock += phoneUploadLifetimeMs - 1
  expect(await uploads.done(phone, doneOf(slow, bytes))).toEqual(ok)
  clock += phoneUploadLifetimeMs - 1
  expect(await uploads.attach(phone, [slow])).toHaveLength(1)

  clock += 1
  expect(await uploads.attach(phone, [slow])).toBeUndefined()
  expect(await readdir(path.join(staging, phone))).toEqual([])

  const stale = uploadId()
  await uploads.part(phone, stale, 0, all[0] ?? '')
  clock += phoneUploadLifetimeMs
  await uploads.sweep()
  await uploads.part(phone, stale, 1, all[1] ?? '')
  expect(await uploads.done(phone, doneOf(stale, bytes))).toEqual(missing)
})

test('another phone can’t finish, attach or consume a phone’s upload', async () => {
  const bytes = randomBytes(100)
  const id = uploadId()
  await sendParts(phone, id, bytes)
  expect(await uploads.done(other, doneOf(id, bytes))).toEqual(missing)
  expect(await uploads.done(phone, doneOf(id, bytes))).toEqual(ok)
  expect(await uploads.attach(other, [id])).toBeUndefined()
  await uploads.consume(other, [id])
  expect(await uploads.attach(phone, [id])).toHaveLength(1)
})

test('attach answers nothing unless every upload has finished', async () => {
  const bytes = randomBytes(100)
  const finished = uploadId()
  await sendParts(phone, finished, bytes)
  await uploads.done(phone, doneOf(finished, bytes))
  const half = uploadId()
  await sendParts(phone, half, bytes)
  expect(await uploads.attach(phone, [finished, half])).toBeUndefined()
  expect(await uploads.attach(phone, [finished, uploadId()])).toBeUndefined()
  expect(await readdir(store).catch(() => [])).toEqual([])
})

test('a phone past its staging limit is refused until files are consumed, and other phones are not', async () => {
  uploads = make(phoneFilePartBytes * 2)
  const part = () => randomBytes(phoneFilePartBytes)
  const first = part()
  const a = uploadId()
  expect(await uploads.part(phone, a, 0, first.toString('base64'))).toEqual(ok)
  expect(await uploads.part(phone, a, 0, part().toString('base64'))).toEqual(ok)
  const b = uploadId()
  expect(await uploads.part(phone, b, 0, part().toString('base64'))).toEqual(ok)
  const c = uploadId()
  expect(await uploads.part(phone, c, 0, part().toString('base64'))).toEqual({
    code: 'refused',
    message: phoneFilesWaiting,
  })
  expect(await uploads.part(other, c, 0, part().toString('base64'))).toEqual(ok)
  await uploads.consume(phone, [a])
  expect(await uploads.part(phone, c, 0, part().toString('base64'))).toEqual(ok)
})

test('clear removes everything left from before the daemon started', async () => {
  const id = uploadId()
  await uploads.part(phone, id, 0, randomBytes(10).toString('base64'))
  await uploads.clear()
  expect(await readdir(scratch)).not.toContain('phone-uploads')
  expect(await uploads.done(phone, doneOf(id, randomBytes(10)))).toEqual(missing)
})
