import { constants } from 'node:fs'
import { type FileHandle, lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import { RequestError } from './errors.ts'

export async function checkedPath(
  worktree: string,
  relative: string,
): Promise<{ root: string; file: string }> {
  const parts = relative.split('/')
  if (
    !relative ||
    relative.length > 4096 ||
    relative.includes('\\') ||
    relative.includes('\0') ||
    path.isAbsolute(relative) ||
    parts.some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
  )
    throw new RequestError(400, 'file must be a relative path inside the worktree')
  const root = path.join(await realpath(path.dirname(worktree)), path.basename(worktree))
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
    throw new Error('Worktree is no longer available.')
  let current = root
  for (const [i, part] of parts.entries()) {
    current = path.join(current, part)
    const info = await lstat(current)
    if (info.isSymbolicLink() || (i < parts.length - 1 ? !info.isDirectory() : !info.isFile())) {
      throw new Error('Only regular files inside the worktree can be opened.')
    }
  }
  return { root, file: current }
}

// Node does not expose Darwin’s O_NOFOLLOW_ANY (xnu/bsd/sys/fcntl.h).
const darwinNoFollowAny = 0x20000000

async function openConfined(root: string, parts: string[]): Promise<FileHandle> {
  const flags = constants.O_RDONLY | constants.O_NONBLOCK
  if (process.platform === 'darwin') {
    return open(path.join(root, ...parts), flags | darwinNoFollowAny)
  }
  if (process.platform !== 'linux') throw new Error('Safe file opening is unavailable.')
  let directory = await open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  )
  try {
    for (const part of parts.slice(0, -1)) {
      const next = await open(
        `/proc/self/fd/${directory.fd}/${part}`,
        flags | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      )
      await directory.close()
      directory = next
    }
    return await open(`/proc/self/fd/${directory.fd}/${parts.at(-1)}`, flags | constants.O_NOFOLLOW)
  } finally {
    await directory.close()
  }
}

export async function openRegularFile(worktree: string, relative: string): Promise<FileHandle> {
  const { root } = await checkedPath(worktree, relative)
  const handle = await openConfined(root, relative.split('/'))
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Only regular files can be opened.')
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}
