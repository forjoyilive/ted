import type { AgentStageId, LayerKind, StageDrift } from '@ted/protocol'
import { agentStageIds } from '@ted/protocol'
import { fileChange } from '@ted/protocol/diff'
import type { SeenStageFile } from '../store/index.ts'
import { resolveAgents } from './agent-files.ts'
import type { CheckedLayer } from './check.ts'
import { stageFileHash } from './layers.ts'
import { resolveWorkflow } from './resolve.ts'

export interface FoundDrift {
  stage: AgentStageId
  basedOn: string
  current: string
  layer: LayerKind
  inherited: string
  own: string
}

export function findDrift(inherited: readonly CheckedLayer[], own: CheckedLayer): FoundDrift[] {
  const resolved = resolveWorkflow([...inherited])
  return agentStageIds.flatMap((stage) => {
    const text = own.stageFiles[stage]
    const basedOn = own.settings.stages[stage]?.based_on
    const from = resolved.stageFile(stage)
    if (typeof text !== 'string' || basedOn === undefined || !from) return []
    const current = stageFileHash(from.text)
    if (current === basedOn) return []
    return [{ stage, basedOn, current, layer: from.layer, inherited: from.text, own: text }]
  })
}

export interface FoundAgentDrift {
  agent: string
  basedOn: string
  current: string
  layer: LayerKind
  inherited: string
  own: string
}

export function findAgentDrift(
  inherited: readonly CheckedLayer[],
  own: CheckedLayer,
): FoundAgentDrift[] {
  const below = resolveAgents(inherited)
  return Object.entries(own.agentFiles).flatMap(([agent, text]) => {
    const basedOn = own.agentSettings[agent]?.based_on
    const from = below.find((a) => a.id === agent)
    if (basedOn === undefined || !from) return []
    const current = stageFileHash(from.instructions)
    if (current === basedOn) return []
    return [
      { agent, basedOn, current, layer: from.source, inherited: from.instructions, own: text },
    ]
  })
}

export function driftCount(inherited: readonly CheckedLayer[], own: CheckedLayer): number {
  return findDrift(inherited, own).length + findAgentDrift(inherited, own).length
}

export function driftView(
  found: FoundDrift,
  seen: (hash: string) => SeenStageFile | undefined,
): StageDrift {
  const old = seen(found.basedOn)
  const changedIn = found.layer === 'ted' ? seen(found.current)?.tedVersion : undefined
  return {
    basedOn: found.basedOn,
    current: found.current,
    layer: found.layer,
    ...(changedIn !== undefined && { changedIn }),
    diffOf: old ? 'inherited' : 'yours',
    diff: fileChange(`${found.stage}.md`, old ? old.text : found.own, found.inherited).lines,
  }
}

export function rememberLayer(
  layer: CheckedLayer,
  tedVersion: string,
  remember: (seen: SeenStageFile) => void,
): void {
  for (const [stage, text] of Object.entries(layer.stageFiles) as [AgentStageId, string][]) {
    if (typeof text !== 'string') continue
    remember({ hash: stageFileHash(text), layer: layer.kind, stage, text, tedVersion })
  }
}
