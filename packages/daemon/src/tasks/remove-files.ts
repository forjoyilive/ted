import { lstat, realpath, rm } from 'node:fs/promises'
import path from 'node:path'

const safeName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export async function removeInside(root: string, name: string): Promise<void> {
  if (!safeName.test(name) || name.includes('..')) return
  const realRoot = await realpath(root).catch(() => undefined)
  if (realRoot === undefined) return
  const target = path.join(realRoot, name)
  const entry = await lstat(target).catch(() => undefined)
  if (!entry) return
  await rm(target, { recursive: entry.isDirectory(), force: true })
}
