import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import {
  fileListLimit,
  filePreviewLimit,
  type RepoFiles,
  type TaskFileContent,
} from '@ted/protocol'
import { RequestError } from '../errors.ts'
import { worktreeFiles } from '../git.ts'

async function checkedPath(worktree: string, relative: string): Promise<string> {
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
  const root = await realpath(worktree)
  const rootInfo = await lstat(worktree)
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
  return current
}

export async function listTaskFiles(worktree: string, repo: string): Promise<RepoFiles> {
  const listed = await worktreeFiles(worktree)
  const paths: string[] = []
  for (const file of listed.paths) {
    try {
      await checkedPath(worktree, file)
      paths.push(file)
    } catch {}
  }
  return { repo, paths: paths.slice(0, fileListLimit), partial: listed.partial }
}

export async function readTaskFile(worktree: string, relative: string): Promise<TaskFileContent> {
  try {
    const file = await checkedPath(worktree, relative)
    const before = await lstat(file)
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    try {
      const opened = await handle.stat()
      const verified = await checkedPath(worktree, relative)
      const after = await lstat(verified)
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.dev !== after.dev ||
        opened.ino !== after.ino
      ) {
        throw new Error('File changed while opening. Refresh and try again.')
      }
      if (opened.size > filePreviewLimit)
        return {
          kind: 'too-large',
          message: 'This file is larger than the 1 MB preview limit. Open it in your editor.',
        }
      const bytes = Buffer.alloc(filePreviewLimit + 1)
      let length = 0
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length)
        if (bytesRead === 0) break
        length += bytesRead
      }
      if (length > filePreviewLimit)
        return {
          kind: 'too-large',
          message: 'This file is larger than the 1 MB preview limit. Open it in your editor.',
        }
      const content = bytes.subarray(0, length)
      try {
        if (content.includes(0)) throw new Error('binary')
        const text = new TextDecoder('utf-8', { fatal: true }).decode(content)
        if (text.split('\n').length > 10_000)
          return {
            kind: 'too-large',
            message: 'This file has more than 10,000 lines. Open it in your editor.',
          }
        return { kind: 'text', text }
      } catch {
        return {
          kind: 'binary',
          message: 'This file can’t be shown as text. Open it in your editor.',
        }
      }
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (error instanceof RequestError) throw error
    return {
      kind: 'unavailable',
      message: 'This file is no longer available. Refresh the file list and try again.',
    }
  }
}
