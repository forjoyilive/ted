import type { StageDrift } from './factory-settings.ts'
import type { AgentKind } from './run.ts'
import type { LayerKind } from './workflow.ts'

export const agentPowers = [
  'ask',
  'manage_tasks',
  'manage_automations',
  'propose_tasks',
  'read_code',
  'manage_agents',
] as const

export type AgentPower = (typeof agentPowers)[number]

export const agentPowerNames: Readonly<Record<AgentPower, string>> = {
  ask: 'Ask the user',
  manage_tasks: 'Manage Tasks',
  manage_automations: 'Manage Automations',
  propose_tasks: 'Propose Tasks',
  read_code: 'Read the code',
  manage_agents: 'Manage Agents',
}

export const builtInAgentIds = ['coordinator', 'planner'] as const

export type BuiltInAgentId = (typeof builtInAgentIds)[number]

export const maxAgentId = 40

export const maxAgentName = 60

export const maxAgentDraftInstructions = 20_000

export function isAgentId(id: string): boolean {
  return id.length <= maxAgentId && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)
}

export interface ResolvedAgent {
  id: string
  name: string
  agent?: AgentKind
  model?: string
  powers: AgentPower[]
  instructions: string
  source: LayerKind
  path: string
}

export const agentPowerHelp: Readonly<Record<AgentPower, string>> = {
  ask: 'Questions and rounds that show in the Inbox.',
  manage_tasks:
    'Create, start, move and answer Tasks in this Factory, as the Coordinator does. Archives and deletes wait for your confirmation.',
  manage_automations:
    'Read this Factory’s Automations and draft new ones, changes and deletes. Each draft waits for you to create, save or delete it.',
  propose_tasks: 'A set of Tasks with blockers for you to approve, as the Planner does.',
  read_code:
    'A fresh copy of the default branch for each chat. It is never pushed and is removed when the chat is archived.',
  manage_agents:
    'Drafts of new Agents and changes to Agents, shown as a card. Nothing is saved until you click Create.',
}

export const blankAgentInstructions = `# What this Agent is for

Say in a few sentences what this Agent helps with and when to start a chat with it.

## How it works

- What it should look at first.
- What it should ask you before it acts.
- What a good answer from it looks like.

TED adds the commands its powers allow, so you don’t need to list them here.
`

export interface AgentSettingsInput {
  name?: string
  agent?: AgentKind
  model?: string
  powers?: AgentPower[]
}

export interface AgentFileChange {
  id: string
  settings?: AgentSettingsInput | null
  instructions?: string | null
}

export interface AgentFileRow {
  id: string
  name: string
  agent?: AgentKind
  model?: string
  powers: AgentPower[]
  from: LayerKind
  builtIn: boolean
  own?: { settings?: AgentSettingsInput; instructions?: string; basedOn?: string }
  inherited?: { layer: LayerKind; settings: AgentSettingsInput; instructions: string }
  drift?: StageDrift
}
