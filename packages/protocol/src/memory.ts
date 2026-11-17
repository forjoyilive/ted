import type { ProcessInfo, ProcessRun, ProcessRunRole } from './diagnostics.ts'
import { agentDisplayNames } from './health.ts'
import { shortReference } from './reference.ts'

export interface MemoryGroup {
  count: number
  bytes: number
}

export interface AgentRunCount {
  role: ProcessRunRole
  working: boolean
  count: number
}

export interface MemoryUse {
  daemon: { bytes: number; heapBytes: number; externalBytes: number }
  hosts: MemoryGroup
  agents: MemoryGroup
  agentRuns?: AgentRunCount[]
  agentTools: MemoryGroup
  checks: MemoryGroup
  apps: MemoryGroup
  other: MemoryGroup
  store: { eventLogBytes: number; stateBytes: number }
  app?: MemoryGroup
  asleepRuns?: number
}

export interface MemoryPart {
  label: string
  bytes: number
  count: number
}

const megabyte = 1024 * 1024
const gigabyte = 1024 * megabyte

export function memorySize(bytes: number): string {
  return bytes >= gigabyte
    ? `${(bytes / gigabyte).toFixed(1)} GB`
    : `${Math.round(bytes / megabyte)} MB`
}

export const daemonPartLabel = 'Daemon and Run hosts'
export const agentsPartLabel = 'Agents'

export function memoryParts(use: MemoryUse): MemoryPart[] {
  const part = (label: string, group: MemoryGroup | undefined): MemoryPart[] =>
    group && group.count > 0 ? [{ label, bytes: group.bytes, count: group.count }] : []
  return [
    ...part('Agents’ tools and MCP servers', use.agentTools),
    ...part(agentsPartLabel, use.agents),
    ...part('Checks', use.checks),
    ...part('Apps', use.apps),
    {
      label: daemonPartLabel,
      bytes: use.daemon.bytes + use.hosts.bytes,
      count: 1 + use.hosts.count,
    },
    ...part('Ted app', use.app),
    ...part('Other commands', use.other),
  ]
}

export function memoryTotal(use: MemoryUse): number {
  return memoryParts(use).reduce((sum, part) => sum + part.bytes, 0)
}

export function memoryProcessCount(use: MemoryUse): number {
  return memoryParts(use).reduce((sum, part) => sum + part.count, 0)
}

const agentKinds = [
  { roles: ['task-lead'], one: 'Task Lead', many: 'Task Leads' },
  { roles: ['sub-agent'], one: 'sub-agent', many: 'sub-agents' },
  { roles: ['coordinator', 'planning', 'side-chat'], one: 'chat', many: 'chats' },
  { roles: ['automation'], one: 'Automation', many: 'Automations' },
  { roles: ['run'], one: 'other Run', many: 'other Runs' },
] as const satisfies readonly {
  roles: readonly ProcessRunRole[]
  one: string
  many: string
}[]

export function agentBreakdown(use: MemoryUse): string[] {
  const runs = use.agentRuns ?? []
  const sum = (rows: readonly AgentRunCount[]) => rows.reduce((total, row) => total + row.count, 0)
  const kinds = agentKinds.flatMap(({ roles, one, many }) => {
    const count = sum(runs.filter((row) => roles.some((role) => role === row.role)))
    return count > 0 ? [`${count} ${count === 1 ? one : many}`] : []
  })
  const idle = sum(runs.filter((row) => !row.working))
  return idle > 0 ? [...kinds, `${idle} idle`] : kinds
}

export function memorySummary(use: MemoryUse): string {
  const agents = agentBreakdown(use)
  return [
    memorySize(memoryTotal(use)),
    ...memoryParts(use).map((part) =>
      part.label === agentsPartLabel && agents.length > 0
        ? `${part.label} ${memorySize(part.bytes)} (${agents.join(', ')})`
        : `${part.label} ${memorySize(part.bytes)}`,
    ),
    ...(use.asleepRuns
      ? [`${use.asleepRuns} ${use.asleepRuns === 1 ? 'Run' : 'Runs'} asleep`]
      : []),
  ].join(' · ')
}

function runName(run: ProcessRun): string {
  switch (run.role) {
    case 'task-lead':
      return run.task === undefined ? 'a Task Lead' : `${run.task}’s Task Lead`
    case 'sub-agent':
      return run.task === undefined ? 'a sub-agent' : `a sub-agent of ${run.task}`
    case 'coordinator':
      return 'a Coordinator chat'
    case 'planning':
      return 'a planning chat'
    case 'side-chat':
      return run.task === undefined ? 'a side chat' : `a side chat on ${run.task}`
    case 'automation':
      return 'an Automation'
    case 'run':
      return `Run ${shortReference(run.runId)}`
  }
}

export function processName(process: ProcessInfo): string {
  const { run } = process
  switch (process.kind) {
    case 'ted-app':
      return 'Ted app'
    case 'daemon':
      return 'Ted daemon'
    case 'run-host':
      return run ? `Run host of ${runName(run)}` : 'Run host'
    case 'agent':
      return run ? `${agentDisplayNames[run.agent]} agent of ${runName(run)}` : 'Agent'
    case 'agent-tool':
      return run ? `Tool or MCP server of ${runName(run)}` : 'Tool or MCP server of an agent'
    case 'check':
      return process.task === undefined ? 'Scheduled check' : `Check of ${process.task}`
    case 'app': {
      const app = process.appName === undefined ? 'App' : `App “${process.appName}”`
      return process.task === undefined ? app : `${app} of ${process.task}`
    }
    case 'other':
      return 'Other Ted command'
  }
}
