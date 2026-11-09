import type { AgentKind } from '@ted/protocol'
import { findBinSync } from '../cli-env.ts'
import type { Agent } from './agent.ts'
import { claudeAgent } from './claude.ts'
import { codexAgent } from './codex.ts'

export type {
  Agent,
  AgentChatEntry,
  AgentHealthSpec,
  AgentLaunch,
  AuthCheck,
} from './agent.ts'

export interface Agents {
  get(kind: AgentKind): Agent
  installed(kind: AgentKind): boolean
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
  const installed = (kind: AgentKind) => findBinSync(byKind[kind].binary, env()) !== undefined
  return {
    get: (kind) => byKind[kind],
    installed,
    defaultLead: () => (!installed('claude') && installed('codex') ? 'codex' : 'claude'),
  }
}
