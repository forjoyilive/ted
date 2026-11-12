import type { AgentKind, Effort, TaskLead } from '@ted/protocol'
import type { AgentChoice as ChoiceSetting, WorkflowSettings } from './check.ts'

export interface AgentChoices {
  lead: TaskLead
  reviewer: TaskLead
  planner: TaskLead
}

export function resolveAgentChoices(
  settings: Pick<WorkflowSettings, 'lead' | 'reviewer' | 'planner'> | undefined,
  installed: Partial<Record<AgentKind, boolean>>,
): AgentChoices {
  const fallback: AgentKind = !installed.claude && installed.codex ? 'codex' : 'claude'
  const lead = choice(settings?.lead, fallback)
  const other: AgentKind = lead.agent === 'claude' ? 'codex' : 'claude'
  const reviewerAgent = settings?.reviewer?.agent
  const reviewerDefault = installed.claude && installed.codex ? other : lead.agent
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
