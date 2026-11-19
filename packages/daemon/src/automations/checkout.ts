import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { tedPaths } from '@ted/protocol'
import type { AppTask } from '../apps/apps.ts'
import type { AppDeclaration } from '../apps/declared.ts'
import type { Banners } from '../banners.ts'
import { freshFolder, makeCopy, removeCopy } from '../code-copy.ts'
import * as git from '../git.ts'
import { redactSecrets } from '../redact.ts'
import type { Sandbox, SandboxScope } from '../sandbox.ts'
import type { StoredFactory, TedStore } from '../store/index.ts'
import { removeInside } from '../tasks/remove-files.ts'
import { type FactoryRepoEntry, factoryRepos } from '../tasks/repos.ts'
import { runScratchSetup } from '../tasks/scratch-setup.ts'
import type { Workflows } from '../workflow/workflows.ts'

export interface CheckoutRepo {
  name: string
  clone: string
  worktree: string
  env: Record<string, string>
  apps: AppDeclaration[]
}

export interface Checkout {
  runId: string
  automationId: string
  name: string
  factoryId: string
  cwd: string
  env: Record<string, string>
  commit?: string
  repos: CheckoutRepo[]
  sockets: readonly string[]
}

export interface Checkouts {
  make(input: {
    runId: string
    automationId: string
    name: string
    factory: StoredFactory
    signal?: AbortSignal
    commit?: string
  }): Promise<Checkout>
  restore(input: {
    runId: string
    automationId: string
    name: string
    factory: StoredFactory
  }): Promise<Checkout | undefined>
  get(runId: string): Checkout | undefined
  appTask(runId: string): Promise<AppTask>
  release(runId: string): Promise<void>
  sweep(keep: (runId: string) => boolean): Promise<void>
  forget(automationId: string): Promise<void>
}

