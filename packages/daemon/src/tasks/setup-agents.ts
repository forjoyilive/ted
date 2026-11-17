import type { AgentCommand } from '@ted/protocol/agent-files'
import type { SetupAgentProposal } from '@ted/protocol/setup-agents'
import type { CheckedLayer } from '../workflow/check.ts'

export type AgentLayerRead = Pick<CheckedLayer, 'files' | 'agentSettings' | 'agentFiles'>

export function setupAgentDifferences(
  approved: readonly SetupAgentProposal[],
  layer: AgentLayerRead,
  inherited: readonly string[],
): string[] {
  const wanted = new Map(approved.map((agent) => [agent.id, agent]))
  const differences: string[] = approved.flatMap((agent) =>
    inherited.includes(agent.id)
      ? [
          `${agent.id} is already defined in TED’s defaults or the Library; a setup Agent needs an id of its own`,
        ]
      : [],
  )
  const written = new Set([
    ...Object.keys(layer.agentSettings),
    ...Object.keys(layer.files).flatMap((file) => {
      const match = /^agents\/(.+)\.md$/.exec(file)
      return match?.[1] === undefined ? [] : [match[1]]
    }),
  ])
  if (approved.length === 0 && layer.files['agents.yaml'] !== undefined) {
    differences.push('.ted/agents.yaml is on the branch, but the approved proposal has no Agents')
  }
  for (const file of Object.keys(layer.files)) {
    if (file.startsWith('agents/') && !/^agents\/[^/]+\.md$/.test(file)) {
      differences.push(`.ted/${file} isn’t part of the approved Agents`)
    }
  }
  for (const id of [...written].sort()) {
    if (!wanted.has(id)) differences.push(`${id} is on the branch but not in the approved proposal`)
  }
  for (const agent of approved) {
    const settings = layer.agentSettings[agent.id]
    const instructions = layer.agentFiles[agent.id]
    if (settings === undefined) {
      differences.push(`${agent.id} is approved but missing from .ted/agents.yaml`)
      continue
    }
    if (settings.name !== agent.name) {
      differences.push(`${agent.id}’s name is ${quoted(settings.name)}, not “${agent.name}”`)
    }
    const powers = [...(settings.powers ?? [])].sort()
    if (powers.join(',') !== [...agent.powers].sort().join(',')) {
      differences.push(
        `${agent.id}’s powers are ${list(powers)}, but the approved proposal gives ${list(agent.powers)}`,
      )
    }
    if (commandKey(settings.commands) !== commandKey(agent.commands)) {
      const commands = commandLines(settings.commands)
      differences.push(
        `${agent.id}’s commands are ${commands || 'none'}, but the approved proposal gives ${commandLines(agent.commands) || 'none'}`,
      )
    }
    if (settings.agent !== agent.agent) {
      differences.push(
        `${agent.id}’s Provider is ${quoted(settings.agent)}, not ${quoted(agent.agent)}`,
      )
    }
    if (settings.model !== agent.model) {
      differences.push(
        `${agent.id}’s model is ${quoted(settings.model)}, not ${quoted(agent.model)}`,
      )
    }
    if (instructions === undefined) {
      differences.push(`${agent.id} is approved but .ted/agents/${agent.id}.md is missing`)
    } else if (instructions.trimEnd() !== agent.instructions.trimEnd()) {
      differences.push(`.ted/agents/${agent.id}.md differs from the approved instructions`)
    }
  }
  return differences
}

function sortedCommands(commands: readonly AgentCommand[] | undefined): AgentCommand[] {
  return [...(commands ?? [])].sort((a, b) => a.name.localeCompare(b.name))
}

function commandKey(commands: readonly AgentCommand[] | undefined): string {
  return JSON.stringify(sortedCommands(commands).map((c) => [c.name, c.command, c.repo ?? null]))
}

function commandLines(commands: readonly AgentCommand[] | undefined): string {
  return sortedCommands(commands)
    .map((c) => `${c.name}: ${c.command}${c.repo === undefined ? '' : ` (in ${c.repo})`}`)
    .join('; ')
}

function quoted(value: string | undefined): string {
  return value === undefined ? 'not set' : `“${value}”`
}

function list(powers: readonly string[]): string {
  return powers.length === 0 ? 'none' : powers.join(', ')
}
