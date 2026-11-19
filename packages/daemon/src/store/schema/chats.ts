import { Events, Schema, State } from '@livestore/livestore'
import { applyCoordinatorChange, type CoordinatorChange } from '../coordinator-change.ts'
import { messageDraftKey, messageDrafts, requestSnoozes, runDraftKey } from './requests.ts'
import { runInterrupts, runMessages, runs } from './runs.ts'

const coordinatorRunsDeleted = (runIds: readonly string[]) =>
  runIds.flatMap((id) => [
    messageDrafts.delete().where({ key: runDraftKey(id) }),
    runs.delete().where({ id }),
    runMessages.delete().where({ runId: id }),
    runInterrupts.delete().where({ runId: id }),
  ])

function chatRowsDeleted(chatId: string, requests: readonly { id: string }[]) {
  return [
    chatAgents.delete().where({ chatId }),
    chatCommands.delete().where({ chatId }),
    chatRequests.delete().where({ chatId }),
    ...requests.map(({ id }) =>
      messageDrafts.delete().where({ key: messageDraftKey('coordinator-request', id) }),
    ),
  ]
}

function patchCoordinatorChat(
  row: { data: string; endedAt: string | null; title: string | null } | undefined,
  id: string,
  factoryId: string,
  change: CoordinatorChange,
) {
  const before = row ? (JSON.parse(row.data) as Record<string, unknown>) : undefined
  return coordinatorChats
    .insert({
      id,
      factoryId,
      endedAt: row?.endedAt ?? null,
      title: row?.title ?? null,
      data: JSON.stringify(applyCoordinatorChange(before, change)),
    })
    .onConflict('id', 'replace')
}

export const sideChats = State.SQLite.table({
  name: 'sideChats',
  columns: { sourceRunId: State.SQLite.text({ primaryKey: true }), data: State.SQLite.text() },
})

export const coordinatorChats = State.SQLite.table({
  name: 'coordinatorChats',
  indexes: [{ name: 'idx_coordinatorChats_factoryId', columns: ['factoryId'] }],
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    factoryId: State.SQLite.text(),
    endedAt: State.SQLite.text({ nullable: true }),
    title: State.SQLite.text({ nullable: true }),
    data: State.SQLite.text(),
  },
})

export const chatAgents = State.SQLite.table({
  name: 'chatAgents',
  indexes: [{ name: 'idx_chatAgents_factoryId', columns: ['factoryId'] }],
  columns: {
    chatId: State.SQLite.text({ primaryKey: true }),
    kind: State.SQLite.text(),
    factoryId: State.SQLite.text(),
    agentId: State.SQLite.text(),
    name: State.SQLite.text(),
    source: State.SQLite.text(),
    agent: State.SQLite.text({ nullable: true }),
    model: State.SQLite.text({ nullable: true }),
    powers: State.SQLite.text(),
    instructions: State.SQLite.text(),
    commands: State.SQLite.text({ nullable: true }),
    outsideCommands: State.SQLite.text({ nullable: true }),
  },
})

export const chatCommands = State.SQLite.table({
  name: 'chatCommands',
  indexes: [
    { name: 'idx_chatCommands_chatId', columns: ['chatId'] },
    { name: 'idx_chatCommands_runId', columns: ['runId'] },
    { name: 'idx_chatCommands_factoryId', columns: ['factoryId'] },
  ],
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    chatId: State.SQLite.text(),
    factoryId: State.SQLite.text(),
    runId: State.SQLite.text(),
    name: State.SQLite.text(),
    outcome: State.SQLite.text(),
    exitCode: State.SQLite.integer({ nullable: true }),
    startedAt: State.SQLite.text(),
    endedAt: State.SQLite.text(),
    tail: State.SQLite.text(),
    outside: State.SQLite.text({ nullable: true }),
    outsideFolder: State.SQLite.text({ nullable: true }),
  },
})

export const outsideCommandAllowances = State.SQLite.table({
  name: 'outsideCommandAllowances',
  indexes: [{ name: 'idx_outsideCommandAllowances_factoryId', columns: ['factoryId'] }],
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    factoryId: State.SQLite.text(),
    agentId: State.SQLite.text(),
    name: State.SQLite.text(),
    command: State.SQLite.text(),
    repo: State.SQLite.text(),
    folder: State.SQLite.text(),
    allowedAt: State.SQLite.text(),
  },
})

