import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Factory, FileDiff, Task, TaskChanges } from '@ted/protocol'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import {
  api,
  commitToOrigin,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  stubClaudePath,
  waitUntil,
} from './helpers.ts'

const execFileAsync = promisify(execFile)
let home: string
let cleanup: () => Promise<void>
let scratch: string
let origin: string
let daemon: RunningDaemon | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  scratch = await mkdtemp(path.join(tmpdir(), 'ted-changes-'))
  origin = await makeOriginRepo(scratch)
  await commitToOrigin(scratch, { '.gitignore': 'stub-*\n' })
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home, { waitForStart: true })
  await cleanup()
  await rm(scratch, { recursive: true, force: true })
})

async function startTed() {
  daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
  const client = api(daemon.port, { appKey: daemon.appToken })
  const ok = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    const res = await client.call(method, route, body)
    if (res.status >= 300) throw new Error(`${method} ${route}: ${JSON.stringify(res.body)}`)
    return res.body as T
  }
  return { ...client, ok }
}

type Client = Awaited<ReturnType<typeof startTed>>

async function startedTask(client: Client): Promise<{ task: Task; worktree: string }> {
  await client.ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const created = await client.call('POST', '/tasks', {
    title: JSON.stringify({ steps: [{ endTurn: true }] }),
    factory: 'NB',
  })
  const task = created.body as Task
  await client.call('POST', `/tasks/${task.id}/start`)
  const worktree = await waitUntil(async () => {
    const current = (await client.ok<Task[]>('GET', '/tasks')).find((t) => t.id === task.id)
    return current?.repos[0]?.worktree
  }, 'the worktree')
  return { task, worktree }
}

const gitIn = (cwd: string, ...args: string[]) =>
  execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  })

async function write(worktree: string, files: Record<string, string>) {
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(worktree, name)), { recursive: true })
    await writeFile(path.join(worktree, name), text)
  }
}

test('Changes lists each repo’s files against its base branch, uncommitted work included', async () => {
  const client = await startTed()
  const { task, worktree } = await startedTask(client)
  await write(worktree, { 'src/search/SearchPanel.tsx': 'one\ntwo\n' })
  await gitIn(worktree, 'add', '-A')
  await gitIn(worktree, 'commit', '-qm', 'panel')
  await write(worktree, { 'README.md': '# widgets\nmore\n', 'notes.txt': 'n\n' })

  const changes = await client.ok<TaskChanges>('GET', `/tasks/${task.id}/changes`)

  expect(changes).toMatchObject({
    taskId: task.id,
    files: 3,
    repos: [
      {
        name: 'widgets',
        baseBranch: 'main',
        added: 4,
        removed: 0,
        files: [
          { path: 'README.md', added: 1, removed: 0, uncommitted: true },
          { path: 'notes.txt', added: 1, removed: 0, uncommitted: true },
          { path: 'src/search/SearchPanel.tsx', added: 2, removed: 0, uncommitted: false },
        ],
      },
    ],
  })
})

test('the diffs route returns one file’s diff, or every file’s', async () => {
  const client = await startTed()
  const { task, worktree } = await startedTask(client)
  await write(worktree, { 'README.md': '# widgets\nmore\n', 'a b.txt': 'x\n' })

  const one = await client.ok<FileDiff[]>(
    'GET',
    `/tasks/${task.id}/changes/widgets/diffs?path=${encodeURIComponent('a b.txt')}`,
  )
  const all = await client.ok<FileDiff[]>('GET', `/tasks/${task.id}/changes/widgets/diffs`)

  expect(one).toEqual([
    expect.objectContaining({
      repo: 'widgets',
      path: 'a b.txt',
      added: 1,
      hunks: [{ header: '@@ -0,0 +1 @@', rows: [{ kind: 'added', text: 'x', new: 1 }] }],
    }),
  ])
  expect(one[0]?.head).toMatch(/^[0-9a-f]{40}$/)
  expect(all.map((d) => d.path)).toEqual(['README.md', 'a b.txt'])
  const missing = await client.call('GET', `/tasks/${task.id}/changes/nope/diffs`)
  expect(missing.status).toBe(404)
})

test('a Task with no worktree has no changes', async () => {
  const client = await startTed()
  await client.ok<Factory>('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const created = await client.call('POST', '/tasks', { title: 'Later', factory: 'NB' })
  const task = created.body as Task

  const changes = await client.ok<TaskChanges>('GET', `/tasks/${task.id}/changes`)

  expect(changes).toEqual({ taskId: task.id, files: 0, repos: [] })
})
