import { execFile } from 'node:child_process'
import fs, {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  type Factory,
  filePreviewLimit,
  type Task,
  type TaskFileContent,
  type TaskFiles,
} from '@ted/protocol'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { EditorLaunch } from '../src/editors.ts'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import {
  api,
  commitToOrigin,
  devRunToken,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  waitUntil,
} from './helpers.ts'

const run = promisify(execFile)
let home: string
let scratch: string
let cleanup: () => Promise<void>
let daemon: RunningDaemon | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-task-files-'))
})
afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  vi.unstubAllEnvs()
  await killRunHosts(home)
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

async function fixture() {
  const origin = await makeOriginRepo(scratch)
  await commitToOrigin(scratch, {
    '.ted/workflow.yaml': 'version: 1\norder: [intake, work, merge]\n',
    '.gitignore': 'ignored/\nstub-*\n',
    'src/hello.ts': 'export const hello = true\n',
    'deleted.ts': 'old\n',
    '.dotfile': 'dot\n',
  })
  const launches: EditorLaunch[] = []
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    editors: {
      launch: async (launch) => {
        launches.push(launch)
      },
    },
  })
  const client = api(daemon.port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  await ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const task = await ok<Task>('POST', '/tasks', {
    title: JSON.stringify({ steps: [{ endTurn: true }] }),
    factory: 'NB',
  })
  await ok('POST', `/tasks/${task.id}/start`)
  const worktree = await waitUntil(
    async () =>
      (await ok<Task[]>('GET', '/tasks')).find((t) => t.id === task.id)?.repos[0]?.worktree,
    'Task worktree',
  )
  const current = await waitUntil(async () => {
    const found = (await ok<Task[]>('GET', '/tasks')).find((t) => t.id === task.id)
    return found?.repos[0] && found.leadRunId ? found : undefined
  }, 'Task Lead')
  const repo = current.repos[0]?.name ?? ''
  const list = () => ok<TaskFiles>('GET', `/tasks/${task.id}/files`)
  const fileRoute = (file: string) =>
    `/tasks/${task.id}/repos/${repo}/file?path=${encodeURIComponent(file)}`
  const read = (file: string) => ok<TaskFileContent>('GET', fileRoute(file))
  return { client, ok, task, worktree, repo, list, read, fileRoute, launches }
}

test('lists current tracked and untracked files, hides ignored paths and links, and ignores hostile worktree config', async () => {
  const f = await fixture()
  await mkdir(path.join(f.worktree, 'ignored'))
  await writeFile(path.join(f.worktree, 'ignored/secret'), 'hidden')
  await writeFile(path.join(f.worktree, 'new file.ts'), 'new')
  await rm(path.join(f.worktree, 'deleted.ts'))
  await symlink(scratch, path.join(f.worktree, 'outside'))
  await symlink(path.join(f.worktree, 'src/hello.ts'), path.join(f.worktree, 'link.ts'))
  const sentinel = path.join(scratch, 'executed')
  const hook = path.join(scratch, 'fsmonitor.sh')
  await writeFile(hook, `#!/bin/sh\ntouch '${sentinel}'\n`, { mode: 0o755 })
  await run('git', ['config', 'core.fsmonitor', hook], { cwd: f.worktree })
  const listed = await f.list()
  expect(listed.taskId).toBe(f.task.id)
  expect(listed.repos[0]?.paths).toEqual(
    expect.arrayContaining(['src/hello.ts', '.dotfile', 'new file.ts']),
  )
  expect(listed.repos[0]?.paths).not.toEqual(expect.arrayContaining(['deleted.ts']))
  expect(
    listed.repos[0]?.paths.some(
      (p) =>
        p.startsWith('ignored/') || p.startsWith('outside/') || p === 'link.ts' || p === '.git',
    ),
  ).toBe(false)
  expect(listed.repos[0]?.partial).toBe(false)
  await expect(readFile(sentinel)).rejects.toThrow()
  expect(await f.read('new file.ts')).toEqual({ kind: 'text', text: 'new' })
})

test('bounds text reads, returns binary and large-file states, and never interprets HTML', async () => {
  const f = await fixture()
  const html = '<script>alert("file contents")</script>'
  await writeFile(path.join(f.worktree, 'page.html'), html)
  await writeFile(path.join(f.worktree, 'binary'), Buffer.from([0, 1, 2]))
  await writeFile(path.join(f.worktree, 'utf16'), Buffer.from([255, 254, 40]))
  await writeFile(path.join(f.worktree, 'big'), 'a'.repeat(filePreviewLimit + 1))
  await writeFile(path.join(f.worktree, 'lines'), '\n'.repeat(10_001))
  expect(await f.read('page.html')).toEqual({ kind: 'text', text: html })
  expect(await f.read('binary')).toMatchObject({ kind: 'binary' })
  expect(await f.read('utf16')).toMatchObject({ kind: 'binary' })
  expect(await f.read('big')).toMatchObject({ kind: 'too-large' })
  expect(await f.read('lines')).toMatchObject({ kind: 'too-large' })
  await rm(path.join(f.worktree, 'page.html'))
  expect(await f.read('page.html')).toMatchObject({ kind: 'unavailable' })
})

