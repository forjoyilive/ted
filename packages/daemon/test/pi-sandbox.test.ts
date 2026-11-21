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
import type { Run } from '@ted/protocol'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { fromPiFiles } from '../src/agents/pi-files.ts'
import { type PiFilesInput, piFilesText } from '../src/runs/pi-files.ts'
import { piAgentCopy, piSandboxScope } from '../src/runs/pi-sandbox.ts'
import type { StoredTask, TedStore } from '../src/store/index.ts'

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
  await mkdir(path.join(home, 'runs', 'run-1'), { recursive: true })
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
  expect(sandbox.scope.readable).toContain(path.join(home, 'runs', 'run-1', 'files'))
  expect(sandbox.scope.readable).not.toContain(path.join(home, 'attachments'))
})

test('a Pi Run’s text names clones of its own Task’s files, and another Task’s file keeps its hidden path', async () => {
  const home = path.join(scratch, 'ted-home')
  const attachments = path.join(home, 'attachments')
  await mkdir(attachments, { recursive: true })
  const own = `${'a'.repeat(64)}.txt`
  const chat = 'c'.repeat(64)
  const other = `${'b'.repeat(64)}.png`
  await writeFile(path.join(attachments, own), 'task file')
  await writeFile(path.join(attachments, chat), 'chat file')
  await writeFile(path.join(attachments, other), 'someone else’s')
  const file = (hash: string) => ({ hash, name: 'f', size: 1, mediaType: 'text/plain' })
  const store: PiFilesInput['store'] = {
    getTask: (id) => (id === 'task-1' ? ({ displayId: 'NB-1' } as StoredTask) : undefined),
    taskFiles: () => [file('a'.repeat(64))],
    taskRunList: () => [{ id: 'run-1' } as Run, { id: 'run-2' } as Run],
    runMessages: (id) =>
      id === 'run-2' ? [{ id: 'm', runId: id, text: '', at: '', attachments: [file(chat)] }] : [],
  }
  const text = [
    'Attached files:',
    `- brief.txt: ${path.join(attachments, own)}`,
    `- notes: ${path.join(attachments, chat)}`,
    `- secret.png: ${path.join(attachments, other)}`,
  ].join('\n')

  const sent = await piFilesText({ home, store, runId: 'run-1', taskId: 'task-1', text })

  const files = path.join(home, 'sandbox', 'NB-1', 'files')
  expect(sent).toBe(
    [
      'Attached files:',
      `- brief.txt: ${path.join(files, own)}`,
      `- notes: ${path.join(files, chat)}`,
      `- secret.png: ${path.join(attachments, other)}`,
    ].join('\n'),
  )
  expect((await readdir(files)).sort()).toEqual([own, chat].sort())
  expect(await readFile(path.join(files, own), 'utf8')).toBe('task file')
  expect(await readFile(path.join(files, chat), 'utf8')).toBe('chat file')
  expect(fromPiFiles(home, sent)).toBe(text)
  expect(await piFilesText({ home, store, runId: 'run-1', taskId: 'task-1', text })).toBe(sent)
})
