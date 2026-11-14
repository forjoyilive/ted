import { mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import { tedPaths } from '@ted/protocol'
import type { AppTask } from '../apps/apps.ts'
import type { AppDeclaration } from '../apps/declared.ts'
import type { Banners } from '../banners.ts'
import { worktreeCommandEnv } from '../command-env.ts'
import { ensureClone } from '../factories.ts'
import * as git from '../git.ts'
import { redactSecrets } from '../redact.ts'
import type { Sandbox, SandboxScope } from '../sandbox.ts'
import type { StoredFactory, TedStore } from '../store/index.ts'
import { runTaskCommand } from '../tasks/command.ts'
import { removeInside } from '../tasks/remove-files.ts'
import { type FactoryRepoEntry, factoryRepos } from '../tasks/repos.ts'
import { copyFiles, outputTail } from '../tasks/worktree.ts'
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

export class SetupFailed extends Error {}

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

  async function setUp(checkout: Checkout, entries: FactoryRepoEntry[]): Promise<void> {
    for (const entry of entries) {
      const repo = checkout.repos.find((r) => r.name === entry.name)
      if (!repo || !entry.setup) continue
      const problem = await options.sandbox.problem()
      if (problem !== undefined) {
        options.banners.raise({
          problem: 'sandbox-unavailable',
          factoryId: checkout.factoryId,
          severity: 'stops-work',
          text: problem,
        })
        throw new SetupFailed(problem)
      }
      await mkdir(cacheOf(checkout.automationId), { recursive: true, mode: 0o700 })
      const log = path.join(tmpRootOf(checkout.runId), `setup-${entry.name}.log`)
      const result = await runTaskCommand({
        label: 'setup',
        command: entry.setup,
        cwd: repo.worktree,
        env: worktreeCommandEnv(repo.env, {}, options.env()),
        log,
        lowPriority: options.store.settings().lowPriorityWork,
        sandbox: {
          sandbox: options.sandbox,
          scope: scopeOf(checkout),
          tmpRoot: tmpRootOf(checkout.runId),
        },
      })
      if (result.outcome !== 'passed') {
        const tail = await outputTail(log).catch(() => '')
        const how =
          result.outcome === 'timed-out'
            ? 'timed out'
            : result.exitCode !== undefined
              ? `failed with exit code ${result.exitCode}`
              : 'failed'
        throw new SetupFailed(
          redactSecrets(
            `The setup command for ${entry.name} ${how}${tail.trim() === '' ? '' : `:\n${tail.trim()}`}`,
          ),
        )
      }
    }
  }

  async function discard(runId: string, repos: readonly { clone: string; worktree: string }[]) {
    for (const { clone, worktree } of repos) {
      await git.removeWorktree(clone, worktree).catch(() => undefined)
    }
    await removeInside(root, runId).catch((error: unknown) =>
      console.error(
        redactSecrets(`couldn’t remove the checkout of Run ${runId}: ${String(error)}`),
      ),
    )
    await removeInside(sandboxRoot, runId).catch(() => undefined)
  }

  return {
    async make(input) {
      const folder = folderOf(input.runId)
      await removeInside(root, input.runId)
      await mkdir(folder, { recursive: true, mode: 0o700 })
      const { entries, workflow } = await entriesOf(input.factory)
      const repos: CheckoutRepo[] = []
      let commit: string | undefined
      try {
        for (const entry of entries) {
          const clone = await ensureClone(
            { banners: options.banners, reposDir: options.reposDir },
            entry.primary
              ? input.factory
              : { ...input.factory, repo: entry.repo, cloneUrl: entry.cloneUrl },
          )
          await git.fetch(clone)
          const base = await git.defaultBranch(clone)
          const repo = repoOf(entry, folder, clone)
          await git.addScratchWorktree(clone, repo.worktree, `origin/${base}`)
          repos.push(repo)
          if (entry.primary) commit = await git.headCommit(repo.worktree)
          await copyFiles(options.store.localFolder(entry.repo), repo.worktree, entry.copy)
        }
        const checkout = checkoutOf(input, repos, workflow.settings.sandbox_sockets ?? [], commit)
        await setUp(checkout, entries)
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
