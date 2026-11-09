import type { AgentKind } from '@ted/protocol'
import { findExecutable } from '../health/cli.ts'
import type { Agent } from './agent.ts'
import { claudeAgent } from './claude.ts'
import { codexAgent } from './codex.ts'

export type { Agent, AgentHealthSpec, AgentLaunch, AuthCheck } from './agent.ts'

export interface Agents {
  get(kind: AgentKind): Agent
  defaultLead(): AgentKind
}

export function createAgents(options: {
  claudeBin?: string
  codexBin?: string
  env?: () => NodeJS.ProcessEnv
}): Agents {
  const byKind: Record<AgentKind, Agent> = {
    claude: claudeAgent(options.claudeBin ?? 'claude'),
    codex: codexAgent(options.codexBin ?? 'codex'),
  }
  const env = options.env ?? (() => process.env)
  const installed = (kind: AgentKind) => findExecutable(byKind[kind].binary, env()) !== undefined
  return {
    get: (kind) => byKind[kind],
    defaultLead: () => (!installed('claude') && installed('codex') ? 'codex' : 'claude'),
  }
}
