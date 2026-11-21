import { randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { tedPaths } from '@ted/protocol'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { startDaemon } from '../src/index.ts'
import { createPhoneImages, phoneImageId } from '../src/phones/images.ts'
import { stubClaudePath, waitUntil } from './helpers.ts'

const day = 24 * 60 * 60 * 1000
const hash = 'a'.repeat(64)
const photo = { hash, name: 'photo.png', size: 5, mediaType: 'image/png' }
let home: string
let cache: string
let source: string

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'ted-phone-image-cache-'))
  cache = tedPaths(home).phoneImages
  source = path.join(home, photo.name)
  await writeFile(source, 'photo')
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

function images(
  shrink = vi.fn(async (input: string, output: string) => writeFile(output, await readFile(input))),
) {
  return {
    cache: createPhoneImages({
      home,
      task: () => ({}),
      comment: () => ({ taskId: 'task', attachments: [photo] }),
      file: () => source,
      shrink,
    }),
    shrink,
  }
}

async function makeOld(file: string, now: Date) {
  const old = new Date(now.getTime() - 7 * day)
  await utimes(file, old, old)
}

test('only expired regular cache copies and conversion temp files are removed', async () => {
  await mkdir(cache, { recursive: true })
  const now = new Date(Math.floor(Date.now() / 1000) * 1000)
  const expired = [`${hash}.jpg`, `.${randomUUID()}.jpg`]
  const recent = [`${'b'.repeat(64)}.jpg`, `.${randomUUID()}.jpg`]
  const unrelated = 'notes.jpg'
  const link = `${'c'.repeat(64)}.jpg`
  const directory = `${'d'.repeat(64)}.jpg`
  for (const name of [...expired, ...recent, unrelated]) {
    await writeFile(path.join(cache, name), name)
  }
  for (const name of [...expired, unrelated]) await makeOld(path.join(cache, name), now)
  await mkdir(path.join(cache, directory))
  await makeOld(path.join(cache, directory), now)
  await makeOld(source, now)
  await symlink(source, path.join(cache, link))

  await images().cache.prune(now)

  expect((await readdir(cache)).sort()).toEqual([...recent, unrelated, link, directory].sort())
  expect((await lstat(path.join(cache, link))).isSymbolicLink()).toBe(true)
  expect(await readFile(source, 'utf8')).toBe('photo')
})

test.each(['cache', path.join('cache', 'phone-images')])(
  'pruning skips a linked %s directory',
  async (linked) => {
    const outside = await mkdtemp(path.join(home, 'unrelated-'))
    const target = linked === 'cache' ? path.join(outside, 'phone-images') : outside
    await mkdir(target, { recursive: true })
    const file = path.join(target, `${hash}.jpg`)
    await writeFile(file, 'keep')
    const now = new Date()
    await makeOld(file, now)
    await mkdir(path.dirname(path.join(home, linked)), { recursive: true })
    await symlink(outside, path.join(home, linked), 'dir')

    await images().cache.prune(now)

    expect(await readFile(file, 'utf8')).toBe('keep')
  },
)

test('reading renews an old cached image and reopening after eviction regenerates it', async () => {
  const { cache: phoneImages, shrink } = images()
  const id = phoneImageId('comment', hash) ?? ''
  const reply = await phoneImages.read(id, 0)
  expect(reply).toMatchObject({ body: { data: Buffer.from('photo').toString('base64url') } })

  const cached = path.join(cache, `${hash}.jpg`)
  await makeOld(cached, new Date())
  expect(await phoneImages.read(id, 0)).toEqual(reply)
  await phoneImages.prune()
  expect(await readdir(cache)).toEqual([`${hash}.jpg`])
  expect(shrink).toHaveBeenCalledTimes(1)

  await makeOld(cached, new Date())
  await phoneImages.prune()
  expect(await readdir(cache)).toEqual([])
  expect(await phoneImages.read(id, 0)).toEqual(reply)
  expect(shrink).toHaveBeenCalledTimes(2)
})

test('a sweep leaves a conversion’s temp file alone until the conversion finishes', async () => {
  const started = Promise.withResolvers<string>()
  const resume = Promise.withResolvers<void>()
  const { cache: phoneImages } = images(
    vi.fn(async (input: string, output: string) => {
      await writeFile(output, await readFile(input))
      started.resolve(output)
      await resume.promise
    }),
  )
  const request = phoneImages.read(phoneImageId('comment', hash) ?? '', 0)
  try {
    const temp = await Promise.race([
      started.promise,
      request.then(() => {
        throw new Error('Image request finished before the conversion paused')
      }),
    ])
    await phoneImages.prune(new Date(Date.now() + 8 * day))
    expect(await readFile(temp, 'utf8')).toBe('photo')
  } finally {
    resume.resolve()
    await request
  }
  expect(await request).toMatchObject({ body: { mediaType: 'image/jpeg' } })
  expect(await readdir(cache)).toEqual([`${hash}.jpg`])
})

test('the daemon’s retention timer prunes the cache without a paired phone', async () => {
  await mkdir(cache, { recursive: true })
  const name = `${hash}.jpg`
  await writeFile(path.join(cache, name), 'photo')
  const now = new Date()
  let retentionTime = now
  const daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    retention: { now: () => retentionTime, checkEveryMs: 200 },
  })
  try {
    expect(await readdir(cache)).toEqual([name])
    retentionTime = new Date(now.getTime() + 8 * day)
    await waitUntil(async () => (await readdir(cache)).length === 0 || undefined, 'cache eviction')
  } finally {
    await daemon.stop()
  }
})
