import { accessSync, constants, statSync } from 'node:fs'
import path from 'node:path'
import type { AgentKind } from '@ted/protocol'
import type { Agent } from './agent.ts'
import { claudeAgent } from './claude.ts'
import { codexAgent } from './codex.ts'

export type { Agent, AgentLaunch } from './agent.ts'

export interface Agents {
  get(kind: AgentKind): Agent
  installed(kind: AgentKind): boolean
  defaultLead(): AgentKind
}

export function createAgents(options: { claudeBin?: string; codexBin?: string }): Agents {
  const byKind: Record<AgentKind, Agent> = {
    claude: claudeAgent(options.claudeBin ?? 'claude'),
    codex: codexAgent(options.codexBin ?? 'codex'),
  }
  return {
    get: (kind) => byKind[kind],
    installed: (kind) => isInstalled(byKind[kind].binary),
    defaultLead: () =>
      !isInstalled(byKind.claude.binary) && isInstalled(byKind.codex.binary) ? 'codex' : 'claude',
  }
}

function isInstalled(binary: string): boolean {
  const candidates = binary.includes(path.sep)
    ? [binary]
    : (process.env.PATH ?? '')
        .split(path.delimiter)
        .filter(Boolean)
        .map((dir) => path.join(dir, binary))
  return candidates.some(isExecutableFile)
}

function isExecutableFile(file: string): boolean {
  try {
    accessSync(file, constants.X_OK)
    return statSync(file).isFile()
  } catch {
    return false
  }
}
