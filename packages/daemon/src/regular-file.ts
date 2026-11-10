import { constants } from 'node:fs'
import { type FileHandle, lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { RequestError } from './errors.ts'

export interface WorktreeFileScope {
  root: string
  directory: string
}

function parts(relative: string): string[] {
  const pieces = relative.split('/')
  if (
    !relative ||
    relative.length > 4096 ||
    relative.includes('\\') ||
    relative.includes('\0') ||
    path.isAbsolute(relative) ||
    pieces.some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
  ) {
    throw new RequestError(400, 'file must be a relative path inside the worktree')
  }
  return pieces
}

async function check(scope: WorktreeFileScope, relative?: string): Promise<void> {
  const names = [...parts(scope.directory), ...(relative === undefined ? [] : parts(relative))]
  let current = scope.root
  const root = await lstat(current)
  if (root.isSymbolicLink() || !root.isDirectory())
    throw new Error('Worktrees folder is unavailable.')
  for (const [i, name] of names.entries()) {
    current = path.join(current, name)
    const info = await lstat(current)
    const directory = relative === undefined || i < names.length - 1
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) {
      throw new Error('Only plain worktree folders and regular files can be opened.')
    }
  }
}

export async function worktreeFileScope(
  root: string,
  worktree: string,
): Promise<WorktreeFileScope> {
  const directory = path.relative(path.resolve(root), path.resolve(worktree))
  parts(directory)
  const scope = { root: await realpath(root), directory }
  await check(scope)
  return scope
}

// Node does not expose Darwin’s O_NOFOLLOW_ANY (xnu/bsd/sys/fcntl.h).
const darwinNoFollowAny = 0x20000000

async function openConfined(root: string, names: string[]): Promise<FileHandle> {
  const flags = constants.O_RDONLY | constants.O_NONBLOCK
  if (process.platform === 'darwin')
    return open(path.join(root, ...names), flags | darwinNoFollowAny)
  if (process.platform !== 'linux') throw new Error('Safe file opening is unavailable.')
  let directory = await open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  )
  try {
    for (const name of names.slice(0, -1)) {
      const next = await open(
        `/proc/self/fd/${directory.fd}/${name}`,
        flags | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      )
      await directory.close()
      directory = next
    }
    return await open(`/proc/self/fd/${directory.fd}/${names.at(-1)}`, flags | constants.O_NOFOLLOW)
  } finally {
    await directory.close()
  }
}

export async function openRegularFile(
  scope: WorktreeFileScope,
  relative: string,
): Promise<FileHandle> {
  await check(scope, relative)
  const handle = await openConfined(scope.root, [...parts(scope.directory), ...parts(relative)])
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Only regular files can be opened.')
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}