export function createCheckouts(options: {
  home: string
  reposDir: string
  store: TedStore
  banners: Banners
  workflows: Workflows
  sandbox: Sandbox
  env: () => NodeJS.ProcessEnv
  stopApps(runId: string): Promise<void>
}): Checkouts {
  const root = tedPaths(options.home).automationRuns
  const sandboxRoot = path.join(options.home, 'sandbox')
  const live = new Map<string, Checkout>()
  const releasing = new Map<string, Promise<void>>()

  const folderOf = (runId: string) => path.join(root, runId)
  const tmpRootOf = (runId: string) => path.join(sandboxRoot, runId)
  const cacheOf = (automationId: string) =>
    path.join(sandboxRoot, `automation-${automationId}`, 'cache')

  async function entriesOf(factory: StoredFactory) {
    const { workflow } = await options.workflows.resolve(factory, { fetch: false })
    return { entries: factoryRepos(workflow, factory), workflow }
  }

  function repoOf(entry: FactoryRepoEntry, folder: string, clone: string): CheckoutRepo {
    return {
      name: entry.name,
      clone,
      worktree: path.join(folder, entry.name),
      env: entry.env,
      apps: entry.apps ?? [],
    }
  }

  function checkoutOf(
    input: { runId: string; automationId: string; name: string; factory: StoredFactory },
    repos: CheckoutRepo[],
    sockets: readonly string[],
    commit: string | undefined,
  ): Checkout {
    const only = repos.length === 1 ? repos[0] : undefined
    return {
      runId: input.runId,
      automationId: input.automationId,
      name: input.name,
      factoryId: input.factory.id,
      cwd: only?.worktree ?? folderOf(input.runId),
      env: repos[0]?.env ?? {},
      ...(commit !== undefined && { commit }),
      repos,
      sockets,
    }
  }

  function scopeOf(checkout: Checkout): Omit<SandboxScope, 'tmp'> {
    return {
      writable: checkout.repos.map((r) => r.worktree),
      readable: [...new Set(checkout.repos.map((r) => r.clone))],
      cache: cacheOf(checkout.automationId),
      sockets: checkout.sockets,
    }
  }

  async function setUp(
    checkout: Checkout,
    entries: FactoryRepoEntry[],
    signal?: AbortSignal,
  ): Promise<void> {
    await runScratchSetup({
      repos: entries.flatMap((entry) => {
        const repo = checkout.repos.find((r) => r.name === entry.name)
        return repo ? [{ ...repo, ...(entry.setup && { setup: entry.setup }) }] : []
      }),
      factoryId: checkout.factoryId,
      sandbox: options.sandbox,
      banners: options.banners,
      scope: scopeOf(checkout),
      tmpRoot: tmpRootOf(checkout.runId),
      logDir: tmpRootOf(checkout.runId),
      env: options.env(),
      lowPriority: options.store.settings().lowPriorityWork,
      ...(signal !== undefined && { signal }),
    })
  }

  async function discard(runId: string, repos: readonly { clone: string; worktree: string }[]) {
    await removeCopy(repos, root, runId).catch((error: unknown) =>
      console.error(
        redactSecrets(`couldn’t remove the checkout of Run ${runId}: ${String(error)}`),
      ),
    )
    await removeInside(sandboxRoot, runId).catch(() => undefined)
  }

  return {
    async make(input) {
      const folder = await freshFolder(root, input.runId)
      const { entries, workflow } = await entriesOf(input.factory)
      let repos: CheckoutRepo[] = []
      try {
        const made = await makeCopy(options, {
          folder,
          factory: input.factory,
          entries,
          branch: 'default',
          ...(input.commit !== undefined && { commit: input.commit }),
          clone: { ensure: options.banners },
          fetch: 'all',
          copyFiles: 'required',
        })
        repos = made.map((m) => repoOf(m.entry, folder, m.clone))
        const primary = made.find((m) => m.entry.primary)
        const commit = primary ? await git.headCommit(primary.worktree) : undefined
        const checkout = checkoutOf(input, repos, workflow.settings.sandbox_sockets ?? [], commit)
        await setUp(checkout, entries, input.signal)
        live.set(input.runId, checkout)
        return checkout
      } catch (error) {
        await discard(input.runId, repos)
        throw error
      }
    },
    async restore(input) {
      const folder = folderOf(input.runId)
      const present = new Set(await readdir(folder).catch(() => [] as string[]))
      if (present.size === 0) return undefined
      const { entries, workflow } = await entriesOf(input.factory)
      const repos = entries
        .filter((e) => present.has(e.name))
        .map((e) => {
          const clone = path.join(options.reposDir, ...e.repo.split('/'))
          return repoOf(e, folder, clone)
        })
      if (repos.length === 0) return undefined
      const checkout = checkoutOf(input, repos, workflow.settings.sandbox_sockets ?? [], undefined)
      live.set(input.runId, checkout)
      return checkout
    },
    get: (runId) => live.get(runId),
    async appTask(runId) {
      const checkout = live.get(runId)
      if (!checkout) throw new Error(`no checkout for Run ${runId}`)
      const scope = scopeOf(checkout)
      return {
        displayId: checkout.name,
        factoryId: checkout.factoryId,
        cache: scope.cache,
        sandbox: scope,
        repos: checkout.repos.map((r) => ({
          name: r.name,
          worktree: r.worktree,
          env: r.env,
          apps: r.apps,
        })),
      }
    },
    release(runId) {
      const before = releasing.get(runId)
      if (before) return before
      const done = (async () => {
        await options
          .stopApps(runId)
          .catch((error: unknown) =>
            console.error(
              redactSecrets(`couldn’t stop the Apps of Run ${runId}: ${String(error)}`),
            ),
          )
        const checkout = live.get(runId)
        await discard(runId, checkout?.repos ?? [])
        live.delete(runId)
      })().finally(() => releasing.delete(runId))
      releasing.set(runId, done)
      return done
    },
    async forget(automationId) {
      await removeInside(sandboxRoot, `automation-${automationId}`).catch((error: unknown) =>
        console.error(
          redactSecrets(
            `couldn’t remove the caches of Automation ${automationId}: ${String(error)}`,
          ),
        ),
      )
    },
    async sweep(keep) {
      const names = await readdir(root).catch(() => [] as string[])
      for (const runId of names) {
        if (!keep(runId)) await this.release(runId)
      }
      for (const runId of [...live.keys()]) {
        if (!keep(runId)) await this.release(runId)
      }
    },
  }
}
