import { lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { tedPaths } from '@ted/protocol'
import { piSessionFolder } from '../agents/pi.ts'
import { clonePath } from '../factories.ts'
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
      const git = await worktreeGit(cwd, (clone) => insideReal(paths.repos, clone))
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
  const live = task.repos.filter((repo) => !repo.removed)
  const clones = await Promise.all(live.map((repo) => real(clonePath(paths.repos, repo))))
  const taskClone = async (clone: string) => clones.includes(await real(clone))
  const worktrees = live.map((repo) => repo.worktree)
  if (
    ownsCwd &&
    inside(taskDir, cwd) &&
    !worktrees.some((dir) => inside(dir, cwd)) &&
    (await worktreeGit(cwd, taskClone))
  )
    worktrees.push(cwd)
  if (await isFolder(taskDir)) readable.add(taskDir)
  for (const worktree of worktrees) {
    writable.add(worktree)
    const git = await worktreeGit(worktree, taskClone)
    if (!git) continue
    readable.add(git.clone)
    writable.add(git.own)
    writable.add(path.join(git.common, 'objects'))
    const clone = await real(git.clone)
    const branch = live.find((_, i) => clones[i] === clone)?.branch
    const refs = branch === undefined ? undefined : refFolder(branch)
    if (refs !== undefined) {
      for (const dir of [refs, path.join('logs', refs)]) {
        writable.add(await plainFolders(git.common, dir))
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
}

// A Run can rewrite its worktree’s .git file, so the git folders it points to are granted only
// when they sit in a clone Ted made for this Run, are plain folders, and the clone's own
// gitdir record points back at this worktree.
async function worktreeGit(
  worktree: string,
  trusted: (clone: string) => Promise<boolean>,
): Promise<WorktreeGit | undefined> {
  const marker = path.join(worktree, '.git')
  if (!(await lstat(marker).catch(() => undefined))?.isFile()) return undefined
  const pointer = /^gitdir: (.+)$/m.exec(await readFile(marker, 'utf8'))?.[1]?.trim()
  if (pointer === undefined) return undefined
  const own = path.resolve(worktree, pointer)
  const common = path.dirname(path.dirname(own))
  if (path.basename(path.dirname(own)) !== 'worktrees' || path.basename(common) !== '.git')
    return undefined
  if (!(await trusted(path.dirname(common)))) return undefined
  for (const dir of [common, path.dirname(own), own, path.join(common, 'objects')]) {
    if ((await real(dir)) !== path.join(await real(path.dirname(dir)), path.basename(dir)))
      return undefined
    if (!(await isFolder(dir))) return undefined
  }
  const back = (await readFile(path.join(own, 'gitdir'), 'utf8').catch(() => '')).trim()
  if (back === '' || (await real(path.resolve(own, back))) !== (await real(marker)))
    return undefined
  return { own, common, clone: path.dirname(common) }
}

function refFolder(branch: string): string | undefined {
  const folder = path.posix.dirname(branch)
  return folder === '.' || folder.split('/').some((part) => part === '..' || part === '')
    ? undefined
    : path.join('refs', 'heads', ...folder.split('/'))
}

async function plainFolders(root: string, relative: string): Promise<string> {
  let current = root
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part)
    const found = await lstat(current).catch(() => undefined)
    if (found === undefined) await makeFolder(current)
    else if (!found.isDirectory() || found.isSymbolicLink())
      throw new Error(`${current} isn’t a plain folder, so Ted won’t let Pi write it`)
  }
  return current
}

async function real(file: string): Promise<string> {
  return realpath(file).catch(() => path.resolve(file))
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
  const [outer, inner] = await Promise.all([real(folder), real(file)])
  return inside(outer, inner)
}

function inside(folder: string, file: string): boolean {
  const relative = path.relative(folder, file)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}
