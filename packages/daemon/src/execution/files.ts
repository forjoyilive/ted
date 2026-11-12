import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename } from 'node:fs/promises'
import path from 'node:path'

export async function privateDirectory(directory: string): Promise<string> {
  const resolved = path.resolve(directory)
  let current = path.parse(resolved).root
  for (const name of resolved.slice(current.length).split(path.sep)) {
    current = path.join(current, name)
    await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
    const info = await lstat(current)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('Execution storage requires plain folders without links')
  }
  const info = await lstat(resolved)
  if ((process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0)
    throw new Error('Execution storage must be owned by this account and private (mode 0700)')
  return realpath(resolved)
}

function file(directory: string, name: string): string {
  if (!/^[a-zA-Z0-9_.-]+$/.test(name) || name === '.' || name === '..')
    throw new Error('Invalid execution file name')
  return path.join(directory, name)
}
export async function readPrivate(directory: string, name: string): Promise<string> {
  const handle = await open(
    file(directory, name),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const info = await handle.stat()
    if (
      !info.isFile() ||
      info.size > 32 * 1024 ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error('Execution state must be a private regular file')
    return await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}
export async function writePrivate(directory: string, name: string, value: string): Promise<void> {
  await privateDirectory(directory)
  const target = file(directory, name)
  const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
  if (existing && (!existing.isFile() || existing.isSymbolicLink()))
    throw new Error('Execution state must be a regular file')
  const temporary = file(directory, `${name}.${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(value)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, target)
  const folder = await open(directory, constants.O_RDONLY)
  try {
    await folder.sync()
  } finally {
    await folder.close()
  }
}
