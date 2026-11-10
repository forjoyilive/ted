import {
  fileListLimit,
  filePreviewLimit,
  type RepoFiles,
  type TaskFileContent,
} from '@ted/protocol'
import { RequestError } from '../errors.ts'
import { worktreeFiles } from '../git.ts'
import { checkedPath, openRegularFile } from '../regular-file.ts'

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
    const handle = await openRegularFile(worktree, relative)
    try {
      const opened = await handle.stat()
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
