import { createHash } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test, vi } from 'vitest'
import { showAttachmentInFolder } from '../src/attachment-preview.ts'

test('revealing an attachment validates its reference and reuses a protected, named copy', async () => {
  const cache = await mkdtemp(path.join(tmpdir(), 'ted-attachment-preview-'))
  const bytes = Buffer.from('sample attachment')
  const hash = createHash('sha256').update(bytes).digest('hex')
  const attachment = { hash, name: 'guide.pdf' }
  const client = { readAttachment: vi.fn(async () => ({ data: bytes.toString('base64') })) }
  const reveal = vi.fn()
  try {
    await showAttachmentInFolder(client, attachment, cache, reveal)
    const target = path.join(await realpath(cache), 'attachment-previews', hash, attachment.name)
    expect(reveal).toHaveBeenCalledWith(target)
    expect(await readFile(target)).toEqual(bytes)
    expect((await lstat(target)).mode & 0o777).toBe(0o400)
    await showAttachmentInFolder(client, attachment, cache, reveal)
    expect(reveal).toHaveBeenCalledTimes(2)
    expect(client.readAttachment).toHaveBeenCalledWith(attachment)

    for (const name of ['../outside', 'folder/file', 'folder\\file', '..', '.', '', 'bad\nname']) {
      await expect(showAttachmentInFolder(client, { hash, name }, cache, reveal)).rejects.toThrow(
        'invalid',
      )
    }
    await expect(
      showAttachmentInFolder(client, { hash: 'invalid', name: 'guide.pdf' }, cache, reveal),
    ).rejects.toThrow('invalid')
    expect(client.readAttachment).toHaveBeenCalledTimes(2)
    client.readAttachment.mockRejectedValueOnce(new Error('Attachment no longer exists'))
    await expect(showAttachmentInFolder(client, attachment, cache, reveal)).rejects.toThrow(
      'no longer exists',
    )
    client.readAttachment.mockResolvedValueOnce({ data: Buffer.from('changed').toString('base64') })
    await expect(showAttachmentInFolder(client, attachment, cache, reveal)).rejects.toThrow(
      'do not match',
    )
    await chmod(target, 0o600)
    await writeFile(target, 'modified cached copy')
    await expect(showAttachmentInFolder(client, attachment, cache, reveal)).rejects.toThrow(
      'cached attachment has changed',
    )
    expect(reveal).toHaveBeenCalledTimes(2)
  } finally {
    await rm(cache, { recursive: true, force: true })
  }
})

test('revealing never follows cache folder or file symlinks or overwrites their targets', async () => {
  const cache = await mkdtemp(path.join(tmpdir(), 'ted-attachment-links-'))
  const outside = await mkdtemp(path.join(tmpdir(), 'ted-attachment-outside-'))
  const bytes = Buffer.from('original')
  const hash = createHash('sha256').update(bytes).digest('hex')
  const attachment = { hash, name: 'guide.pdf' }
  const client = { readAttachment: async () => ({ data: bytes.toString('base64') }) }
  const reveal = vi.fn()
  const root = path.join(cache, 'attachment-previews')
  try {
    await symlink(outside, root, 'dir')
    await expect(showAttachmentInFolder(client, attachment, cache, reveal)).rejects.toThrow(
      'plain folder',
    )
    await rm(root)
    await mkdir(root)
    await symlink(outside, path.join(root, hash), 'dir')
    await expect(showAttachmentInFolder(client, attachment, cache, reveal)).rejects.toThrow(
      'plain folder',
    )
    await rm(path.join(root, hash))
    await mkdir(path.join(root, hash))
    const target = path.join(outside, 'keep.pdf')
    await writeFile(target, bytes)
    await symlink(target, path.join(root, hash, attachment.name))
    await expect(showAttachmentInFolder(client, attachment, cache, reveal)).rejects.toThrow()
    expect(await readFile(target)).toEqual(bytes)
    expect(reveal).not.toHaveBeenCalled()
  } finally {
    await rm(cache, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
