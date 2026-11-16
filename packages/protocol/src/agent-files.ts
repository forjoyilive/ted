import type { LayerKind } from './workflow.ts'

export const agentPowers = ['ask', 'manage_tasks', 'propose_tasks', 'read_code'] as const

export type AgentPower = (typeof agentPowers)[number]

export const agentPowerNames: Readonly<Record<AgentPower, string>> = {
  ask: 'Ask the user',
  manage_tasks: 'Manage Tasks',
  propose_tasks: 'Propose Tasks',
  read_code: 'Read the code',
}

export const builtInAgentIds = ['coordinator', 'planner'] as const

export type BuiltInAgentId = (typeof builtInAgentIds)[number]

export const maxAgentId = 40

export const maxAgentName = 60

export function isAgentId(id: string): boolean {
  return id.length <= maxAgentId && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)
}

export interface ResolvedAgent {
  id: string
  name: string
  agent?: string
  model?: string
  powers: AgentPower[]
  instructions: string
  source: LayerKind
  path: string
}
