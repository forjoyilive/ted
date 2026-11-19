import { randomUUID } from 'node:crypto'
import { queryDb } from '@livestore/livestore'
import type {
  Factory,
  FactoryGroup,
  FactoryGuide,
  FactoryIcon,
  FactoryLayout,
  FactoryLayoutItem,
} from '@ted/protocol'
import type { StoreContext } from './context.ts'
import { events, factoryLayout as factoryLayoutRows, localFolders } from './schema.ts'
import type { NewFactory, StoredFactory, StoredFactoryRepo } from './types.ts'

export function basicFactory({
  cloneUrl: _,
  autoStartBacklog: __,
  clonedAt,
  repos,
  ...factory
}: StoredFactory): Factory {
  return {
    ...factory,
    repos: repos.map(({ repo, name }) => ({ repo, name })),
    cloned: clonedAt !== undefined,
  }
}

export interface FactoriesArea {
  addFactory(
    input: Pick<StoredFactory, 'key' | 'name' | 'repo' | 'cloneUrl' | 'defaultBranch'>,
  ): StoredFactory
  createFactory(input: NewFactory): StoredFactory
  guides(): FactoryGuide[]
  hideGuide(factoryId: string): boolean
  factoryCloned(factoryId: string): StoredFactory
  listFactories(): StoredFactory[]
  getFactory(id: string): StoredFactory | undefined
  setLocalFolder(repo: string, path: string): void
  clearLocalFolder(repo: string): void
  setFactoryAutoStartBacklog(factoryId: string, enabled: boolean): StoredFactory
  renameFactory(factoryId: string, name: string): StoredFactory
  setFactoryIcon(factoryId: string, icon: FactoryIcon | null): StoredFactory
  factoryLayout(): FactoryLayout
  saveFactoryLayout(layout: FactoryLayout): StoredFactory[] | undefined
  removeFactory(factoryId: string): void
  changeFactoryRepos(factoryId: string, repos: StoredFactoryRepo[]): StoredFactory
  localFolder(repo: string): string | undefined
  factoryOfTask(taskId: string): string | undefined
}

export function factoriesArea(ctx: StoreContext): FactoriesArea {
  const {
    store,
    commit,
    allFactories,
    listFactories,
    guides,
    emitGuides,
    guideEnding,
    requireFactory,
    taskRow,
    emit,
    settings,
    noteActivity,
  } = ctx
  const allFactoryLayout = queryDb(factoryLayoutRows.orderBy('position', 'asc'))
  const readFactoryLayout = (): FactoryLayout => {
    const existing = listFactories()
    const known = new Set(existing.map((f) => f.id))
    const placed = new Set<string>()
    const groups = new Map<string, { group: FactoryGroup }>()
    const items: FactoryLayoutItem[] = []
    for (const row of store.query(allFactoryLayout)) {
      if (row.factoryId === null) {
        if (row.groupId === null || row.name === null) continue
        const item = { group: { id: row.groupId, name: row.name, factoryIds: [] } }
        groups.set(row.groupId, item)
        items.push(item)
        continue
      }
      if (!known.has(row.factoryId) || placed.has(row.factoryId)) continue
      placed.add(row.factoryId)
      const group = row.groupId === null ? undefined : groups.get(row.groupId)
      if (group) group.group.factoryIds.push(row.factoryId)
      else items.push({ factoryId: row.factoryId })
    }
    for (const factory of existing) {
      if (!placed.has(factory.id)) items.push({ factoryId: factory.id })
    }
    return { items }
  }

  return {
    addFactory(input) {
      const row = { ...input, id: randomUUID(), createdAt: new Date().toISOString() }
      commit(events.factoryAdded(row))
      const added = requireFactory(row.id)
      emit({ type: 'factory-added', factory: basicFactory(added) })
      return added
    },
    createFactory({ repos, ...input }) {
      const id = randomUUID()
      const at = new Date().toISOString()
      const next = settings().guideNextFactory
      const guided = next || store.query(allFactories).length === 0
      commit(
        events.factoryAddedV2({ ...input, id, repos, showTutorial: false, createdAt: at }),
        ...(guided ? [events.factoryGuideStarted({ factoryId: id, at })] : []),
        ...(next
          ? [
              events.machineSettingsChanged({
                changes: JSON.stringify({ guideNextFactory: false }),
                at,
              }),
            ]
          : []),
      )
      const added = requireFactory(id)
      emit({ type: 'factory-added', factory: basicFactory(added) })
      if (next) emit({ type: 'settings-changed', settings: settings() })
      if (guided) emitGuides()
      noteActivity()
      return added
    },
    guides,
    hideGuide(factoryId) {
      const ending = guideEnding(factoryId, 'hidden')
      if (ending.length === 0) return false
      commit(...ending)
      emitGuides()
      return true
    },
    factoryCloned(factoryId) {
      commit(events.factoryCloned({ factoryId, at: new Date().toISOString() }))
      noteActivity()
      return requireFactory(factoryId)
    },
    listFactories,
    getFactory: (id) => listFactories().find((f) => f.id === id),
    setLocalFolder(repo, path) {
      commit(events.localFolderSet({ repo, path, at: new Date().toISOString() }))
    },
    clearLocalFolder(repo) {
      commit(events.localFolderCleared({ repo, at: new Date().toISOString() }))
    },
    setFactoryAutoStartBacklog(factoryId, enabled) {
      requireFactory(factoryId)
      commit(
        events.factoryAutoStartBacklogChanged({ factoryId, enabled, at: new Date().toISOString() }),
      )
      const factory = requireFactory(factoryId)
      emit({ type: 'factory-updated', factory: basicFactory(factory) })
      return factory
    },
    setFactoryIcon(factoryId, icon) {
      requireFactory(factoryId)
      commit(
        events.factoryIconChanged({
          factoryId,
          icon: icon === null ? null : JSON.stringify(icon),
          at: new Date().toISOString(),
        }),
      )
      return requireFactory(factoryId)
    },
    renameFactory(factoryId, name) {
      commit(events.factoryRenamed({ factoryId, name, at: new Date().toISOString() }))
      return requireFactory(factoryId)
    },
    factoryLayout: readFactoryLayout,
    saveFactoryLayout(layout) {
      if (JSON.stringify(layout) === JSON.stringify(readFactoryLayout())) return undefined
      commit(events.factoryLayoutSaved({ items: layout.items, at: new Date().toISOString() }))
      emit({ type: 'factory-layout-changed', layout: readFactoryLayout() })
      return listFactories()
    },
    removeFactory(factoryId) {
      commit(events.factoryRemoved({ factoryId, at: new Date().toISOString() }))
      emit({ type: 'factory-removed', factoryId })
      noteActivity()
    },
    changeFactoryRepos(factoryId, repos) {
      commit(events.factoryReposChanged({ factoryId, repos, at: new Date().toISOString() }))
      return requireFactory(factoryId)
    },
    localFolder: (repo) => store.query(queryDb(localFolders.where({ repo }))).at(0)?.path,
    factoryOfTask: (taskId) => taskRow(taskId)?.factoryId,
  }
}
