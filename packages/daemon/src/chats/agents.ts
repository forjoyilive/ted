import type { AgentChatKind, AgentSummary, ChatAgent } from '@ted/protocol'
import type { BuiltInAgentId, ResolvedAgent } from '@ted/protocol/agent-files'
import { RequestError } from '../errors.ts'
import type { StoredChatAgent } from '../store/chats.ts'
import { resolveAgents } from '../workflow/agent-files.ts'
import { sharedDefaultLayer } from '../workflow/layers.ts'

export function agentSummary(agent: ResolvedAgent | StoredChatAgent): AgentSummary {
  return {
    id: agent.id,
    name: agent.name,
    source: agent.source,
    ...(agent.agent !== undefined && { agent: agent.agent }),
    ...(agent.model !== undefined && { model: agent.model }),
    powers: [...agent.powers],
  }
}

export function storedAgent(agent: ResolvedAgent): StoredChatAgent {
  return { ...agentSummary(agent), instructions: agent.instructions }
}

export async function builtInAgents(): Promise<StoredChatAgent[]> {
  return resolveAgents([await sharedDefaultLayer()]).map(storedAgent)
}

export function builtInAgent(
  builtIns: readonly StoredChatAgent[],
  id: BuiltInAgentId,
): StoredChatAgent {
  const found = builtIns.find((agent) => agent.id === id)
  if (!found) throw new Error(`TED’s built-in ${id} Agent is missing`)
  return found
}

export function chatAgentView(
  agent: StoredChatAgent,
  current: readonly { id: string }[] | undefined,
): ChatAgent {
  return {
    ...agentSummary(agent),
    removed: current !== undefined && !current.some((a) => a.id === agent.id),
  }
}

export function removedRefusal(agent: Pick<StoredChatAgent, 'name'>): string {
  return `${agent.name} was removed from this Factory’s Agent files, so this chat takes no new messages. You can read, archive or delete it.`
}

export function pickAgent<T extends { id: string }>(
  agents: readonly T[],
  kind: AgentChatKind,
  id: string | undefined,
): T {
  const wanted = id ?? (kind === 'plan' ? 'planner' : 'coordinator')
  if (kind === 'plan' && wanted !== 'planner')
    throw new RequestError(400, 'A planning chat runs only the Planner')
  if (kind === 'coordinator' && wanted === 'planner')
    throw new RequestError(400, 'Start the Planner as a planning chat')
  const found = agents.find((agent) => agent.id === wanted)
  if (!found) throw new RequestError(404, `This Factory has no Agent \`${wanted}\``)
  return found
}
