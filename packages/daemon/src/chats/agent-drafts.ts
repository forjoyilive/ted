import { createHash } from 'node:crypto'
import {
  type AgentDraft,
  type AgentDraftFields,
  type AgentDraftInput,
  type AgentDraftPlace,
  settingsInput,
} from '@ted/protocol'
import {
  type AgentFileChange,
  type AgentFileRow,
  type AgentPower,
  agentPowerNames,
  type ResolvedAgent,
} from '@ted/protocol/agent-files'
import { RequestError } from '../errors.ts'
import type { FactorySettings } from '../factory-settings.ts'
import type { LibrarySettings } from '../library-settings.ts'
import { redactSecrets } from '../redact.ts'

const plannerOnlyLacks: readonly AgentPower[] = ['manage_tasks', 'manage_agents']

export function draftHash(agent: AgentDraftFields): string {
  return createHash('sha256')
    .update(JSON.stringify([agent.name, agent.instructions, agent.powers]))
    .digest('hex')
}

function fields(agent: ResolvedAgent): AgentDraftFields {
  return { name: agent.name, instructions: agent.instructions, powers: [...agent.powers] }
}

function plannerCheck(id: string, powers: readonly AgentPower[]): void {
  const barred = powers.filter((power) => plannerOnlyLacks.includes(power))
  if (id === 'planner' && barred.length > 0)
    throw new RequestError(
      400,
      `The Planner runs in planning chats, so it can’t have ${barred.map((p) => agentPowerNames[p]).join(' or ')}`,
    )
}

export function planDraft(input: AgentDraftInput, agents: readonly ResolvedAgent[]): AgentDraft {
  const found = agents.find((agent) => agent.id === input.id)
  if (input.change && !found)
    throw new RequestError(
      404,
      `This Factory has no Agent \`${input.id}\`; read them with ted coordinator agents`,
    )
  if (!input.change && found)
    throw new RequestError(
      409,
      `This Factory already has an Agent \`${input.id}\`; to change it, add "change": true`,
    )
  plannerCheck(input.id, input.powers)
  const draft: AgentDraft = {
    id: input.id,
    name: redactSecrets(input.name),
    instructions: redactSecrets(input.instructions),
    powers: input.powers,
    ...(found && { current: { ...fields(found), source: found.source, hash: draftHash(found) } }),
  }
  if (
    draft.current &&
    draft.current.name === draft.name &&
    draft.current.instructions === draft.instructions &&
    draft.current.powers.join() === draft.powers.join()
  )
    throw new RequestError(400, `Nothing in this draft differs from \`${input.id}\` as it is`)
  return draft
}

export function chosenDraft(draft: AgentDraft, answer: AgentDraftFields): AgentDraftFields {
  const added = answer.powers.find((power) => !draft.powers.includes(power))
  if (added !== undefined)
    throw new RequestError(
      400,
      `The draft doesn’t give ${agentPowerNames[added]}; add powers in settings after creating the Agent`,
    )
  plannerCheck(draft.id, answer.powers)
  return {
    name: redactSecrets(answer.name),
    instructions: redactSecrets(answer.instructions),
    powers: answer.powers,
  }
}

export function draftStillFits(draft: AgentDraft, agents: readonly ResolvedAgent[]): void {
  const found = agents.find((agent) => agent.id === draft.id)
  if (!draft.current && found)
    throw new RequestError(
      409,
      `An Agent \`${draft.id}\` was added since this draft; dismiss it and ask for a new one`,
    )
  if (draft.current && (!found || draftHash(found) !== draft.current.hash))
    throw new RequestError(
      409,
      `\`${draft.id}\` changed since this draft; dismiss it and ask for a new one`,
    )
}

export interface AgentFileTargets {
  library: Pick<LibrarySettings, 'view' | 'save'>
  factory: Pick<FactorySettings, 'view' | 'save'>
}

function change(id: string, row: AgentFileRow | undefined, chosen: AgentDraftFields) {
  const agentFiles: AgentFileChange[] = [
    {
      id,
      settings: { ...row?.own?.settings, name: chosen.name, powers: chosen.powers },
      instructions: chosen.instructions,
    },
  ]
  return { agentFiles }
}

export async function saveDraft(
  targets: AgentFileTargets,
  input: {
    where: AgentDraftPlace
    factoryId: string
    draft: AgentDraft
    chosen: AgentDraftFields
  },
): Promise<string> {
  const { where, factoryId, draft, chosen } = input
  const name = `“${chosen.name}”`
  if (where === 'library') {
    const view = await targets.library.view()
    const row = view.agentFiles.find((agent) => agent.id === draft.id)
    await targets.library.save({ changes: change(draft.id, row, chosen), version: view.version })
    const shadowed = draft.current?.source === 'factory'
    return `${draft.current ? 'Saved the change to' : 'Created'} ${name} in the Library.${shadowed ? ' This Factory’s own copy of the Agent still applies here.' : ''}`
  }
  const view = await targets.factory.view(factoryId, { refresh: 'first' })
  const row = view.agentFiles.find((agent) => agent.id === draft.id)
  const saved = await targets.factory.save(factoryId, {
    changes: { repos: view.repos.map(settingsInput), ...change(draft.id, row, chosen) },
    mode: 'pull-request',
    version: view.version,
  })
  return `Opened a settings pull request: ${saved.pullRequest.url}. ${name} ${draft.current ? 'changes' : 'is available'} once it merges.`
}
