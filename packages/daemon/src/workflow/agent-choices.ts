import { type AgentKind, agentKinds, type Effort, type TaskLead } from '@ted/protocol'
import type { AgentChoice as ChoiceSetting, WorkflowSettings } from './check.ts'

export interface AgentChoices {
  lead: TaskLead
  reviewer: TaskLead
  planner: TaskLead
}

export function resolveAgentChoices(
  settings: Pick<WorkflowSettings, 'lead' | 'reviewer' | 'planner'> | undefined,
  installed: Partial<Record<AgentKind, boolean>>,
  enabled: readonly AgentKind[] = agentKinds,
  paused: Partial<Record<AgentKind, string>> = {},
): AgentChoices {
  enabled = agentKinds.filter((kind) => enabled.includes(kind))
  const others = enabled.filter((kind) => kind !== 'pi')
  const piOnly = enabled.includes('pi') && installed.pi === true && paused.pi === undefined
  const fallback =
    others.find((kind) => installed[kind]) ??
    (piOnly ? 'pi' : (others[0] ?? enabled[0] ?? 'claude'))
  const lead = choice(settings?.lead, fallback)
  const other = others.find((kind) => kind !== lead.agent && installed[kind])
  const reviewerAgent = settings?.reviewer?.agent
  const reviewerDefault = other ?? (enabled.includes(lead.agent) ? lead.agent : fallback)
  return {
    lead,
    reviewer: choice(
      settings?.reviewer,
      reviewerAgent === 'same' ? lead.agent : reviewerDefault,
      reviewerAgent === 'same',
    ),
    planner: choice(settings?.planner, fallback),
  }
}

function choice(setting: ChoiceSetting | undefined, fallback: AgentKind, same = false): TaskLead {
  return {
    agent: same || setting?.agent === undefined ? fallback : (setting.agent as AgentKind),
    ...(setting?.model !== undefined && { model: setting.model }),
    ...(setting?.effort !== undefined && { effort: setting.effort as Effort }),
  }
}
