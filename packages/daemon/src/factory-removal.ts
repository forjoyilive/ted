import type {
  FactoryRemoval,
  RemoveFactoryRequest,
  RepoRemoval,
  Task,
  TaskRef,
  TrackerGroupLists,
} from '@ted/protocol'
import type { Automations } from './automations/automations.ts'
import type { Banners } from './banners.ts'
import type { CheckTries } from './check-tries.ts'
import type { Coordinators } from './coordinators/coordinators.ts'
import { RequestError } from './errors.ts'
import type { ExecutionController } from './execution/controller.ts'
import type { FactorySettings } from './factory-settings.ts'
import type { Factories } from './factory-setup.ts'
import type { Plans } from './plans/plans.ts'
import type { SideChats } from './side-chats/side-chats.ts'
import type { Storage } from './storage.ts'
import type { StoredFactory, TedStore } from './store/index.ts'
import type { Tasks } from './tasks/tasks.ts'
import type { Workflows } from './workflow/workflows.ts'

export interface FactoryRemovals {
  summary(factoryId: string): FactoryRemoval
  remove(factoryId: string, request: RemoveFactoryRequest): Promise<void>
  repo(factoryId: string, repoName: string): RepoRemoval
}

export function createFactoryRemovals(options: {
  store: TedStore
  execution?: Pick<ExecutionController, 'forgetFactory'>
  banners: Banners
  tasks: Pick<Tasks, 'removeFactoryTasks'>
  automations: Pick<Automations, 'removeFactory'>
  sideChats?: Pick<SideChats, 'removeFactory'>
  coordinators?: Pick<Coordinators, 'removeFactory' | 'holdFactoryRemoval'>
  plans: Pick<Plans, 'removeFactory'>
  factories: Pick<Factories, 'forget'>
  checkTries: Pick<CheckTries, 'forget'>
  workflows?: Pick<Workflows, 'forget'>
  factorySettings: Pick<FactorySettings, 'forget'>
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
      const releaseCoordinator = options.coordinators?.holdFactoryRemoval(factory.id)
      try {
        await options.execution?.forgetFactory(factory.id)
        await options.factories.forget(factory.id)
        await options.sideChats?.removeFactory(factory.id)
        await options.automations.removeFactory(factory.id)
        await options.coordinators?.removeFactory(factory.id)
        await options.plans.removeFactory(factory.id)
        await options.tasks.removeFactoryTasks(factory.id, { closePullRequests })
        await options.checkTries.forget(factory.id)
        options.workflows?.forget(factory.id)
        banners.clearFactory(factory.id)
        const repos = factory.repos.map((r) => r.repo)
        store.removeTaskDraft(factory.id)
        store.removeFactory(factory.id)
        options.factorySettings.forget(factory.id)
        const settings = store.settings()
        const { [factory.id]: _, ...teams } = settings.linearSyncTeams
        const { [factory.id]: __, ...declined } = settings.linearSyncDeclined
        const { [factory.id]: ___, ...outside } = settings.appsOutsideSandbox
        const withoutFactory = (lists: TrackerGroupLists): TrackerGroupLists =>
          Object.fromEntries(
            Object.entries(lists).map(([tracker, byFactory]) => {
              const { [factory.id]: _removed, ...rest } = byFactory
              return [tracker, rest]
            }),
          )
        const { [factory.id]: removedScope, ...scopes } = settings.linearIntakeScopes
        const { [factory.id]: removedAsanaScope, ...asanaScopes } = settings.asanaIntakeScopes
        const { [factory.id]: removedGitHubScope, ...githubScopes } = settings.githubIntakeScopes
        const { [factory.id]: removedBoard, ...boards } = settings.boardViews
        const { [factory.id]: permissionsRemoved, ...permissions } = settings.factoryPermissions
        const { [factory.id]: notificationsRemoved, ...notifications } =
          settings.factoryNotifications
        store.updateSettings({
          factoryNotifications: notifications,
          linearIntakeScopes: scopes,
          asanaIntakeScopes: asanaScopes,
          githubIntakeScopes: githubScopes,
          factoryPermissions: permissions,
          linearSyncTeams: teams,
          linearSyncDeclined: declined,
          trackerSyncGroups: withoutFactory(settings.trackerSyncGroups),
          trackerSyncDeclined: withoutFactory(settings.trackerSyncDeclined),
          trackerSyncGroupAccounts: Object.fromEntries(
            Object.entries(settings.trackerSyncGroupAccounts).map(([tracker, byFactory]) => {
              const { [factory.id]: _removed, ...rest } = byFactory
              return [tracker, rest]
            }),
          ),
          appsOutsideSandbox: outside,
          boardViews: boards,
        })
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
        releaseCoordinator?.()
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

export function openTasksUsing(
  store: TedStore,
  factory: StoredFactory,
  repo: string,
  tasks: readonly Task[] = store.listTasks(),
): TaskRef[] {
  return tasks
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