export const chatRequests = State.SQLite.table({
  name: 'chatRequests',
  indexes: [
    { name: 'idx_chatRequests_chatId', columns: ['chatId'] },
    { name: 'idx_chatRequests_factoryId', columns: ['factoryId'] },
  ],
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    chatId: State.SQLite.text(),
    factoryId: State.SQLite.text(),
    runId: State.SQLite.text(),
    kind: State.SQLite.text(),
    title: State.SQLite.text({ nullable: true }),
    body: State.SQLite.text(),
    choices: State.SQLite.text({ nullable: true }),
    multiple: State.SQLite.boolean({ default: false }),
    round: State.SQLite.text({ nullable: true }),
    proposal: State.SQLite.text({ nullable: true }),
    agentDraft: State.SQLite.text({ nullable: true }),
    outsideCommand: State.SQLite.text({ nullable: true }),
    outsideFolder: State.SQLite.text({ nullable: true }),
    answer: State.SQLite.text({ nullable: true }),
    createdAt: State.SQLite.text(),
  },
})

export const chatsEvents = {
  sideChatChanged: Events.synced({
    name: 'v1.SideChatChanged',
    schema: Schema.Struct({ sourceRunId: Schema.String, data: Schema.String }),
  }),
  sideChatRemoved: Events.synced({
    name: 'v1.SideChatRemoved',
    schema: Schema.Struct({ sourceRunId: Schema.String, runId: Schema.String }),
  }),
  coordinatorChanged: Events.synced({
    name: 'v1.CoordinatorChanged',
    schema: Schema.Struct({ factoryId: Schema.String, data: Schema.String }),
  }),
  coordinatorPatched: Events.synced({
    name: 'v2.CoordinatorChanged',
    schema: Schema.Struct({
      factoryId: Schema.String,
      set: Schema.String,
      unset: Schema.Array(Schema.String),
      lists: Schema.NullOr(Schema.String),
    }),
  }),
  coordinatorRemoved: Events.synced({
    name: 'v1.CoordinatorRemoved',
    schema: Schema.Struct({ factoryId: Schema.String, runIds: Schema.Array(Schema.String) }),
  }),
  coordinatorConversationSaved: Events.synced({
    name: 'v1.CoordinatorConversationSaved',
    schema: Schema.Struct({
      id: Schema.String,
      factoryId: Schema.String,
      endedAt: Schema.String,
      data: Schema.String,
    }),
  }),
  coordinatorConversationContinued: Events.synced({
    name: 'v1.CoordinatorConversationContinued',
    schema: Schema.Struct({ id: Schema.String, factoryId: Schema.String }),
  }),
  coordinatorConversationDeleted: Events.synced({
    name: 'v1.CoordinatorConversationDeleted',
    schema: Schema.Struct({ id: Schema.String, runIds: Schema.Array(Schema.String) }),
  }),
  coordinatorChatChanged: Events.synced({
    name: 'v1.CoordinatorChatChanged',
    schema: Schema.Struct({
      id: Schema.String,
      factoryId: Schema.String,
      set: Schema.String,
      unset: Schema.Array(Schema.String),
      lists: Schema.NullOr(Schema.String),
    }),
  }),
  coordinatorChatContinued: Events.synced({
    name: 'v1.CoordinatorChatContinued',
    schema: Schema.Struct({ id: Schema.String }),
  }),
  coordinatorChatDeleted: Events.synced({
    name: 'v1.CoordinatorChatDeleted',
    schema: Schema.Struct({ id: Schema.String, runIds: Schema.Array(Schema.String) }),
  }),
  coordinatorChatRenamed: Events.synced({
    name: 'v1.CoordinatorChatRenamed',
    schema: Schema.Struct({ id: Schema.String, title: Schema.String }),
  }),
  coordinatorChatArchived: Events.synced({
    name: 'v1.CoordinatorChatArchived',
    schema: Schema.Struct({ id: Schema.String, at: Schema.String }),
  }),
  chatAgentRecorded: Events.synced({
    name: 'v1.ChatAgentRecorded',
    schema: Schema.Struct({
      chatId: Schema.String,
      kind: Schema.String,
      factoryId: Schema.String,
      agent: Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        source: Schema.String,
        agent: Schema.NullOr(Schema.String),
        model: Schema.NullOr(Schema.String),
        powers: Schema.Array(Schema.String),
        instructions: Schema.String,
      }),
      at: Schema.String,
    }),
  }),
  chatAgentCommandsRecorded: Events.synced({
    name: 'v1.ChatAgentCommandsRecorded',
    schema: Schema.Struct({
      chatId: Schema.String,
      commands: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          command: Schema.String,
          repo: Schema.NullOr(Schema.String),
        }),
      ),
    }),
  }),
  chatCommandRan: Events.synced({
    name: 'v1.ChatCommandRan',
    schema: Schema.Struct({
      id: Schema.String,
      chatId: Schema.String,
      factoryId: Schema.String,
      runId: Schema.String,
      name: Schema.String,
      outcome: Schema.String,
      exitCode: Schema.NullOr(Schema.Number),
      startedAt: Schema.String,
      endedAt: Schema.String,
      tail: Schema.String,
    }),
  }),
  chatRequestPosted: Events.synced({
    name: 'v1.ChatRequestPosted',
    schema: Schema.Struct({
      id: Schema.String,
      chatId: Schema.String,
      factoryId: Schema.String,
      runId: Schema.String,
      kind: Schema.String,
      title: Schema.NullOr(Schema.String),
      body: Schema.String,
      choices: Schema.NullOr(Schema.Array(Schema.String)),
      multiple: Schema.Boolean,
      round: Schema.NullOr(Schema.String),
      proposal: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  chatAgentDraftPosted: Events.synced({
    name: 'v1.ChatAgentDraftPosted',
    schema: Schema.Struct({ id: Schema.String, draft: Schema.String }),
  }),
  chatAgentOutsideCommandsRecorded: Events.synced({
    name: 'v1.ChatAgentOutsideCommandsRecorded',
    schema: Schema.Struct({
      chatId: Schema.String,
      commands: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          command: Schema.String,
          repo: Schema.NullOr(Schema.String),
        }),
      ),
    }),
  }),
  chatOutsideCommandAsked: Events.synced({
    name: 'v1.ChatOutsideCommandAsked',
    schema: Schema.Struct({ id: Schema.String, ask: Schema.String }),
  }),
  chatOutsideCommandRan: Events.synced({
    name: 'v1.ChatOutsideCommandRan',
    schema: Schema.Struct({ id: Schema.String, outside: Schema.String }),
  }),
  chatOutsideFolderChecked: Events.synced({
    name: 'v1.ChatOutsideFolderChecked',
    schema: Schema.Struct({ id: Schema.String, folder: Schema.String }),
  }),
  chatOutsideFolderRan: Events.synced({
    name: 'v1.ChatOutsideFolderRan',
    schema: Schema.Struct({ id: Schema.String, folder: Schema.String }),
  }),
  outsideCommandAllowed: Events.synced({
    name: 'v1.OutsideCommandAllowed',
    schema: Schema.Struct({
      id: Schema.String,
      factoryId: Schema.String,
      agentId: Schema.String,
      name: Schema.String,
      command: Schema.String,
      repo: Schema.String,
      folder: Schema.String,
      at: Schema.String,
    }),
  }),
  outsideCommandAllowanceRemoved: Events.synced({
    name: 'v1.OutsideCommandAllowanceRemoved',
    schema: Schema.Struct({ id: Schema.String, at: Schema.String }),
  }),
  chatRequestAnswered: Events.synced({
    name: 'v1.ChatRequestAnswered',
    schema: Schema.Struct({ id: Schema.String, answer: Schema.String, at: Schema.String }),
  }),
}

