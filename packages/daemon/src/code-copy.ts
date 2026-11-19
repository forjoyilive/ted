import { lstat, mkdir, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import type { Banners } from './banners.ts'
import { clonePath, ensureClone } from './factories.ts'
import * as git from './git.ts'
import { type EndOptions, endProcessesInside, taskFolder } from './leftover-processes.ts'
import { redactSecrets } from './redact.ts'
import type { StoredFactory, TedStore } from './store/index.ts'
import { removeInside } from './tasks/remove-files.ts'
import type { FactoryRepoEntry } from './tasks/repos.ts'
import { copyFiles } from './tasks/worktree.ts'

export interface CopiedRepo {
  entry: FactoryRepoEntry
  clone: string
  worktree: string
}

export interface CopyOptions {
  folder: string
  factory: StoredFactory
  entries: readonly FactoryRepoEntry[]
  branch: 'base' | 'default'
  commit?: string
  clone: 'existing' | { ensure: Banners }
  fetch: 'all' | 'non-primary' | 'none'
  copyFiles: 'required' | 'ignore-errors'
}

export async function makeCopy(
  deps: { reposDir: string; store: Pick<TedStore, 'localFolder'> },
  options: CopyOptions,
): Promise<CopiedRepo[]> {
  const made: CopiedRepo[] = []
  try {
    for (const entry of options.entries) {
      const clone = await cloneOf(deps.reposDir, options, entry)
      if (options.fetch === 'all') await git.fetch(clone)
      if (options.fetch === 'non-primary' && !entry.primary) {
        await git.fetch(clone).catch(() => undefined)
      }
      const worktree = path.join(options.folder, entry.name)
      await git.addScratchWorktree(clone, worktree, await startOf(clone, options, entry))
      made.push({ entry, clone, worktree })
      const copying = copyFiles(deps.store.localFolder(entry.repo), worktree, entry.copy)
      await (options.copyFiles === 'required' ? copying : copying.catch(() => undefined))
    }
  } catch (error) {
    await removeWorktrees(made)
    throw error
  }
  return made
}

function cloneOf(
  reposDir: string,
  options: CopyOptions,
  entry: FactoryRepoEntry,
): Promise<string> | string {
  if (options.clone === 'existing') return clonePath(reposDir, entry)
  const factory = entry.primary
    ? options.factory
    : { ...options.factory, repo: entry.repo, cloneUrl: entry.cloneUrl }
  return ensureClone({ banners: options.clone.ensure, reposDir }, factory)
}

async function startOf(
  clone: string,
  options: CopyOptions,
  entry: FactoryRepoEntry,
): Promise<string> {
  const base =
    (options.branch === 'base' ? entry.baseBranch : undefined) ?? (await git.defaultBranch(clone))
  return entry.primary && options.commit !== undefined ? options.commit : `origin/${base}`
}

async function removeWorktrees(
  made: readonly { clone: string; worktree: string }[],
): Promise<void> {
  for (const { clone, worktree } of made) {
    await git.removeWorktree(clone, worktree).catch(() => undefined)
  }
}

export async function freshFolder(root: string, name: string): Promise<string> {
  await removeInside(root, name)
  const folder = path.join(root, name)
  await mkdir(folder, { recursive: true, mode: 0o700 })
  return folder
}

export interface RemoveOptions {
  sandbox?: { root: string; name: string }
  processes?: EndOptions
}

export async function removeCopy(
  made: readonly { clone: string; worktree: string }[],
  root: string,
  name: string,
  options: RemoveOptions = {},
): Promise<void> {
  const places = [{ root, name }, ...(options.sandbox ? [options.sandbox] : [])]
  await endLeftovers(places, options.processes).catch((error) =>
    console.error(
      redactSecrets(
        `couldn’t end the processes left in ${path.join(root, name)}: ${String(error)}`,
      ),
    ),
  )
  await removeWorktrees(made)
  await removeInside(root, name)
}

async function endLeftovers(
  places: readonly { root: string; name: string }[],
  processes: EndOptions | undefined,
): Promise<void> {
  const folders: string[] = []
  for (const place of places) {
    const folder = await taskFolder(place.root, place.name)
    if (folder !== undefined && (await lstat(folder).catch(() => undefined))) folders.push(folder)
  }
  if (folders.length > 0) await endProcessesInside(folders, processes)
}

export async function discardCopy(
  made: readonly { clone: string; worktree: string }[],
  folder: string,
  sandbox: { root: string; name: string },
): Promise<void> {
  const sandboxFolder = await taskFolder(sandbox.root, sandbox.name).catch(() => undefined)
  const stat = await lstat(folder).catch(() => undefined)
  const plain = stat?.isDirectory() === true && !stat.isSymbolicLink()
  const realFolder = plain
    ? await taskFolder(path.dirname(folder), path.basename(folder))
    : undefined
  const sandboxThere =
    sandboxFolder !== undefined && (await lstat(sandboxFolder).catch(() => undefined)) !== undefined
  if (!stat && !sandboxThere) return
  const folders = [realFolder, sandboxThere ? sandboxFolder : undefined].filter(
    (f): f is string => f !== undefined,
  )
  await endProcessesInside(folders).catch((error) =>
    console.error(redactSecrets(`couldn’t end the processes left in ${folder}: ${String(error)}`)),
  )
  await removeInside(sandbox.root, sandbox.name).catch((error) =>
    console.error(redactSecrets(`couldn’t remove ${sandbox.name}: ${String(error)}`)),
  )
  if (!stat) return
  const parent = await realpath(path.dirname(folder)).catch(() => undefined)
  const real = await realpath(folder).catch(() => undefined)
  if (!stat.isDirectory() || !parent || real !== path.join(parent, path.basename(folder))) {
    console.error(`not removing ${folder}: it isn’t a plain folder`)
    return
  }
  await removeWorktrees(made.filter(({ worktree }) => path.dirname(worktree) === folder))
  await rm(folder, { recursive: true, force: true }).catch((error) =>
    console.error(`couldn’t remove ${folder}:`, error),
  )
}
