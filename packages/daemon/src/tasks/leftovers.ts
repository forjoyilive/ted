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
  hold: (displayId: string, work: () => Promise<void>) => Promise<void>
  list?: () => Promise<ProcessPath[]>
  graceMs?: number
  signal?: AbortSignal
}): Promise<SweepResult> {
  const { signal } = options
  const list = options.list ?? processPaths
  const roots: { real: string }[] = []
  const names = new Set<string>()
  for (const root of ['worktrees', 'sandbox'].map((name) => path.join(options.home, name))) {
    const entry = await lstat(root).catch(() => undefined)
    if (!entry?.isDirectory()) continue
    roots.push({ real: await realpath(root) })
    for (const name of await readdir(root).catch((): string[] => [])) {
      if (taskName.test(name)) names.add(name)
    }
  }
  const result: SweepResult = { tasks: [], processes: 0, folders: 0 }
  const running = await (options.list ? options.list() : processPaths(signal)).catch(
    (error: unknown) => {
      if (!signal?.aborted) console.error('couldn’t list processes left in Task folders:', error)
      return []
    },
  )
  if (signal?.aborted) return result
  const withProcesses = new Set<string>()
  for (const { path: file } of running) {
    for (const { real } of roots) {
      if (!isInside(file, real) || file === real) continue
      const name = path.relative(real, file).split(path.sep)[0]
      if (name && taskName.test(name)) {
        names.add(name)
        withProcesses.add(name)
      }
    }
  }
  for (const name of [...names].sort()) {
    if (signal?.aborted) break
    await options.hold(name, async () => {
      result.tasks.push(name)
      if (withProcesses.has(name))
        result.processes += await endTaskProcesses(options.home, name, {
          list,
          ...(options.graceMs !== undefined && { graceMs: options.graceMs }),
        })
      for (const { real } of roots) {
        const target = path.join(real, name)
        if (!(await lstat(target).catch(() => undefined))) continue
        await removeInside(real, name).catch((error: unknown) => {
          console.error(`couldn’t remove ${name} from ${path.basename(real)}:`, error)
        })
        if (!(await lstat(target).catch(() => undefined))) result.folders++
      }
    })
  }
  return result
}
