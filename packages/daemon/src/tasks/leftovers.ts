import { lstat, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import {
  type EndOptions,
  endProcessesInside,
  isInside,
  type ProcessPath,
  processPaths,
  taskFolder,
} from '../leftover-processes.ts'
import { removeInside } from './remove-files.ts'

const taskName = /^[A-Z][A-Z0-9]{1,4}-[1-9][0-9]*$/

export async function endTaskProcesses(
  home: string,
  displayId: string,
  options: EndOptions = {},
): Promise<number> {
  if (!taskName.test(displayId)) return 0
  const folders = (
    await Promise.all(
      ['worktrees', 'sandbox'].map((root) => taskFolder(path.join(home, root), displayId)),
    )
  ).filter((folder) => folder !== undefined)
  const ended = await endProcessesInside(folders, options).catch((error: unknown) => {
    console.error(`couldn’t end processes left in ${displayId}’s folders:`, error)
    return 0
  })
  if (ended > 0) console.log(`ended ${ended} processes left in ${displayId}’s folders`)
  return ended
}

export interface SweepResult {
  tasks: string[]
  processes: number
  folders: number
}

export async function sweepLeftovers(options: {
  home: string
  closed: (displayId: string) => boolean
  list?: () => Promise<ProcessPath[]>
  graceMs?: number
}): Promise<SweepResult> {
  const list = options.list ?? processPaths
  const roots = ['worktrees', 'sandbox'].map((name) => path.join(options.home, name))
  const names = new Set<string>()
  const realRoots: string[] = []
  for (const root of roots) {
    const entry = await lstat(root).catch(() => undefined)
    if (!entry?.isDirectory()) continue
    realRoots.push(await realpath(root))
    for (const name of await readdir(root).catch((): string[] => [])) {
      if (taskName.test(name)) names.add(name)
    }
  }
  const running = await list().catch((error: unknown) => {
    console.error('couldn’t list processes left in Task folders:', error)
    return []
  })
  for (const { path: file } of running) {
    for (const root of realRoots) {
      if (!isInside(file, root) || file === root) continue
      const name = path.relative(root, file).split(path.sep)[0]
      if (name && taskName.test(name)) names.add(name)
    }
  }
  const result: SweepResult = { tasks: [], processes: 0, folders: 0 }
  const snapshot = async () => running
  for (const name of [...names].sort()) {
    if (!options.closed(name)) continue
    result.tasks.push(name)
    result.processes += await endTaskProcesses(options.home, name, {
      list: once(snapshot, list),
      ...(options.graceMs !== undefined && { graceMs: options.graceMs }),
    })
    for (const root of roots) {
      if (!options.closed(name)) break
      const there = await lstat(path.join(root, name)).catch(() => undefined)
      if (!there) continue
      await removeInside(root, name).catch((error: unknown) => {
        console.error(`couldn’t remove ${name} from ${path.basename(root)}:`, error)
      })
      if (!(await lstat(path.join(root, name)).catch(() => undefined))) result.folders++
    }
  }
  return result
}

function once(
  first: () => Promise<ProcessPath[]>,
  then: () => Promise<ProcessPath[]>,
): () => Promise<ProcessPath[]> {
  let used = false
  return () => {
    if (used) return then()
    used = true
    return first()
  }
}
