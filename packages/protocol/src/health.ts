import type { FixCommand } from './integrations.ts'
import type { AgentKind } from './run.ts'

export const agentProblem = 'agent-unavailable'

export const usageLimitProblem = 'agent-usage-limit'

export const offlineProblem = 'offline'

export const agentHealthStates = [
  'ready',
  'not-installed',
  'signed-out',
  'too-old',
  'wrong-credential',
  'usage-limit',
  'offline',
] as const

export type AgentHealthState = (typeof agentHealthStates)[number]

export const billings = ['subscription', 'api-key'] as const

export type Billing = (typeof billings)[number]

export const billingNames: Record<Billing, string> = {
  subscription: 'Subscription',
  'api-key': 'API key',
}

export const planWindows = ['five-hour', 'weekly'] as const

export type PlanWindowKind = (typeof planWindows)[number]

export interface PlanWindow {
  window: PlanWindowKind
  percent: number
  resetsAt?: string
}

export interface PlanUsage {
  windows: PlanWindow[]
  at: string
  from: 'run' | 'read'
}

export const planWarnPercent = 85

export interface AgentHealth {
  agent: AgentKind
  state: AgentHealthState
  minimumVersion: string
  version?: string
  path?: string
  account?: string
  reason?: string
  fix?: FixCommand
  limitResetsAt?: string
  keySource?: string
  planUsage?: PlanUsage
  pausedRuns: number
  checkedAt: string
}

export const agentDisplayNames: Record<AgentKind, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
}

export const agentShortNames: Record<AgentKind, string> = {
  claude: 'Claude',
  codex: 'Codex',
}

const twoDigits = (n: number) => String(n).padStart(2, '0')

const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function resetTime(at: string, now: Date = new Date()): string {
  const when = new Date(at)
  const clock = `${twoDigits(when.getHours())}:${twoDigits(when.getMinutes())}`
  const soon = when.getTime() - now.getTime() < 12 * 60 * 60 * 1000
  return when.toDateString() === now.toDateString() || soon
    ? clock
    : `${weekdays[when.getDay()]} ${clock}`
}

export function usageLimitText(agent: AgentKind, resetsAt: string | undefined, now?: Date): string {
  const name = `${agentShortNames[agent]} usage limit`
  return resetsAt === undefined ? name : `${name}, resets ${resetTime(resetsAt, now)}`
}

export function pausedReason(
  agent: AgentKind,
  state: AgentHealthState,
  resetsAt?: string,
): string | undefined {
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
    case 'usage-limit':
      return usageLimitText(agent, resetsAt)
    case 'offline':
      return 'offline'
  }
}

export function runsPaused(count: number): string {
  return `${count} ${count === 1 ? 'Run' : 'Runs'} paused`
}

export function planChip(health: AgentHealth, now?: Date): string | undefined {
  if (health.state === 'usage-limit') return undefined
  const top = (health.planUsage?.windows ?? [])
    .filter((w) => w.percent >= planWarnPercent)
    .sort((a, b) => b.percent - a.percent)[0]
  if (!top) return undefined
  const resets = top.resetsAt !== undefined ? ` · resets ${resetTime(top.resetsAt, now)}` : ''
  return `${agentShortNames[health.agent]} ${Math.round(top.percent)}%${resets}`
}
