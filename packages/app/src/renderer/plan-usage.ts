import type { AgentHealth, AgentKind, Billing, PlanWindow } from '@ted/protocol'
import { planWarnPercent } from '@ted/protocol/health'
import { agentKinds } from '@ted/protocol/run'

export const usageWindowNames: Record<PlanWindow['window'], string> = {
  'five-hour': '5-hour window',
  weekly: 'Weekly',
}

export function usageWindows(health: AgentHealth | undefined, billing: Billing): PlanWindow[] {
  if (billing === 'api-key') return []
  return (health?.planUsage?.windows ?? [])
    .filter((window) => Number.isFinite(window.percent) && window.percent >= 0)
    .sort((a, b) => a.window.localeCompare(b.window))
}

export function fullestWindow(windows: readonly PlanWindow[]): PlanWindow | undefined {
  return [...windows].sort((a, b) => b.percent - a.percent || a.window.localeCompare(b.window))[0]
}

export function usageReset(at: string | undefined, now: number): string | undefined {
  if (at === undefined || !Number.isFinite(Date.parse(at))) return undefined
  const minutes = Math.ceil((Date.parse(at) - now) / 60_000)
  if (minutes <= 0) return 'Awaiting update'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

export function usageTone(percent: number | undefined): 'ok' | 'warn' | 'full' {
  if (percent !== undefined && percent >= 100) return 'full'
  if (percent !== undefined && percent >= planWarnPercent) return 'warn'
  return 'ok'
}

export function usageEmpty(agent: AgentKind, billing: Billing): string {
  if (billing === 'api-key') return 'Subscription usage isn’t available with API key billing.'
  if (agent === 'antigravity')
    return 'Usage figures are unavailable unless reported by Antigravity.'
  return agent === 'claude'
    ? 'Shows once a Run has made a request.'
    : 'Shows once a Run has started.'
}

export function usageAgents(
  health: readonly AgentHealth[],
  enabled: readonly AgentKind[],
): AgentKind[] {
  return agentKinds.filter(
    (agent) =>
      enabled.includes(agent) &&
      health.find((known) => known.agent === agent)?.state !== 'not-installed',
  )
}
