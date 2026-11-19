import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { piAgentCopy, piSandboxScope } from '../src/runs/pi-sandbox.ts'
import type { TedStore } from '../src/store/index.ts'

let scratch: string

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-pi-sandbox-'))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

test('a Pi folder that is a symlink to a folder is copied from the real folder, without sessions, and left unchanged', async () => {
  const dotfiles = path.join(scratch, 'dotfiles', 'pi-agent')
  await mkdir(path.join(dotfiles, 'sessions'), { recursive: true })
  await writeFile(path.join(dotfiles, 'auth.json'), '{"signedIn":true}')
  await writeFile(path.join(dotfiles, 'settings.json'), '{"model":"saved"}')
  await writeFile(path.join(dotfiles, 'sessions', 'old.jsonl'), '{}')
  const userHome = path.join(scratch, 'user')
  await mkdir(path.join(userHome, '.pi'), { recursive: true })
  const link = path.join(userHome, '.pi', 'agent')
  await symlink(dotfiles, link)
  const home = path.join(scratch, 'ted-home')
  const cwd = path.join(scratch, 'elsewhere')
  await mkdir(cwd, { recursive: true })

  const sandbox = await piSandboxScope({
    home,
    store: {} as TedStore,
    runId: 'run-1',
    taskId: undefined,
    cwd,
    env: { HOME: userHome },
  })

  const copy = path.join(home, 'runs', 'run-1', piAgentCopy)
  expect(sandbox.env).toEqual({ PI_CODING_AGENT_DIR: copy })
  expect((await readdir(copy)).sort()).toEqual(['auth.json', 'settings.json'])
  expect(await readFile(path.join(copy, 'auth.json'), 'utf8')).toBe('{"signedIn":true}')
  expect((await lstat(link)).isSymbolicLink()).toBe(true)
  expect(await readlink(link)).toBe(dotfiles)
  expect((await readdir(dotfiles)).sort()).toEqual(['auth.json', 'sessions', 'settings.json'])
  expect(await readdir(path.join(dotfiles, 'sessions'))).toEqual(['old.jsonl'])
})
