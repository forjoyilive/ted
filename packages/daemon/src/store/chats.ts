import { randomUUID } from 'node:crypto'
import { queryDb, type Store } from '@livestore/livestore'
import type {
  AgentChatKind,
  AgentDraft,
  ChatItem,
  ChatRequest,
  ChatRequestKind,
  CommentAnswer,
  LayerKind,
  OutsideCommandAllowance,
  OutsideCommandAsk,
  Proposal,
  Round,
} from '@ted/protocol'
import { chatRequestKinds } from '@ted/protocol'
import { type AgentCommand, type AgentPower, agentPowers } from '@ted/protocol/agent-files'
import { isArray, isObject, isOneOf, isString, parseJson } from '@ted/protocol/parse'
import { type AgentKind, agentKinds } from '@ted/protocol/run'
import {
  chatAgents,
  chatCommands,
  chatRequests,
  events,
  outsideCommandAllowances,
  type schema,
} from './schema.ts'

export interface StoredChatAgent {
  id: string
  name: string
  source: LayerKind
  agent?: AgentKind
  model?: string
  powers: AgentPower[]
  commands?: AgentCommand[]
  outsideCommands?: AgentCommand[]
  instructions: string
}

export type ChatCommandItem = Extract<ChatItem, { kind: 'command' }>

export interface ChatCommandRan {
  id: string
  chatId: string
  factoryId: string
  runId: string
  name: string
  outcome: 'passed' | 'failed' | 'stopped'
  exitCode?: number
  startedAt: string
  endedAt: string
  tail: string
  outside?: OutsideRun
}

export interface OutsideRun {
  command: string
  folder: string
  always?: true
}

export type ChatAgentEvent =
  | ReturnType<typeof events.chatAgentRecorded>
  | ReturnType<typeof events.chatAgentCommandsRecorded>
  | ReturnType<typeof events.chatAgentOutsideCommandsRecorded>

export interface AllowanceKey {
  factoryId: string
  agentId: string
  name: string
}

export interface NewChatRequest {
  chatId: string
  factoryId: string
  runId: string
  kind: ChatRequestKind
  title?: string
  body: string
  choices?: string[]
  multiple?: true
  round?: Round
  proposal?: Proposal
  agentDraft?: AgentDraft
  outsideCommand?: OutsideCommandAsk
}

export interface ChatStore {
  agent(chatId: string): StoredChatAgent | undefined
  agentRecorded(
    chatId: string,
    kind: AgentChatKind,
    factoryId: string,
    agent: StoredChatAgent,
  ): ChatAgentEvent[]
  commandRan(ran: ChatCommandRan): void
  commandRunning(runId: string, item: ChatCommandItem | undefined): void
  commands(runId: string): ChatCommandItem[]
  requests(chatId: string): ChatRequest[]
  request(id: string): ChatRequest | undefined
  post(input: NewChatRequest): ChatRequest
  answer(id: string, answer: CommentAnswer): ChatRequest
  allowances(factoryId: string): OutsideCommandAllowance[]
  allowance(key: AllowanceKey): OutsideCommandAllowance | undefined
  allow(
    key: AllowanceKey,
    allowed: Pick<OutsideCommandAllowance, 'command' | 'repo' | 'folder'>,
  ): OutsideCommandAllowance
  removeAllowance(id: string): void
}

const layerKinds: readonly LayerKind[] = ['ted', 'library', 'factory']

function powersOf(text: string): AgentPower[] {
  const parsed = parseJson(text)
  return isArray(parsed) ? agentPowers.filter((power) => parsed.includes(power)) : []
}

function commandsOf(text: string | null): AgentCommand[] | undefined {
  if (text === null) return undefined
  const parsed = parseJson(text)
  if (!isArray(parsed)) return undefined
  const commands = parsed.flatMap((item): AgentCommand[] => {
    if (!isObject(item) || !isString(item.name) || !isString(item.command)) return []
    return [
      {
        name: item.name,
        command: item.command,
        ...(isString(item.repo) && { repo: item.repo }),
      },
    ]
  })
  return commands.length > 0 ? commands : undefined
}

