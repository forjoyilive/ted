import { lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { tedPaths } from '@ted/protocol'
import { piSessionFolder } from '../agents/pi.ts'
import type { SandboxScope } from '../sandbox.ts'
import type { TedStore } from '../store/index.ts'
import { runFiles } from './host-files.ts'

export interface PiScopeInput {
  home: string
  store: TedStore
  runId: string
  taskId: string | undefined
  cwd: string
}

export async function piSandboxScope(input: PiScopeInput): Promise<SandboxScope> {
  const { home, store, runId, taskId, cwd } = input
  const paths = tedPaths(home)
  const runDir = path.join(paths.runs, runId)
  const sessions = path.join(runDir, piSessionFolder)
  await makeFolder(sessions)
  await makeFolder(paths.public)
  const writable = new Set<string>([sessions])
  const readable = new Set<string>()
  for (const dir of [path.join(home, 'bin'), paths.public]) {
    if (await isFolder(dir)) readable.add(dir)
  }
  const task = taskId === undefined ? undefined : store.getTask(taskId)
  const ownsCwd = !inside(runDir, cwd) && (await insideReal(home, cwd))

  if (task === undefined) {
    if (ownsCwd) {
      const git = await worktreeGit(cwd)
      if (git) {
        writable.add(cwd)
        readable.add(git.clone)
      } else readable.add(cwd)
    }
    return {
      writable: [...writable],
      readable: [...readable],
      tmp: runFiles(runDir).tmp,
      cache: path.join(runDir, 'cache'),
    }
  }

  const taskDir = path.join(paths.worktrees, task.displayId)
  const worktrees = task.repos.filter((repo) => !repo.removed).map((repo) => repo.worktree)
  if (
    ownsCwd &&
    inside(taskDir, cwd) &&
    !worktrees.some((dir) => inside(dir, cwd)) &&
    (await worktreeGit(cwd))
  )
    worktrees.push(cwd)
  if (await isFolder(taskDir)) readable.add(taskDir)
  for (const worktree of worktrees) {
    writable.add(worktree)
    const git = await worktreeGit(worktree)
    if (!git) continue
    readable.add(git.clone)
    writable.add(git.own)
    writable.add(path.join(git.common, 'objects'))
    if (git.refFolder !== undefined) {
      for (const dir of [git.refFolder, path.join('logs', git.refFolder)]) {
        const full = path.join(git.common, dir)
        await mkdir(full, { recursive: true, mode: 0o755 })
        writable.add(full)
      }
    }
  }
  return {
    writable: [...writable],
    readable: [...readable],
    tmp: runFiles(runDir).tmp,
    cache: path.join(paths.sandbox, task.displayId, 'cache'),
  }
}

interface WorktreeGit {
  own: string
  common: string
  clone: string
  refFolder: string | undefined
}

async function worktreeGit(worktree: string): Promise<WorktreeGit | undefined> {
  const marker = path.join(worktree, '.git')
  if (!(await lstat(marker).catch(() => undefined))?.isFile()) return undefined
  const pointer = /^gitdir: (.+)$/m.exec(await readFile(marker, 'utf8'))?.[1]?.trim()
  if (pointer === undefined) return undefined
  const own = path.resolve(worktree, pointer)
  const common = path.dirname(path.dirname(own))
  if (path.basename(path.dirname(own)) !== 'worktrees' || path.basename(common) !== '.git')
    return undefined
  const head = await readFile(path.join(own, 'HEAD'), 'utf8').catch(() => '')
  const branch = /^ref: refs\/heads\/(.+)$/m.exec(head)?.[1]?.trim()
  const folder = branch === undefined ? '.' : path.posix.dirname(branch)
  return {
    own,
    common,
    clone: path.dirname(common),
    refFolder:
      folder === '.' || folder.split('/').includes('..')
        ? undefined
        : path.join('refs', 'heads', ...folder.split('/')),
  }
}

async function makeFolder(dir: string): Promise<void> {
  await mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
  })
}

async function isFolder(dir: string): Promise<boolean> {
  return (await lstat(dir).catch(() => undefined))?.isDirectory() === true
}

async function insideReal(folder: string, file: string): Promise<boolean> {
  const [outer, inner] = await Promise.all([
    realpath(folder).catch(() => path.resolve(folder)),
    realpath(file).catch(() => path.resolve(file)),
  ])
  return inside(outer, inner)
}

function inside(folder: string, file: string): boolean {
  const relative = path.relative(folder, file)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}
