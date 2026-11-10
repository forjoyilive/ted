import type { RunSummary } from '@ted/protocol'

export function activeSubAgentCount(runs: readonly Pick<RunSummary, 'role' | 'state'>[]): number {
  return runs.filter((run) => run.role === 'sub-agent' && run.state !== 'finished').length
}

export function activeSubAgentLabel(count: number): string {
  return `${count} active ${count === 1 ? 'sub-agent' : 'sub-agents'}`
}
