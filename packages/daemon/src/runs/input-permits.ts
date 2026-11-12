import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs'
import path from 'node:path'

function permitFile(runDir: string, id: string, state: 'pending' | 'consumed'): string {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('invalid input permit')
  const directory = path.join(runDir, 'input-permits')
  try {
    if (
      !lstatSync(directory).isDirectory() ||
      realpathSync(directory) !== path.join(realpathSync(runDir), 'input-permits')
    )
      throw new Error('input permits must use a plain Run directory')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return path.join(directory, `${id}.${state}`)
}

export function grantInput(runDir: string, id: string): void {
  const file = permitFile(runDir, id, 'pending')
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const fd = openSync(permitFile(runDir, id, 'pending'), 'wx', 0o600)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

export function revokeInput(runDir: string, id: string): void {
  rmSync(permitFile(runDir, id, 'pending'), { force: true })
}

export function inputPending(runDir: string, id: string): boolean {
  return existsSync(permitFile(runDir, id, 'pending'))
}

export function inputConsumed(runDir: string, id: string): boolean {
  return existsSync(permitFile(runDir, id, 'consumed'))
}

export function consumeInput(runDir: string, id: string): boolean {
  try {
    renameSync(permitFile(runDir, id, 'pending'), permitFile(runDir, id, 'consumed'))
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