test('refuses traversal, git metadata, file and directory links, and special files', async () => {
  const f = await fixture()
  await writeFile(path.join(scratch, 'secret'), 'must not be returned')
  await symlink(path.join(scratch, 'secret'), path.join(f.worktree, 'link'))
  await symlink(scratch, path.join(f.worktree, 'linked-dir'))
  for (const name of [
    '../secret',
    '/etc/passwd',
    '.git',
    '.git/config',
    'src/../../secret',
    'src\\hello.ts',
    '',
  ]) {
    expect((await f.client.call('GET', f.fileRoute(name))).status, name).toBe(400)
  }
  for (const name of ['link', 'linked-dir/secret', 'src'])
    expect(await f.read(name)).toMatchObject({ kind: 'unavailable' })
  await run('mkfifo', [path.join(f.worktree, 'pipe')])
  expect(await f.read('pipe')).toMatchObject({ kind: 'unavailable' })
  await rm(path.join(f.worktree, 'src'), { recursive: true })
  await symlink(scratch, path.join(f.worktree, 'src'))
  expect(await f.read('src/secret')).toMatchObject({ kind: 'unavailable' })
})

test('requires app authorization and reports unavailable worktrees', async () => {
  const f = await fixture()
  if (!daemon) throw new Error('no daemon')
  const token = JSON.parse(await readFile(path.join(home, 'daemon.json'), 'utf8')).token as string
  for (const auth of [token, await devRunToken(home, daemon.port, daemon.appToken)]) {
    const denied = api(daemon.port, auth)
    expect((await denied.call('GET', `/tasks/${f.task.id}/files`)).status).toBe(403)
    expect((await denied.call('GET', f.fileRoute('src/hello.ts'))).status).toBe(403)
  }
  await f.ok('POST', `/tasks/${f.task.id}/stop`)
  await rm(f.worktree, { recursive: true, force: true })
  expect((await f.list()).repos[0]).toMatchObject({ paths: [], unavailable: expect.any(String) })
  expect((await f.client.call('GET', f.fileRoute('src/hello.ts'))).status).toBe(409)
})

test('large worktrees return a bounded, explicitly partial file list', async () => {
  const f = await fixture()
  const folder = path.join(f.worktree, 'many')
  await mkdir(folder)
  for (let start = 0; start < 20_010; start += 200) {
    await Promise.all(
      Array.from({ length: Math.min(200, 20_010 - start) }, (_, offset) =>
        writeFile(path.join(folder, `${start + offset}.txt`), ''),
      ),
    )
  }
  const listed = await f.list()
  expect(listed.repos[0]?.partial).toBe(true)
  expect(listed.repos[0]?.paths).toHaveLength(20_000)
}, 60_000)

test('a directory replaced after its lstat cannot redirect preview outside the worktree', async () => {
  const f = await fixture()
  const root = await realpath(f.worktree)
  const parent = path.join(root, 'nested')
  const parked = path.join(root, 'parked')
  const outside = path.join(await realpath(scratch), 'outside')
  await mkdir(parent)
  await mkdir(outside)
  await writeFile(path.join(parent, 'file.txt'), 'inside')
  await writeFile(path.join(outside, 'file.txt'), 'outside sentinel')
  const original = fs.lstat
  let swaps = 0
  const spy = vi
    .spyOn(fs, 'lstat')
    .mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      if (String(args[0]) !== parent) return original(...args)
      if (swaps > 0) {
        await unlink(parent)
        await rename(parked, parent)
      }
      const info = await original(...args)
      await rename(parent, parked)
      await symlink(outside, parent)
      swaps++
      return info
    })
  syncBuiltinESMExports()
  try {
    const result = await f.read('nested/file.txt')
    expect(swaps).toBeGreaterThan(0)
    expect(result).toMatchObject({ kind: 'unavailable' })
  } finally {
    spy.mockRestore()
    syncBuiltinESMExports()
  }
})

