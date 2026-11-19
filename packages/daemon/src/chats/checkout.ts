import path from 'node:path'
import type { Banners } from '../banners.ts'
import { discardCopy, freshFolder, makeCopy } from '../code-copy.ts'
import type { StoredFactory, TedStore } from '../store/index.ts'
import type { PlanCheckout } from '../store/plans.ts'
import type { FactoryRepoEntry } from '../tasks/repos.ts'

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
  await freshFolder(path.dirname(folder), path.basename(folder))
  try {
    const made = await makeCopy(deps, {
      folder,
      factory,
      entries,
      branch,
      clone: { ensure: deps.banners },
      fetch: 'all',
      copyFiles: 'required',
    })
    return made.map(({ clone, worktree }) => ({ clone, worktree }))
  } catch (error) {
    await discard([], folder, deps.home)
    throw error
  }
}

export function chatSandboxName(chatId: string): string {
  return `chat-${chatId}`
}

export function chatSandboxRoot(home: string): string {
  return path.join(home, 'sandbox')
}

export function discard(
  checkout: readonly PlanCheckout[],
  folder: string,
  home: string,
): Promise<void> {
  return discardCopy(checkout, folder, {
    root: chatSandboxRoot(home),
    name: chatSandboxName(path.basename(folder)),
  })
}