const commandOutcomes = ['passed', 'failed', 'stopped'] as const

function choicesOf(text: string | null): string[] | undefined {
  if (text === null) return undefined
  const parsed = parseJson(text)
  return isArray(parsed) ? parsed.filter(isString) : undefined
}

export function chatAgentEvents(
  chatId: string,
  kind: AgentChatKind,
  factoryId: string,
  agent: StoredChatAgent,
): ChatAgentEvent[] {
  const recorded = events.chatAgentRecorded({
    chatId,
    kind,
    factoryId,
    agent: {
      id: agent.id,
      name: agent.name,
      source: agent.source,
      agent: agent.agent ?? null,
      model: agent.model ?? null,
      powers: [...agent.powers],
      instructions: agent.instructions,
    },
    at: new Date().toISOString(),
  })
  const listed = (commands: readonly AgentCommand[]) =>
    commands.map((c) => ({ name: c.name, command: c.command, repo: c.repo ?? null }))
  const commands = agent.commands ?? []
  const outside = agent.outsideCommands ?? []
  return [
    recorded,
    ...(commands.length > 0
      ? [events.chatAgentCommandsRecorded({ chatId, commands: listed(commands) })]
      : []),
    ...(outside.length > 0
      ? [events.chatAgentOutsideCommandsRecorded({ chatId, commands: listed(outside) })]
      : []),
  ]
}

function outsideRunOf(text: string | null): OutsideRun | undefined {
  if (text === null) return undefined
  const parsed = parseJson(text)
  if (!isObject(parsed) || !isString(parsed.command) || !isString(parsed.folder)) return undefined
  return {
    command: parsed.command,
    folder: parsed.folder,
    ...(parsed.always === true && { always: true as const }),
  }
}

function allowanceOf(row: typeof outsideCommandAllowances.Type): OutsideCommandAllowance {
  return {
    id: row.id,
    factoryId: row.factoryId,
    agentId: row.agentId,
    name: row.name,
    command: row.command,
    repo: row.repo,
    folder: row.folder,
    allowedAt: row.allowedAt,
  }
}

function stored<T>(text: string | null): T | undefined {
  // SAFETY: this module writes these columns from values the request parsers already checked.
  return text === null ? undefined : (JSON.parse(text) as T)
}

