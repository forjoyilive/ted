import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { writeExportFile } from '../src/export-file.ts'

test('publishes a complete private file and refuses existing files, directories and symlinks', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ted-export-file-'))
  try {
    const destination = path.join(dir, 'export.json')
    await writeExportFile(destination, 'complete\n')
    expect(await readFile(destination, 'utf8')).toBe('complete\n')
    if (process.platform !== 'win32') expect((await stat(destination)).mode & 0o777).toBe(0o600)
    await mkdir(path.join(dir, 'folder'))
    await writeFile(path.join(dir, 'outside'), 'keep')
    await symlink(path.join(dir, 'outside'), path.join(dir, 'link'))
    await symlink(path.join(dir, 'absent'), path.join(dir, 'broken-link'))
    for (const name of ['export.json', 'folder', 'link', 'broken-link']) {
      await expect(writeExportFile(path.join(dir, name), 'replace')).rejects.toThrow(
        'already exists',
      )
    }
    expect(await readFile(destination, 'utf8')).toBe('complete\n')
    expect(await readFile(path.join(dir, 'outside'), 'utf8')).toBe('keep')
    await expect(writeExportFile(path.join(dir, 'missing', 'file'), 'data')).rejects.toThrow()
    expect((await readdir(dir)).filter((name) => name.startsWith('.ted-export-'))).toEqual([])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
