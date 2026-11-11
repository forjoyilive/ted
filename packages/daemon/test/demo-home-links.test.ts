import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { prepareDemo } from '../src/dev/demo.ts'
import { checkDemoHome, demoVersion, markDemo } from '../src/dev/home.ts'

let folder: string
let home: string
let outside: string
beforeEach(async () => {
  const parent = path.resolve('node_modules/.cache/ted-home')
  await mkdir(parent, { recursive: true })
  folder = await mkdtemp(path.join(parent, 'demo-links-'))
  home = path.join(folder, 'demo')
  outside = path.join(folder, 'outside')
  await mkdir(outside)
  await writeFile(path.join(outside, 'keep.txt'), 'Untouched')
  await markDemo(home, { version: demoVersion, complete: true })
})
afterEach(async () => {
  expect(await readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe('Untouched')
  expect(await readdir(outside)).toEqual(['keep.txt'])
  await rm(folder, { recursive: true, force: true })
})

test.each(['attachments', 'backups', 'tmp', 'simulators', 'scratch', 'future-data'])(
  'refuses a linked %s directory before reusing the demo',
  async (name) => {
    await symlink(outside, path.join(home, name))
    await expect(prepareDemo(home)).rejects.toThrow(`${name} must not be a link`)
  },
)

test.each([
  'gh.json',
  'xcrun.json',
  'xcrun.json.calls',
  'stub-claude.json',
  'stub-codex.json',
  'stub-keyring.json',
  'notifications.jsonl',
  'fix.log',
  'logs/daemon.log',
  'logs/daemon-output.log',
  'secrets/linear-api-key',
  'inputs/round.json',
  'store/nested/database.sqlite',
  'electron/Preferences',
])('refuses a linked managed file at %s', async (name) => {
  const file = path.join(home, name)
  await mkdir(path.dirname(file), { recursive: true })
  await symlink(path.join(outside, 'keep.txt'), file)
  await expect(checkDemoHome(home)).rejects.toThrow('must not be a link')
})

test('allows Electron singleton IPC links without traversing their targets', async () => {
  await mkdir(path.join(home, 'electron'))
  for (const name of ['SingletonCookie', 'SingletonLock', 'SingletonSocket'])
    await symlink('runtime-ipc-target', path.join(home, 'electron', name))
  await expect(checkDemoHome(home)).resolves.toMatchObject({ complete: true })
})