export function createChatStore(options: {
  store: Store<typeof schema>
  commit: Store<typeof schema>['commit']
  changed: (chatId: string) => void
  runChanged: (runId: string) => void
}): ChatStore {
  const { store, commit } = options
  const running = new Map<string, ChatCommandItem>()
  const toRequest = (row: typeof chatRequests.Type): ChatRequest => {
    const choices = choicesOf(row.choices)
    const round = stored<Round>(row.round)
    const proposal = stored<Proposal>(row.proposal)
    const agentDraft = stored<AgentDraft>(row.agentDraft)
    const outsideCommand = stored<OutsideCommandAsk>(row.outsideCommand)
    const answer = stored<CommentAnswer>(row.answer)
    return {
      id: row.id,
      chatId: row.chatId,
      runId: row.runId,
      kind: isOneOf(row.kind, chatRequestKinds) ? row.kind : 'question',
      ...(row.title !== null && { title: row.title }),
      body: row.body,
      ...(choices && { choices }),
      ...(row.multiple && { multiple: true as const }),
      ...(round && { round }),
      ...(proposal && { proposal }),
      ...(agentDraft && { agentDraft }),
      ...(outsideCommand && { outsideCommand }),
      ...(answer && { answer }),
      createdAt: row.createdAt,
    }
  }
  const request = (id: string) => {
    const row = store.query(queryDb(chatRequests.where({ id }))).at(0)
    return row && toRequest(row)
  }
  return {
    agent(chatId) {
      const row = store.query(queryDb(chatAgents.where({ chatId }))).at(0)
      if (!row) return undefined
      const commands = commandsOf(row.commands)
      const outsideCommands = commandsOf(row.outsideCommands)
      return {
        id: row.agentId,
        name: row.name,
        source: isOneOf(row.source, layerKinds) ? row.source : 'ted',
        ...(isOneOf(row.agent, agentKinds) && { agent: row.agent }),
        ...(row.model !== null && { model: row.model }),
        powers: powersOf(row.powers),
        ...(commands && { commands }),
        ...(outsideCommands && { outsideCommands }),
        instructions: row.instructions,
      }
    },
    agentRecorded: chatAgentEvents,
    commandRan({ outside, ...ran }) {
      commit(
        events.chatCommandRan({
          ...ran,
          exitCode: ran.exitCode ?? null,
        }),
        ...(outside
          ? [events.chatOutsideCommandRan({ id: ran.id, outside: JSON.stringify(outside) })]
          : []),
      )
      if (running.get(ran.runId)?.id === ran.id) running.delete(ran.runId)
      options.runChanged(ran.runId)
    },
    commandRunning(runId, item) {
      if (item) running.set(runId, item)
      else running.delete(runId)
      options.runChanged(runId)
    },
    commands(runId) {
      const done = store
        .query(queryDb(chatCommands.where({ runId }).orderBy('startedAt', 'asc')))
        .map((row): ChatCommandItem => {
          const outside = outsideRunOf(row.outside)
          return {
            kind: 'command',
            id: row.id,
            name: row.name,
            ...(outside && { outside }),
            status: isOneOf(row.outcome, commandOutcomes) ? row.outcome : 'failed',
            ...(row.exitCode !== null && { exitCode: row.exitCode }),
            output: row.tail,
            at: row.startedAt,
            endedAt: row.endedAt,
          }
        })
      const live = running.get(runId)
      return live && !done.some((item) => item.id === live.id) ? [...done, live] : done
    },
    requests: (chatId) =>
      store
        .query(queryDb(chatRequests.where({ chatId }).orderBy('createdAt', 'asc')))
        .map(toRequest),
    request,
    post({ title, choices, multiple, round, proposal, agentDraft, outsideCommand, ...input }) {
      const id = randomUUID()
      commit(
        events.chatRequestPosted({
          ...input,
          id,
          title: title ?? null,
          choices: choices ?? null,
          multiple: multiple === true,
          round: round === undefined ? null : JSON.stringify(round),
          proposal: proposal === undefined ? null : JSON.stringify(proposal),
          at: new Date().toISOString(),
        }),
        ...(agentDraft === undefined
          ? []
          : [events.chatAgentDraftPosted({ id, draft: JSON.stringify(agentDraft) })]),
        ...(outsideCommand === undefined
          ? []
          : [events.chatOutsideCommandAsked({ id, ask: JSON.stringify(outsideCommand) })]),
      )
      options.changed(input.chatId)
      const posted = request(id)
      if (!posted) throw new Error(`no chat request ${id}`)
      return posted
    },
    answer(id, answer) {
      const found = request(id)
      if (!found) throw new Error(`no chat request ${id}`)
      commit(events.chatRequestAnswered({ id, answer: JSON.stringify(answer), at: answer.at }))
      options.changed(found.chatId)
      return request(id) ?? found
    },
    allowances: (factoryId) =>
      store
        .query(queryDb(outsideCommandAllowances.where({ factoryId }).orderBy('allowedAt', 'asc')))
        .map(allowanceOf),
    allowance(key) {
      const row = store.query(queryDb(outsideCommandAllowances.where({ ...key }))).at(0)
      return row && allowanceOf(row)
    },
    allow(key, allowed) {
      const before = store.query(queryDb(outsideCommandAllowances.where({ ...key }))).at(0)
      const id = before?.id ?? randomUUID()
      const at = new Date().toISOString()
      commit(events.outsideCommandAllowed({ id, ...key, ...allowed, at }))
      return { id, ...key, ...allowed, allowedAt: at }
    },
    removeAllowance(id) {
      commit(events.outsideCommandAllowanceRemoved({ id, at: new Date().toISOString() }))
    },
  }
}
