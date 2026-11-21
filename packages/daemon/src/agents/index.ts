import { type AgentKind, agentKinds } from '@ted/protocol'
import { findBinSync } from '../cli-env.ts'
import type { Agent } from './agent.ts'
import { antigravityAgent } from './antigravity.ts'
import { claudeAgent } from './claude.ts'
import { codexAgent } from './codex.ts'
import { piAgent } from './pi.ts'

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
  installedKinds(): Partial<Record<AgentKind, boolean>>
  savedModel(kind: AgentKind): string | undefined
  defaultLead(enabled?: readonly AgentKind[]): AgentKind
}

export function createAgents(options: {
  home?: string
  claudeBin?: string
  codexBin?: string
  antigravityBin?: string
  piBin?: string
  env?: () => NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}): Agents {
  const byKind: Record<AgentKind, Agent> = {
    claude: claudeAgent(options.claudeBin ?? 'claude', options.platform),
    codex: codexAgent(options.codexBin ?? 'codex', options.home, options.platform),
    antigravity: antigravityAgent(options.antigravityBin ?? 'agy'),
    pi: piAgent(options.piBin ?? 'pi', options.home),
  }
  const env = options.env ?? (() => process.env)
  const installed = (kind: AgentKind) => findBinSync(byKind[kind].binary, env()) !== undefined
  return {
    get: (kind) => byKind[kind],
    installed,
    installedKinds: () => Object.fromEntries(agentKinds.map((kind) => [kind, installed(kind)])),
    savedModel: (kind) => byKind[kind].savedModel?.(env()),
    defaultLead(enabled = agentKinds) {
      if (!installed('claude') && installed('codex')) return 'codex'
      if (
        !installed('claude') &&
        enabled.includes('pi') &&
        installed('pi') &&
        !agentKinds.some((kind) => kind !== 'pi' && enabled.includes(kind) && installed(kind))
      )
        return 'pi'
      return 'claude'
    },
  }
}
