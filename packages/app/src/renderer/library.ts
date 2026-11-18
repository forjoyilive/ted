import type { LibraryChanges, LibraryView } from '@ted/protocol/factory-settings'
import type { AgentStageId, StageId } from '@ted/protocol/task'
import { agentDrafts } from './agent-files.ts'
import {
  type SettingsDraft,
  type StageDraft,
  settingsChanges,
  stageOptionsDraft,
} from './factory-settings.ts'

export const libraryLine =
  'Applies to every Factory that doesn’t override it, from each Task’s next Stage.'

export function libraryDraft(view: LibraryView): SettingsDraft {
  const stages: Partial<Record<StageId, StageDraft>> = {}
  const stageFiles: Partial<Record<AgentStageId, string | null>> = {}
  for (const row of view.stages) {
    stages[row.id] = {
      enabled: row.enabled,
      effort: row.effort ?? null,
      gate: row.gate,
      ...(row.maxBack !== undefined && { maxBack: row.maxBack }),
      ...(row.depth !== undefined && { depth: row.depth }),
      ...stageOptionsDraft(row),
    }
    if (row.id !== 'backlog' && row.id !== 'done') stageFiles[row.id] = row.libraryFile ?? null
  }
  const agents: SettingsDraft['agents'] = { lead: null, reviewer: null, planner: null }
  for (const row of view.agents) agents[row.role] = row.own ? { ...row.own } : null
  return {
    repos: [],
    stages,
    stageFiles,
    keepStageFiles: [],
    checks: [],
    instructionChecks: [],
    cleanup: { enabled: false, steps: [] },
    agents,
    agentFiles: agentDrafts(view.agentFiles),
    keepAgentFiles: [],
    permissions: 'auto',
    maxWorkingRuns: '',
    notes: '',
  }
}

export function libraryChanges(draft: SettingsDraft, loaded: SettingsDraft): LibraryChanges {
  const { stages, stageFiles, keepStageFiles, agentFiles, keepAgentFiles } = settingsChanges(
    draft,
    loaded,
  )
  return {
    ...(stages !== undefined && { stages }),
    ...(stageFiles !== undefined && { stageFiles }),
    ...(keepStageFiles !== undefined && { keepStageFiles }),
    ...(agentFiles !== undefined && { agentFiles }),
    ...(keepAgentFiles !== undefined && { keepAgentFiles }),
  }
}

export function unsavedLibrary(draft: SettingsDraft, loaded: SettingsDraft): number {
  const { stages, stageFiles, keepStageFiles, agentFiles, keepAgentFiles } = libraryChanges(
    draft,
    loaded,
  )
  let count =
    Object.keys(stageFiles ?? {}).length +
    (keepStageFiles?.length ?? 0) +
    (agentFiles?.length ?? 0) +
    (keepAgentFiles?.length ?? 0)
  for (const stage of Object.values(stages ?? {})) count += Object.keys(stage ?? {}).length
  return count
}

export function unsavedLibraryLine(count: number): string {
  return `${count} unsaved ${count === 1 ? 'change' : 'changes'} to the Library`
}
