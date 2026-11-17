import type { RunSummary, TaskRun } from '@ted/protocol'

export function activeSubAgentCount(runs: readonly Pick<RunSummary, 'role' | 'state'>[]): number {
  return runs.filter((run) => run.role === 'sub-agent' && run.state !== 'finished').length
}

export function subAgentWorking(
  runs: readonly Pick<TaskRun, 'role' | 'state' | 'paused'>[],
): boolean {
  return runs.some((run) => run.role === 'sub-agent' && run.state === 'working' && !run.paused)
}

export function activeSubAgentLabel(count: number): string {
  return `${count} active ${count === 1 ? 'Sub-Agent' : 'Sub-Agents'}`
}

export function subAgentsRunningLabel(count: number): string {
  return `${count} ${count === 1 ? 'sub-agent' : 'sub-agents'} running`
}
