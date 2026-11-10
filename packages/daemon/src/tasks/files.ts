import {
  fileListLimit,
  filePreviewLimit,
  type RepoFiles,
  type TaskFileContent,
} from '@ted/protocol'
import { RequestError } from '../errors.ts'
import { worktreeFiles } from '../git.ts'
import { openRegularFile, type WorktreeFileScope } from '../regular-file.ts'

export async function listTaskFiles(
  worktree: string,
  scope: WorktreeFileScope,
  repo: string,
): Promise<RepoFiles> {
  const paths = new Set<string>()
  let partial = false
  for await (const file of worktreeFiles(worktree)) {
    if (paths.has(file)) continue
    try {
      const handle = await openRegularFile(scope, file)
      await handle.close()
    } catch {
      continue
    }
    if (paths.size === fileListLimit) {
      partial = true
      break
    }
    paths.add(file)
  }
  return { repo, paths: [...paths].sort(), partial }
}

export async function readTaskFile(
  scope: WorktreeFileScope,
  relative: string,
): Promise<TaskFileContent> {
  try {
    const handle = await openRegularFile(scope, relative)
    try {
      const opened = await handle.stat()
      if (opened.size > filePreviewLimit)
        return {
          kind: 'too-large',
          message:
            'This file is larger than the 1 MB preview limit. Open the repository in your editor to inspect it.',
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
          message:
            'This file is larger than the 1 MB preview limit. Open the repository in your editor to inspect it.',
        }
      const content = bytes.subarray(0, length)
      try {
        if (content.includes(0)) throw new Error('binary')
        const text = new TextDecoder('utf-8', { fatal: true }).decode(content)
        if (text.split('\n').length > 10_000)
          return {
            kind: 'too-large',
            message:
              'This file has more than 10,000 lines. Open the repository in your editor to inspect it.',
          }
        return { kind: 'text', text }
      } catch {
        return {
          kind: 'binary',
          message:
            'This file can’t be shown as text. Open the repository in your editor to inspect it.',
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
