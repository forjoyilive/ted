import type { AgentKind, ClarifyDepth, Priority, Task, TaskLead } from '@ted/protocol'

export const priorityLabels: Record<Priority, string> = {
  none: 'None',
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

export const clarifyDepthLabels: Record<ClarifyDepth, string> = {
  auto: 'Auto',
  none: 'None',
  few: 'Few',
  grilling: 'Grill',
}

export function clarifyDepthText(task: Pick<Task, 'clarifyDepth' | 'clarifyDepthBy'>): string {
  const label = clarifyDepthLabels[task.clarifyDepth]
  if (task.clarifyDepth === 'auto') return label
  if (task.clarifyDepthBy === 'task-lead') return `${label} · by the Task Lead`
  if (task.clarifyDepthBy === 'human') return `${label} · set by you`
  return label
}

export const agentLabels: Record<AgentKind, string> = {
  claude: 'Claude',
  codex: 'Codex',
}

export const modelChoices: Record<AgentKind, readonly string[]> = {
  claude: ['opus', 'sonnet', 'haiku'],
  codex: [],
}

export function leadSummary(lead: TaskLead): string {
  return [agentLabels[lead.agent], lead.model, lead.effort].filter(Boolean).join(' · ')
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
