import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { createCacheSeeds, filesClone } from '../src/tasks/cache-seeds.ts'

const made: string[] = []

afterEach(async () => {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function temp(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cache-seeds-'))
  made.push(dir)
  return dir
}

test('a linked seeds or sandbox folder is never written or deleted through', async () => {
  const home = await temp()
  const outside = await temp()
  await mkdir(path.join(outside, 'factory-1'))
  await writeFile(path.join(outside, 'factory-1', 'keep'), 'kept')
  await symlink(outside, path.join(home, 'seeds'))
  const seeds = createCacheSeeds({
    home,
    reposDir: path.join(home, 'repos'),
    logsDir: path.join(home, 'logs'),
    store: {} as never,
    workflows: {} as never,
    sandbox: {} as never,
    checkSlots: {} as never,
    env: () => process.env,
  })

  await seeds.remove('factory-1')
  expect(await readFile(path.join(outside, 'factory-1', 'keep'), 'utf8')).toBe('kept')
  expect(await filesClone(home, [path.join(home, 'seeds'), path.join(home, 'sandbox')])).toBe(false)
  expect(await filesClone(home, [path.join(home, 'sandbox'), path.join(home, 'seeds')])).toBe(false)
  expect(await readdir(outside)).toEqual(['factory-1'])
  await seeds.close()
})
