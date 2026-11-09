import type { FixCommand } from './integrations.ts'
import type { AgentKind } from './run.ts'

export const agentProblem = 'agent-unavailable'

export const agentHealthStates = [
  'ready',
  'not-installed',
  'signed-out',
  'too-old',
  'wrong-credential',
] as const

export type AgentHealthState = (typeof agentHealthStates)[number]

export type AgentCredential = 'subscription' | 'api-key'

export interface AgentHealth {
  agent: AgentKind
  state: AgentHealthState
  minimumVersion: string
  version?: string
  path?: string
  account?: string
  credential?: AgentCredential
  apiKey?: string
  reason?: string
  fix?: FixCommand
  pausedRuns: number
  checkedAt: string
}

export const agentDisplayNames: Record<AgentKind, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
}

export function pausedReason(agent: AgentKind, state: AgentHealthState): string | undefined {
  const name = agentDisplayNames[agent]
  switch (state) {
    case 'ready':
      return undefined
    case 'not-installed':
      return `${name} isn’t installed`
    case 'signed-out':
      return `${name} is signed out`
    case 'too-old':
      return `${name} needs an update`
    case 'wrong-credential':
      return 'Using an API key, not your subscription'
  }
}

export function runsPaused(count: number): string {
  return `${count} ${count === 1 ? 'Run' : 'Runs'} paused`
}
