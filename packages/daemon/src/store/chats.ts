import { randomUUID } from 'node:crypto'
import { queryDb, type Store } from '@livestore/livestore'
import type {
  AgentChatKind,
  AgentDraft,
  ChatRequest,
  ChatRequestKind,
  CommentAnswer,
  LayerKind,
  Proposal,
  Round,
} from '@ted/protocol'
import { chatRequestKinds } from '@ted/protocol'
import { type AgentPower, agentPowers } from '@ted/protocol/agent-files'
import { isArray, isOneOf, isString, parseJson } from '@ted/protocol/parse'
import { type AgentKind, agentKinds } from '@ted/protocol/run'
import { chatAgents, chatRequests, events, type schema } from './schema.ts'

export interface StoredChatAgent {
  id: string
  name: string
  source: LayerKind
  agent?: AgentKind
  model?: string
  powers: AgentPower[]
  instructions: string
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
}

export interface ChatStore {
  agent(chatId: string): StoredChatAgent | undefined
  agentRecorded(
    chatId: string,
    kind: AgentChatKind,
    factoryId: string,
    agent: StoredChatAgent,
  ): ReturnType<typeof events.chatAgentRecorded>
  requests(chatId: string): ChatRequest[]
  request(id: string): ChatRequest | undefined
  post(input: NewChatRequest): ChatRequest
  answer(id: string, answer: CommentAnswer): ChatRequest
}

const layerKinds: readonly LayerKind[] = ['ted', 'library', 'factory']

function powersOf(text: string): AgentPower[] {
  const parsed = parseJson(text)
  return isArray(parsed) ? agentPowers.filter((power) => parsed.includes(power)) : []
}

function choicesOf(text: string | null): string[] | undefined {
  if (text === null) return undefined
  const parsed = parseJson(text)
  return isArray(parsed) ? parsed.filter(isString) : undefined
}

export function chatAgentEvent(
  chatId: string,
  kind: AgentChatKind,
  factoryId: string,
  agent: StoredChatAgent,
): ReturnType<typeof events.chatAgentRecorded> {
  return events.chatAgentRecorded({
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
}

function stored<T>(text: string | null): T | undefined {
  // SAFETY: this module writes these columns from values the request parsers already checked.
  return text === null ? undefined : (JSON.parse(text) as T)
}

export function createChatStore(options: {
  store: Store<typeof schema>
  commit: Store<typeof schema>['commit']
  changed: (chatId: string) => void
}): ChatStore {
  const { store, commit } = options
  const toRequest = (row: typeof chatRequests.Type): ChatRequest => {
    const choices = choicesOf(row.choices)
    const round = stored<Round>(row.round)
    const proposal = stored<Proposal>(row.proposal)
    const agentDraft = stored<AgentDraft>(row.agentDraft)
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
      return {
        id: row.agentId,
        name: row.name,
        source: isOneOf(row.source, layerKinds) ? row.source : 'ted',
        ...(isOneOf(row.agent, agentKinds) && { agent: row.agent }),
        ...(row.model !== null && { model: row.model }),
        powers: powersOf(row.powers),
        instructions: row.instructions,
      }
    },
    agentRecorded: chatAgentEvent,
    requests: (chatId) =>
      store
        .query(queryDb(chatRequests.where({ chatId }).orderBy('createdAt', 'asc')))
        .map(toRequest),
    request,
    post({ title, choices, multiple, round, proposal, agentDraft, ...input }) {
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
  }
}