test('editor launch revalidates selected files and refuses symlinks and FIFOs', async () => {
  const f = await fixture()
  await f.ok('PATCH', '/settings', { editor: 'custom', editorCommand: '/usr/bin/true {path}' })
  const open = (file: string) =>
    f.client.call('POST', `/tasks/${f.task.id}/repos/${f.repo}/open-in-editor`, { file })
  expect((await open('src/hello.ts')).status).toBe(200)
  expect(f.launches).toHaveLength(1)
  await rm(path.join(f.worktree, 'src/hello.ts'))
  await symlink('../README.md', path.join(f.worktree, 'src/hello.ts'))
  expect((await open('src/hello.ts')).status).toBeGreaterThanOrEqual(400)
  await unlink(path.join(f.worktree, 'src/hello.ts'))
  await run('mkfifo', [path.join(f.worktree, 'src/hello.ts')])
  expect((await open('src/hello.ts')).status).toBeGreaterThanOrEqual(400)
  expect(f.launches).toHaveLength(1)
})

async function gitListing(output: string) {
  const realGit = (await run('which', ['git'])).stdout.trim()
  const bin = path.join(scratch, 'git-bin')
  const listing = path.join(scratch, 'git-listing')
  await mkdir(bin)
  await writeFile(listing, output)
  await writeFile(
    path.join(bin, 'git'),
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs')",
      "const cp = require('node:child_process')",
      `if (process.argv.includes('ls-files')) fs.createReadStream(${JSON.stringify(listing)}).pipe(process.stdout)`,
      `else process.exit(cp.spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), {stdio:'inherit'}).status ?? 1)`,
    ].join('\n'),
    { mode: 0o755 },
  )
  vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH ?? ''}`)
}

test('git output larger than 16 MB is collected without losing current files', async () => {
  const f = await fixture()
  const relative = `${Array.from({ length: 4 }, () => 'd'.repeat(180)).join('/')}/sample.ts`
  await mkdir(path.dirname(path.join(f.worktree, relative)), { recursive: true })
  await writeFile(path.join(f.worktree, relative), 'current')
  await gitListing(`${relative}\0`.repeat(24_000))
  const listed = await f.list()
  expect(listed.repos[0]).toEqual({ repo: f.repo, paths: [relative], partial: false })
})

test('deleted git candidates do not consume the current-file cap', async () => {
  const f = await fixture()
  await writeFile(path.join(f.worktree, 'z-current.ts'), 'current')
  const deleted = Array.from({ length: 20_000 }, (_, i) => `a-deleted/${i}.ts`)
  await gitListing(`${[...deleted, 'z-current.ts'].join('\0')}\0`)
  expect((await f.list()).repos[0]).toEqual({
    repo: f.repo,
    paths: ['z-current.ts'],
    partial: false,
  })
}, 60_000)

test('a linked Task folder cannot grant access to another folder under worktrees', async () => {
  const f = await fixture()
  const parent = path.dirname(f.worktree)
  const other = path.join(path.dirname(parent), 'OTHER')
  await mkdir(path.join(other, f.repo), { recursive: true })
  await writeFile(path.join(other, f.repo, 'secret.txt'), 'other Task sentinel')
  await rename(parent, `${parent}-parked`)
  await symlink(other, parent)
  expect((await f.client.call('GET', f.fileRoute('secret.txt'))).status).toBe(409)
  expect((await f.list()).repos[0]?.paths).toEqual([])
  expect(
    (
      await f.client.call('POST', `/tasks/${f.task.id}/repos/${f.repo}/open-in-editor`, {
        file: 'secret.txt',
      })
    ).status,
  ).toBeGreaterThanOrEqual(400)
})

test('swapping the Task folder after validation cannot redirect the actual open', async () => {
  const f = await fixture()
  const parent = await realpath(path.dirname(f.worktree))
  const parked = `${parent}-saved`
  const other = path.join(path.dirname(parent), 'OTHER')
  await mkdir(path.join(other, f.repo), { recursive: true })
  await writeFile(path.join(f.worktree, 'file.txt'), 'inside')
  await writeFile(path.join(other, f.repo, 'file.txt'), 'other Task sentinel')
  const original = fs.lstat
  let swaps = 0
  const spy = vi
    .spyOn(fs, 'lstat')
    .mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      if (String(args[0]) !== parent) return original(...args)
      if (swaps > 0) {
        await unlink(parent)
        await rename(parked, parent)
      }
      const info = await original(...args)
      await rename(parent, parked)
      await symlink(other, parent)
      swaps++
      return info
    })
  syncBuiltinESMExports()
  try {
    expect(await f.read('file.txt')).toMatchObject({ kind: 'unavailable' })
    expect(swaps).toBeGreaterThan(0)
  } finally {
    spy.mockRestore()
    syncBuiltinESMExports()
    if (swaps > 0) {
      await unlink(parent)
      await rename(parked, parent)
    }
  }
})
