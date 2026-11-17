import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import type { Banners } from '../banners.ts'
import { ensureClone } from '../factories.ts'
import * as git from '../git.ts'
import type { StoredFactory, TedStore } from '../store/index.ts'
import type { PlanCheckout } from '../store/plans.ts'
import type { FactoryRepoEntry } from '../tasks/repos.ts'
import { copyFiles } from '../tasks/worktree.ts'

export interface CheckoutDeps {
  banners: Banners
  reposDir: string
  store: Pick<TedStore, 'localFolder'>
}

export async function checkOut(
  deps: CheckoutDeps,
  folder: string,
  factory: StoredFactory,
  entries: readonly FactoryRepoEntry[],
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
      const base = entry.baseBranch ?? (await git.defaultBranch(clone))
      const worktree = path.join(folder, entry.name)
      await git.addScratchWorktree(clone, worktree, `origin/${base}`)
      made.push({ clone, worktree })
      await copyFiles(deps.store.localFolder(entry.repo), worktree, entry.copy)
    }
  } catch (error) {
    await discard(made, folder)
    throw error
  }
  return made
}

export async function discard(checkout: readonly PlanCheckout[], folder: string): Promise<void> {
  for (const { clone, worktree } of checkout) {
    await git.removeWorktree(clone, worktree).catch(() => undefined)
  }
  await rm(folder, { recursive: true, force: true }).catch((error) =>
    console.error(`couldn’t remove ${folder}:`, error),
  )
}