export const chatsMaterializers = State.SQLite.materializers(chatsEvents, {
  'v1.SideChatChanged': (row) => sideChats.insert(row).onConflict('sourceRunId', 'replace'),
  'v1.SideChatRemoved': ({ sourceRunId, runId }) => [
    sideChats.delete().where({ sourceRunId }),
    messageDrafts.delete().where({ key: runDraftKey(runId) }),
    runs.delete().where({ id: runId }),
    runMessages.delete().where({ runId }),
    runInterrupts.delete().where({ runId }),
  ],
  'v1.CoordinatorChanged': ({ factoryId, data }) =>
    coordinatorChats
      .insert({ id: factoryId, factoryId, endedAt: null, data })
      .onConflict('id', 'replace'),
  'v2.CoordinatorChanged': ({ factoryId, ...change }, { query }) =>
    patchCoordinatorChat(
      query(coordinatorChats.where({ id: factoryId }).first()),
      factoryId,
      factoryId,
      change,
    ),
  'v1.CoordinatorRemoved': ({ factoryId, runIds }, { query }) => [
    coordinatorChats.delete().where({ id: factoryId }),
    ...chatRowsDeleted(factoryId, query(chatRequests.where({ chatId: factoryId }))),
    ...coordinatorRunsDeleted(runIds),
  ],
  'v1.CoordinatorConversationSaved': ({ id, factoryId, endedAt, data }) => [
    coordinatorChats.delete().where({ id: factoryId }),
    coordinatorChats
      .insert({
        id,
        factoryId,
        endedAt,
        data: JSON.stringify(
          (JSON.parse(data) as { chat: Record<string, unknown>; startedAt: string }).chat,
        ),
      })
      .onConflict('id', 'replace'),
  ],
  'v1.CoordinatorConversationContinued': ({ id }) => coordinatorChats.delete().where({ id }),
  'v1.CoordinatorConversationDeleted': ({ id, runIds }) => [
    coordinatorChats.delete().where({ id }),
    ...coordinatorRunsDeleted(runIds),
  ],
  'v1.CoordinatorChatChanged': ({ id, factoryId, ...change }, { query }) =>
    patchCoordinatorChat(query(coordinatorChats.where({ id }).first()), id, factoryId, change),
  'v1.CoordinatorChatContinued': ({ id }) =>
    coordinatorChats.update({ endedAt: null }).where({ id }),
  'v1.CoordinatorChatRenamed': ({ id, title }) => coordinatorChats.update({ title }).where({ id }),
  'v1.CoordinatorChatArchived': ({ id, at }) =>
    coordinatorChats.update({ endedAt: at }).where({ id }),
  'v1.CoordinatorChatDeleted': ({ id, runIds }, { query }) => [
    coordinatorChats.delete().where({ id }),
    ...chatRowsDeleted(id, query(chatRequests.where({ chatId: id }))),
    requestSnoozes.delete().where({ ownerId: id }),
    messageDrafts.delete().where({ key: messageDraftKey('coordinator', id) }),
    ...coordinatorRunsDeleted(runIds),
  ],
  'v1.ChatAgentRecorded': ({ chatId, kind, factoryId, agent }) =>
    chatAgents
      .insert({
        chatId,
        kind,
        factoryId,
        agentId: agent.id,
        name: agent.name,
        source: agent.source,
        agent: agent.agent,
        model: agent.model,
        powers: JSON.stringify(agent.powers),
        instructions: agent.instructions,
      })
      .onConflict('chatId', 'replace'),
  'v1.ChatAgentCommandsRecorded': ({ chatId, commands }) =>
    chatAgents.update({ commands: JSON.stringify(commands) }).where({ chatId }),
  'v1.ChatCommandRan': (ran) => chatCommands.insert(ran).onConflict('id', 'ignore'),
  'v1.ChatRequestPosted': ({ at, choices, ...request }) =>
    chatRequests.insert({
      ...request,
      choices: choices === null ? null : JSON.stringify(choices),
      createdAt: at,
    }),
  'v1.ChatAgentDraftPosted': ({ id, draft }) =>
    chatRequests.update({ agentDraft: draft }).where({ id }),
  'v1.ChatAgentOutsideCommandsRecorded': ({ chatId, commands }) =>
    chatAgents.update({ outsideCommands: JSON.stringify(commands) }).where({ chatId }),
  'v1.ChatOutsideCommandAsked': ({ id, ask }) =>
    chatRequests.update({ outsideCommand: ask }).where({ id }),
  'v1.ChatOutsideCommandRan': ({ id, outside }) => chatCommands.update({ outside }).where({ id }),
  'v1.ChatOutsideFolderChecked': ({ id, folder }) =>
    chatRequests.update({ outsideFolder: folder }).where({ id }),
  'v1.ChatOutsideFolderRan': ({ id, folder }) =>
    chatCommands.update({ outsideFolder: folder }).where({ id }),
  'v1.OutsideCommandAllowed': ({ at, ...allowance }) =>
    outsideCommandAllowances.insert({ ...allowance, allowedAt: at }).onConflict('id', 'replace'),
  'v1.OutsideCommandAllowanceRemoved': ({ id }) => outsideCommandAllowances.delete().where({ id }),
  'v1.ChatRequestAnswered': ({ id, answer }) => [
    chatRequests.update({ answer }).where({ id }),
    requestSnoozes.delete().where({ requestId: id }),
    messageDrafts.delete().where({ key: messageDraftKey('coordinator-request', id) }),
  ],
})
