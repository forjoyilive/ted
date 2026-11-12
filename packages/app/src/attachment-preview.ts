import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { type FileHandle, lstat, mkdir, open, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { Attachment, DaemonClient } from '@ted/protocol'

export async function showAttachmentInFolder(
  client: Pick<DaemonClient, 'readAttachment'>,
  attachment: Pick<Attachment, 'hash' | 'name'>,
  cache: string,
  reveal: (file: string) => void,
): Promise<void> {
  if (
    !attachment ||
    typeof attachment.hash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(attachment.hash) ||
    typeof attachment.name !== 'string' ||
    !attachment.name.trim() ||
    attachment.name === '.' ||
    attachment.name === '..' ||
    /[/\\\p{Cc}]/u.test(attachment.name) ||
    Buffer.byteLength(attachment.name) > 255
  ) {
    throw new Error('That attachment has an invalid filename or reference')
  }
  const { hash, name } = attachment
  const { data } = await client.readAttachment({ hash, name })
  const bytes = Buffer.from(data, 'base64')
  if (createHash('sha256').update(bytes).digest('hex') !== hash) {
    throw new Error('The attachment contents do not match its reference')
  }
  const root = await realpath(cache)
  const directory = path.join(root, 'attachment-previews')
  await plainDirectory(directory)
  const group = path.join(directory, hash)
  await plainDirectory(group)
  const file = path.join(group, name)
  let handle: FileHandle | undefined
  try {
    handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o400)
    await handle.writeFile(bytes)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
    const existing = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
    try {
      if (!(await existing.stat()).isFile() || !(await existing.readFile()).equals(bytes)) {
        throw new Error('The cached attachment has changed; remove it before trying again')
      }
    } finally {
      await existing.close()
    }
  } finally {
    await handle?.close()
  }
  reveal(file)
}

async function plainDirectory(directory: string): Promise<void> {
  await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
  })
  if (!(await lstat(directory)).isDirectory() || (await realpath(directory)) !== directory) {
    throw new Error('The attachment preview folder must be a plain folder')
  }
}
