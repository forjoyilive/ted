import { Events, Schema, State } from '@livestore/livestore'
import { chatAgents, chatCommands, chatRequests, outsideCommandAllowances } from './chats.ts'
import { banners } from './machine.ts'
import { peerMessages } from './peers.ts'
import { messageDrafts, requestSnoozes } from './requests.ts'
import { deletedTasks, taskMoves, workflowLayers } from './tasks.ts'

export const factories = State.SQLite.table({
  name: 'factories',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    key: State.SQLite.text(),
    name: State.SQLite.text(),
    repo: State.SQLite.text(),
    cloneUrl: State.SQLite.text(),
    defaultBranch: State.SQLite.text(),
    showTutorial: State.SQLite.boolean({ default: false }),
    guide: State.SQLite.text({ nullable: true }),
    autoStartBacklog: State.SQLite.boolean({ default: false }),
    icon: State.SQLite.text({ nullable: true }),
    clonedAt: State.SQLite.text({ nullable: true }),
    createdAt: State.SQLite.text(),
  },
})

export const factoryRepos = State.SQLite.table({
  name: 'factoryRepos',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    factoryId: State.SQLite.text(),
    position: State.SQLite.integer(),
    repo: State.SQLite.text(),
    name: State.SQLite.text(),
    cloneUrl: State.SQLite.text(),
  },
})

export const factoryOrder = State.SQLite.table({
  name: 'factoryOrder',
  columns: {
    factoryId: State.SQLite.text({ primaryKey: true }),
    position: State.SQLite.integer(),
  },
})

export const factoryLayout = State.SQLite.table({
  name: 'factoryLayout',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    factoryId: State.SQLite.text({ nullable: true }),
    groupId: State.SQLite.text({ nullable: true }),
    name: State.SQLite.text({ nullable: true }),
    position: State.SQLite.integer(),
  },
})

export const localFolders = State.SQLite.table({
  name: 'localFolders',
  columns: {
    repo: State.SQLite.text({ primaryKey: true }),
    path: State.SQLite.text(),
    setAt: State.SQLite.text(),
  },
})

