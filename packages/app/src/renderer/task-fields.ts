import type { AgentKind, ClarifyDepth, Priority, Task, TaskLead } from '@ted/protocol'
import { defaultModelChoices } from '@ted/protocol/task'

export const modelChoices = defaultModelChoices

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
  antigravity: 'Antigravity',
  pi: 'Pi',
}

export function modelOptions(
  agent: string | undefined,
  value: string | undefined,
  extra: readonly (string | undefined)[] = [],
  listed: readonly string[] = agent !== undefined && Object.hasOwn(modelChoices, agent)
    ? modelChoices[agent as AgentKind]
    : [],
): string[] {
  return [...new Set([...listed, ...extra, value].filter((model): model is string => !!model))]
}

export function leadSummary(lead: TaskLead): string {
  return [
    agentLabels[lead.agent],
    lead.model,
    lead.effortMode === 'stage' ? 'Follow Stage settings' : lead.effort,
  ]
    .filter(Boolean)
    .join(' · ')
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function withoutStageName(activity: string, stage: string): string {
  const prefix = `${stage}:`
  if (!activity.toLowerCase().startsWith(prefix.toLowerCase())) return activity
  const rest = activity.slice(prefix.length).trimStart()
  return rest === '' ? activity : rest.charAt(0).toUpperCase() + rest.slice(1)
}
