import type { AgentKind } from './run.ts'

export interface AgentApiCost {
  agent: AgentKind
  runs: number
  pricedRuns: number
  cost: number
  input: number
  output: number
}

export interface ApiCostReport {
  days: number
  since: string
  countedFrom?: string
  agents: AgentApiCost[]
}
