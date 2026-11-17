import {
  type AgentFileChange,
  type AgentFileRow,
  type AgentSettingsInput,
  blankAgentInstructions,
  isAgentId,
  maxAgentId,
  maxAgentName,
} from '@ted/protocol/agent-files'
import type { AgentKind } from '@ted/protocol/run'

export interface AgentDraft {
  id: string
  added?: true
  settings: AgentSettingsInput | null
  instructions: string | null
}

export function agentDrafts(rows: readonly AgentFileRow[]): AgentDraft[] {
  return rows.flatMap((row) =>
    row.own
      ? [
          {
            id: row.id,
            settings: row.own.settings ? { ...row.own.settings } : null,
            instructions: row.own.instructions ?? null,
          },
        ]
      : [],
  )
}

function settingsKey(settings: AgentSettingsInput | null): string {
  if (!settings) return 'null'
  const name = settings.name?.trim()
  const model = settings.model?.trim()
  return JSON.stringify({
    name: name || undefined,
    agent: settings.agent,
    model: model || undefined,
    powers: settings.powers,
  })
}

function cleanSettings(settings: AgentSettingsInput | null): AgentSettingsInput | null {
  if (!settings) return null
  const name = settings.name?.trim()
  const model = settings.model?.trim()
  return {
    ...(name && { name }),
    ...(settings.agent && { agent: settings.agent }),
    ...(model && { model }),
    ...(settings.powers && { powers: settings.powers }),
  }
}

export function agentChanges(
  draft: readonly AgentDraft[],
  loaded: readonly AgentDraft[],
): AgentFileChange[] {
  const changes: AgentFileChange[] = []
  for (const agent of draft) {
    const before = loaded.find((a) => a.id === agent.id)
    const change: AgentFileChange = { id: agent.id }
    if (settingsKey(agent.settings) !== settingsKey(before?.settings ?? null)) {
      change.settings = cleanSettings(agent.settings)
    }
    if (agent.instructions !== (before?.instructions ?? null)) {
      change.instructions = agent.instructions
    }
    if (change.settings !== undefined || change.instructions !== undefined) changes.push(change)
  }
  for (const agent of loaded) {
    if (!draft.some((a) => a.id === agent.id)) {
      changes.push({ id: agent.id, settings: null, instructions: null })
    }
  }
  return changes
}

export function agentFileEdited(
  draft: readonly AgentDraft[],
  loaded: readonly AgentDraft[],
  id: string,
): boolean {
  const now = draft.filter((a) => a.id === id)
  const before = loaded.filter((a) => a.id === id)
  return agentChanges(now, before).length > 0
}

export function agentChangedFiles(changes: readonly AgentFileChange[], folder: string): string[] {
  const files = new Set<string>()
  for (const change of changes) {
    if (change.settings !== undefined || change.instructions === null) {
      files.add(`${folder}agents.yaml`)
    }
    if (change.instructions !== undefined) files.add(`${folder}agents/${change.id}.md`)
  }
  return [...files]
}

export function overrideDraft(row: AgentFileRow): AgentDraft {
  return {
    id: row.id,
    settings: row.inherited ? { ...row.inherited.settings } : null,
    instructions: row.inherited?.instructions ?? '',
  }
}

export function newAgentDraft(taken: readonly string[]): AgentDraft {
  let id = 'new-agent'
  for (let n = 2; taken.includes(id); n++) id = `new-agent-${n}`
  return {
    id,
    added: true,
    settings: { name: '', powers: [] },
    instructions: blankAgentInstructions,
  }
}

export function agentIdFrom(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxAgentId)
    .replace(/-+$/, '')
}

export function agentProblem(agent: AgentDraft, taken: readonly string[]): string | undefined {
  if (agent.added) {
    if (!isAgentId(agent.id)) {
      return `The id must be lowercase letters, digits and hyphens, up to ${maxAgentId} characters.`
    }
    if (taken.includes(agent.id)) return `Another Agent already uses the id ${agent.id}.`
  }
  const name = agent.settings?.name?.trim() ?? ''
  if (agent.added && name === '') return 'Give the Agent a name.'
  if (name.length > maxAgentName) return `The name can be up to ${maxAgentName} characters.`
  if (agent.instructions !== null && agent.instructions.trim() === '') {
    return 'The instructions can’t be empty.'
  }
  return undefined
}

export interface ResolvedChoice {
  agent?: AgentKind
  model?: string
}

export function resolvedChoice(
  own: AgentSettingsInput | null | undefined,
  inherited: AgentSettingsInput | undefined,
): ResolvedChoice {
  const agent = own?.agent ?? inherited?.agent
  const keepsModel = own?.agent === undefined || own.agent === inherited?.agent
  const model = own?.model ?? (keepsModel ? inherited?.model : undefined)
  return { ...(agent !== undefined && { agent }), ...(model !== undefined && { model }) }
}