export const factoriesEvents = {
  factoryAdded: Events.synced({
    name: 'v1.FactoryAdded',
    schema: Schema.Struct({
      id: Schema.String,
      key: Schema.String,
      name: Schema.String,
      repo: Schema.String,
      cloneUrl: Schema.String,
      defaultBranch: Schema.String,
      createdAt: Schema.String,
    }),
  }),
  factoryAddedV2: Events.synced({
    name: 'v2.FactoryAdded',
    schema: Schema.Struct({
      id: Schema.String,
      key: Schema.String,
      name: Schema.String,
      repos: Schema.Array(
        Schema.Struct({ repo: Schema.String, name: Schema.String, cloneUrl: Schema.String }),
      ),
      defaultBranch: Schema.String,
      showTutorial: Schema.Boolean,
      createdAt: Schema.String,
    }),
  }),
  factoryGuideStarted: Events.synced({
    name: 'v1.FactoryGuideStarted',
    schema: Schema.Struct({ factoryId: Schema.String, at: Schema.String }),
  }),
  factoryGuideEnded: Events.synced({
    name: 'v1.FactoryGuideEnded',
    schema: Schema.Struct({ factoryId: Schema.String, reason: Schema.String, at: Schema.String }),
  }),
  factoryCloned: Events.synced({
    name: 'v1.FactoryCloned',
    schema: Schema.Struct({ factoryId: Schema.String, at: Schema.String }),
  }),
  localFolderSet: Events.synced({
    name: 'v1.LocalFolderSet',
    schema: Schema.Struct({ repo: Schema.String, path: Schema.String, at: Schema.String }),
  }),
  localFolderCleared: Events.synced({
    name: 'v1.LocalFolderCleared',
    schema: Schema.Struct({ repo: Schema.String, at: Schema.String }),
  }),
  factoryAutoStartBacklogChanged: Events.synced({
    name: 'v1.FactoryAutoStartBacklogChanged',
    schema: Schema.Struct({ factoryId: Schema.String, enabled: Schema.Boolean, at: Schema.String }),
  }),
  factoryIconChanged: Events.synced({
    name: 'v1.FactoryIconChanged',
    schema: Schema.Struct({
      factoryId: Schema.String,
      icon: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  factoryRenamed: Events.synced({
    name: 'v1.FactoryRenamed',
    schema: Schema.Struct({ factoryId: Schema.String, name: Schema.String, at: Schema.String }),
  }),
  factoryReposChanged: Events.synced({
    name: 'v1.FactoryReposChanged',
    schema: Schema.Struct({
      factoryId: Schema.String,
      repos: Schema.Array(
        Schema.Struct({ repo: Schema.String, name: Schema.String, cloneUrl: Schema.String }),
      ),
      at: Schema.String,
    }),
  }),
  factoriesReordered: Events.synced({
    name: 'v1.FactoriesReordered',
    schema: Schema.Struct({ factoryIds: Schema.Array(Schema.String), at: Schema.String }),
  }),
  factoryLayoutSaved: Events.synced({
    name: 'v1.FactoryLayoutSaved',
    schema: Schema.Struct({
      items: Schema.Array(
        Schema.Union([
          Schema.Struct({ factoryId: Schema.String }),
          Schema.Struct({
            group: Schema.Struct({
              id: Schema.String,
              name: Schema.String,
              factoryIds: Schema.Array(Schema.String),
            }),
          }),
        ]),
      ),
      at: Schema.String,
    }),
  }),
  factoryRemoved: Events.synced({
    name: 'v1.FactoryRemoved',
    schema: Schema.Struct({ factoryId: Schema.String, at: Schema.String }),
  }),
}

export const factoriesMaterializers = State.SQLite.materializers(factoriesEvents, {
  'v1.FactoryAdded': (factory) => [
    factories.insert({ ...factory, clonedAt: factory.createdAt }),
    factoryRepos.insert({
      id: `${factory.id}:0`,
      factoryId: factory.id,
      position: 0,
      repo: factory.repo,
      name: factory.repo.split('/').at(-1) ?? factory.repo,
      cloneUrl: factory.cloneUrl,
    }),
  ],
  'v2.FactoryAdded': ({ repos, ...factory }) => [
    factories.insert({
      ...factory,
      repo: repos[0]?.repo ?? '',
      cloneUrl: repos[0]?.cloneUrl ?? '',
      clonedAt: null,
    }),
    ...repos.map((repo, position) =>
      factoryRepos.insert({
        ...repo,
        id: `${factory.id}:${position}`,
        factoryId: factory.id,
        position,
      }),
    ),
  ],
  'v1.FactoryGuideStarted': ({ factoryId }) =>
    factories.update({ guide: 'live' }).where({ id: factoryId }),
  'v1.FactoryGuideEnded': ({ factoryId, reason }) =>
    factories.update({ guide: reason }).where({ id: factoryId }),
  'v1.FactoryCloned': ({ factoryId, at }) =>
    factories.update({ clonedAt: at }).where({ id: factoryId }),
  'v1.LocalFolderSet': ({ repo, path, at }) =>
    localFolders.insert({ repo, path, setAt: at }).onConflict('repo', 'replace'),
  'v1.LocalFolderCleared': ({ repo }) => localFolders.delete().where({ repo }),
  'v1.FactoryAutoStartBacklogChanged': ({ factoryId, enabled }) =>
    factories.update({ autoStartBacklog: enabled }).where({ id: factoryId }),
  'v1.FactoryIconChanged': ({ factoryId, icon }) =>
    factories.update({ icon }).where({ id: factoryId }),
  'v1.FactoryRenamed': ({ factoryId, name }) => factories.update({ name }).where({ id: factoryId }),
  'v1.FactoryReposChanged': ({ factoryId, repos }) => [
    factoryRepos.delete().where({ factoryId }),
    ...repos.map((repo, position) =>
      factoryRepos.insert({ ...repo, id: `${factoryId}:${position}`, factoryId, position }),
    ),
  ],
  'v1.FactoriesReordered': ({ factoryIds }) => [
    factoryOrder.delete(),
    ...factoryIds.map((factoryId, position) => factoryOrder.insert({ factoryId, position })),
  ],
  'v1.FactoryLayoutSaved': ({ items }) => {
    type Row = {
      id: string
      factoryId: string | null
      groupId: string | null
      name: string | null
    }
    const rows = items.flatMap<Row>((item) =>
      'group' in item
        ? [
            {
              id: `group:${item.group.id}`,
              factoryId: null,
              groupId: item.group.id,
              name: item.group.name,
            },
            ...item.group.factoryIds.map((factoryId) => ({
              id: `factory:${factoryId}`,
              factoryId,
              groupId: item.group.id,
              name: null,
            })),
          ]
        : [
            {
              id: `factory:${item.factoryId}`,
              factoryId: item.factoryId,
              groupId: null,
              name: null,
            },
          ],
    )
    const order = rows.flatMap((row) => (row.factoryId === null ? [] : [row.factoryId]))
    return [
      factoryLayout.delete(),
      ...rows.map((row, position) => factoryLayout.insert({ ...row, position })),
      factoryOrder.delete(),
      ...order.map((factoryId, position) => factoryOrder.insert({ factoryId, position })),
    ]
  },
  'v1.FactoryRemoved': ({ factoryId }) => [
    peerMessages.delete().where({ factoryId }),
    factories.delete().where({ id: factoryId }),
    factoryRepos.delete().where({ factoryId }),
    factoryOrder.delete().where({ factoryId }),
    factoryLayout.delete().where({ id: `factory:${factoryId}` }),
    deletedTasks.delete().where({ factoryId }),
    taskMoves.delete().where({ factoryId }),
    banners.delete().where({ factoryId }),
    workflowLayers.delete().where({ layer: `factory:${factoryId}` }),
    requestSnoozes.delete().where({ factoryId }),
    messageDrafts.delete().where({ factoryId }),
    chatAgents.delete().where({ factoryId }),
    chatCommands.delete().where({ factoryId }),
    chatRequests.delete().where({ factoryId }),
    outsideCommandAllowances.delete().where({ factoryId }),
  ],
})
