import type {
  FactoryRemoval,
  RemoveFactoryRequest,
  RepoRemoval,
  Task,
  TaskRef,
} from '@ted/protocol'
import type { Automations } from './automations/automations.ts'
import type { Banners } from './banners.ts'
import type { CheckTries } from './check-tries.ts'
import { RequestError } from './errors.ts'
import type { Factories } from './factory-setup.ts'
import type { Plans } from './plans/plans.ts'
import type { Storage } from './storage.ts'
import type { StoredFactory, TedStore } from './store/index.ts'
import type { Tasks } from './tasks/tasks.ts'

export interface FactoryRemovals {
  summary(factoryId: string): FactoryRemoval
  remove(factoryId: string, request: RemoveFactoryRequest): Promise<void>
  repo(factoryId: string, repoName: string): RepoRemoval
}

export function createFactoryRemovals(options: {
  store: TedStore
  banners: Banners
  tasks: Pick<Tasks, 'removeFactoryTasks'>
  automations: Pick<Automations, 'removeFactory'>
  plans: Pick<Plans, 'removeFactory'>
  factories: Pick<Factories, 'forget'>
  checkTries: Pick<CheckTries, 'forget'>
  storage: () => Pick<Storage, 'removeUnusedClones'> | undefined
}): FactoryRemovals {
  const { store, banners } = options
  const removing = new Set<string>()

  function find(factoryId: string): StoredFactory {
    const factory = store.getFactory(factoryId)
    if (!factory) throw new RequestError(404, 'no such Factory')
    return factory
  }

  function usedElsewhere(factory: StoredFactory, repo: string): boolean {
    return store
      .listFactories()
      .some((f) => f.id !== factory.id && f.repos.some((r) => same(r.repo, repo)))
  }

  return {
    summary(factoryId) {
      const factory = find(factoryId)
      const inFactory = store.listTasks().filter((t) => t.factoryId === factory.id)
      const repos = factory.repos.map((r) => r.repo)
      return {
        factoryId: factory.id,
        key: factory.key,
        name: factory.name,
        tasks: inFactory.length,
        runs: inFactory.flatMap((t) => t.runs).filter((r) => r.state !== 'finished').length,
        worktrees: inFactory.flatMap((t) => t.repos.filter((r) => !r.removed)).length,
        openPullRequests: inFactory.flatMap((t) =>
          t.repos.filter(
            (r) =>
              r.pullRequest !== undefined &&
              r.pullRequest.state !== 'closed' &&
              r.pullRequest.state !== 'merged',
          ),
        ).length,
        clones: repos.filter((repo) => !usedElsewhere(factory, repo)),
        sharedClones: repos.filter((repo) => usedElsewhere(factory, repo)),
      }
    },

    async remove(factoryId, { key, closePullRequests }) {
      const factory = find(factoryId)
      if (key !== factory.key) throw new RequestError(400, `Type ${factory.key} to confirm`)
      if (removing.has(factory.id)) {
        throw new RequestError(409, `${factory.name} is already being removed`)
      }
      removing.add(factory.id)
      try {
        await options.factories.forget(factory.id)
        await options.automations.removeFactory(factory.id)
        await options.plans.removeFactory(factory.id)
        await options.tasks.removeFactoryTasks(factory.id, { closePullRequests })
        await options.checkTries.forget(factory.id)
        banners.clearFactory(factory.id)
        const repos = factory.repos.map((r) => r.repo)
        store.removeFactory(factory.id)
        await store.persisted()
        for (const repo of repos) {
          if (store.listFactories().some((f) => f.repos.some((r) => same(r.repo, repo)))) continue
          if (store.localFolder(repo) !== undefined) store.clearLocalFolder(repo)
        }
        await options
          .storage()
          ?.removeUnusedClones(repos)
          .catch((error: unknown) => {
            console.error(`couldn’t remove ${factory.name}’s clones:`, error)
          })
      } finally {
        removing.delete(factory.id)
      }
    },

    repo(factoryId, repoName) {
      const factory = find(factoryId)
      const repo = factory.repos.find((r) => r.name === repoName)
      if (!repo) throw new RequestError(404, `${factory.name} has no repo ${repoName}`)
      return {
        repo: repo.repo,
        name: repo.name,
        openTasks: openTasksUsing(store, factory, repo.repo),
      }
    },
  }
}

export function openTasksUsing(store: TedStore, factory: StoredFactory, repo: string): TaskRef[] {
  return store
    .listTasks()
    .filter((t) => t.factoryId === factory.id && isOpen(t) && uses(t, repo))
    .map((t) => ({ id: t.id, displayId: t.displayId, title: t.title }))
}

function isOpen(task: Task): boolean {
  return !task.archived && task.stage !== 'done'
}

function uses(task: Task, repo: string): boolean {
  return (
    task.chosenRepos.some((r) => same(r, repo)) ||
    task.repos.some((r) => !r.removed && same(r.repo, repo))
  )
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}
