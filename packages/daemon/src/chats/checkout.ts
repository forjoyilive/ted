import { lstat, mkdir, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import type { Banners } from '../banners.ts'
import { ensureClone } from '../factories.ts'
import * as git from '../git.ts'
import { endProcessesInside, taskFolder } from '../leftover-processes.ts'
import { redactSecrets } from '../redact.ts'
import type { StoredFactory, TedStore } from '../store/index.ts'
import type { PlanCheckout } from '../store/plans.ts'
import { removeInside } from '../tasks/remove-files.ts'
import type { FactoryRepoEntry } from '../tasks/repos.ts'
import { copyFiles } from '../tasks/worktree.ts'

export interface CheckoutDeps {
  home: string
  banners: Banners
  reposDir: string
  store: Pick<TedStore, 'localFolder'>
}

export async function checkOut(
  deps: CheckoutDeps,
  folder: string,
  factory: StoredFactory,
  entries: readonly FactoryRepoEntry[],
  branch: 'base' | 'default' = 'base',
): Promise<PlanCheckout[]> {
  await rm(folder, { recursive: true, force: true })
  await mkdir(folder, { recursive: true, mode: 0o700 })
  const made: PlanCheckout[] = []
  try {
    for (const entry of entries) {
      const clone = await ensureClone(
        { banners: deps.banners, reposDir: deps.reposDir },
        entry.primary ? factory : { ...factory, repo: entry.repo, cloneUrl: entry.cloneUrl },
      )
      await git.fetch(clone)
      const base =
        (branch === 'base' ? entry.baseBranch : undefined) ?? (await git.defaultBranch(clone))
      const worktree = path.join(folder, entry.name)
      await git.addScratchWorktree(clone, worktree, `origin/${base}`)
      made.push({ clone, worktree })
      await copyFiles(deps.store.localFolder(entry.repo), worktree, entry.copy)
    }
  } catch (error) {
    await discard(made, folder, deps.home)
    throw error
  }
  return made
}

export function chatSandboxName(chatId: string): string {
  return `chat-${chatId}`
}

export function chatSandboxRoot(home: string): string {
  return path.join(home, 'sandbox')
}

export async function discard(
  checkout: readonly PlanCheckout[],
  folder: string,
  home: string,
): Promise<void> {
  const sandboxName = chatSandboxName(path.basename(folder))
  const sandboxRoot = chatSandboxRoot(home)
  const sandboxFolder = await taskFolder(sandboxRoot, sandboxName).catch(() => undefined)
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
  await removeInside(sandboxRoot, sandboxName).catch((error) =>
    console.error(redactSecrets(`couldn’t remove ${sandboxName}: ${String(error)}`)),
  )
  if (!stat) return
  const parent = await realpath(path.dirname(folder)).catch(() => undefined)
  const real = await realpath(folder).catch(() => undefined)
  if (!stat.isDirectory() || !parent || real !== path.join(parent, path.basename(folder))) {
    console.error(`not removing ${folder}: it isn’t a plain folder`)
    return
  }
  for (const { clone, worktree } of checkout) {
    if (path.dirname(worktree) !== folder) continue
    await git.removeWorktree(clone, worktree).catch(() => undefined)
  }
  await rm(folder, { recursive: true, force: true }).catch((error) =>
    console.error(`couldn’t remove ${folder}:`, error),
  )
}
