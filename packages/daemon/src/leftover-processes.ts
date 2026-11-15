import { execFile } from 'node:child_process'
import { lstat, readdir, readlink, realpath } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

export interface ProcessPath {
  pid: number
  path: string
}

export interface EndOptions {
  graceMs?: number
  list?: () => Promise<ProcessPath[]>
}

export const endGraceMs = 5_000

const safeName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export async function taskFolder(root: string, name: string): Promise<string | undefined> {
  if (!safeName.test(name) || name.includes('..')) return undefined
  const entry = await lstat(root).catch(() => undefined)
  if (!entry?.isDirectory()) return undefined
  const folder = path.join(await realpath(root), name)
  const found = await lstat(folder).catch(() => undefined)
  if (found && (!found.isDirectory() || found.isSymbolicLink())) return undefined
  return folder
}

export function isInside(file: string, folder: string): boolean {
  return file === folder || file.startsWith(folder + path.sep)
}

export async function processesInside(
  folders: readonly string[],
  list: () => Promise<ProcessPath[]> = processPaths,
): Promise<number[]> {
  if (folders.length === 0) return []
  const spared = new Set([process.pid, process.ppid, 0, 1])
  const found = new Set<number>()
  for (const { pid, path: file } of await list()) {
    if (spared.has(pid)) continue
    if (folders.some((folder) => isInside(file, folder))) found.add(pid)
  }
  return [...found]
}

export async function endProcessesInside(
  folders: readonly string[],
  options: EndOptions = {},
): Promise<number> {
  const list = options.list ?? processPaths
  const graceMs = options.graceMs ?? endGraceMs
  const first = await processesInside(folders, list)
  if (first.length === 0) return 0
  for (const pid of first) signal(pid, 'SIGTERM')
  const until = Date.now() + graceMs
  let left = first.filter(alive)
  while (left.length > 0 && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    left = left.filter(alive)
  }
  const ended = new Set(first)
  for (let round = 0; round < 3; round++) {
    const still = await processesInside(folders, list)
    if (still.length === 0) break
    for (const pid of still) {
      ended.add(pid)
      signal(pid, 'SIGKILL')
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return ended.size
}

function signal(pid: number, name: NodeJS.Signals): void {
  try {
    process.kill(pid, name)
  } catch {}
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function processPaths(signal?: AbortSignal): Promise<ProcessPath[]> {
  return process.platform === 'linux' ? pathsOnLinux(signal) : openPaths('cwd,txt', signal)
}

export function lsofArgs(uid: number | undefined, descriptors?: string): string[] {
  return [
    '-b',
    '-n',
    '-P',
    '-w',
    '-a',
    ...(uid !== undefined ? ['-u', String(uid)] : []),
    ...(descriptors !== undefined ? ['-d', descriptors] : []),
    '-Fpn',
  ]
}

// -b keeps lsof from calling stat on files and mount points: stat on an attached drive
// makes macOS ask whether TED may use removable volumes. lsof exits 1 when it finds
// nothing to list; any other failure is an error.
export async function openPaths(
  descriptors?: string,
  signal?: AbortSignal,
): Promise<ProcessPath[]> {
  const { stdout } = await promisify(execFile)(
    '/usr/sbin/lsof',
    lsofArgs(process.getuid?.(), descriptors),
    { maxBuffer: 64 * 1024 * 1024, ...(signal && { signal }) },
  ).catch((error: { code?: unknown; stdout?: string }) => {
    if (error.code !== 1) throw error
    return { stdout: error.stdout ?? '' }
  })
  return parseLsof(stdout)
}

export function parseLsof(output: string): ProcessPath[] {
  const found: ProcessPath[] = []
  let pid: number | undefined
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      const n = Number(line.slice(1))
      pid = Number.isInteger(n) && n > 0 ? n : undefined
    } else if (line.startsWith('n') && pid !== undefined && line.startsWith('n/')) {
      found.push({ pid, path: line.slice(1) })
    }
  }
  return found
}

async function pathsOnLinux(signal?: AbortSignal): Promise<ProcessPath[]> {
  const pids = (await readdir('/proc').catch(() => [])).filter((name) => /^\d+$/.test(name))
  const found: ProcessPath[] = []
  for (const name of pids) {
    signal?.throwIfAborted()
    for (const link of ['cwd', 'exe']) {
      const target = await readlink(`/proc/${name}/${link}`).catch(() => undefined)
      if (target?.startsWith('/'))
        found.push({ pid: Number(name), path: target.replace(/ \(deleted\)$/, '') })
    }
  }
  return found
}
