import type { AgentKind, LayerKind } from '@ted/protocol'
import {
  type AgentCommand,
  type AgentFileChange,
  type AgentFileRow,
  type AgentSettingsInput,
  builtInAgentIds,
  type ResolvedAgent,
} from '@ted/protocol/agent-files'
import { isOneOf, isString } from '@ted/protocol/parse'
import { agentKinds } from '@ted/protocol/run'
import { Document, isMap, isScalar, parseDocument, YAMLMap, YAMLSeq } from 'yaml'
import { type AgentLayer, type AgentSettings, resolveAgents } from './agent-files.ts'
import type { CheckedLayer, LayerFiles } from './check.ts'
import { agentDriftView, findAgentDrift } from './drift.ts'
import { stageFileHash } from './layers.ts'

export interface AgentFileChanges {
  agentFiles?: readonly AgentFileChange[]
  keepAgentFiles?: readonly string[]
}

const settingKeys = [
  'name',
  'agent',
  'model',
  'powers',
  'commands',
  'outside_commands',
  'based_on',
] as const

export function applyAgentChanges(
  after: LayerFiles,
  changes: AgentFileChanges,
  below: readonly ResolvedAgent[],
): void {
  const edits = changes.agentFiles ?? []
  const keep = changes.keepAgentFiles ?? []
  if (edits.length === 0 && keep.length === 0) return
  const text = after['agents.yaml']
  const doc = !isString(text) || text.trim() === '' ? new Document() : parseDocument(text)
  const root = isMap(doc.contents) ? doc.contents : new YAMLMap()
  doc.contents = root
  const basedOn = new Map<string, string | null>()

  for (const change of edits) {
    const { id } = change
    const file = `agents/${id}.md`
    const from = below.find((agent) => agent.id === id)
    if (change.instructions === null) {
      delete after[file]
      basedOn.set(id, null)
    } else if (change.instructions !== undefined) {
      if (!isString(after[file]) && from) {
        basedOn.set(id, stageFileHash(from.instructions))
      }
      after[file] = change.instructions
    }
    if (change.settings === null) root.delete(id)
    else if (change.settings !== undefined) writeSettings(root, id, change.settings)
  }
  for (const id of keep) {
    const from = below.find((agent) => agent.id === id)
    if (isString(after[`agents/${id}.md`]) && from && !basedOn.has(id)) {
      basedOn.set(id, stageFileHash(from.instructions))
    }
  }
  for (const [id, hash] of basedOn) {
    const entry = root.get(id, true)
    if (hash === null) {
      if (isMap(entry)) entry.delete('based_on')
    } else if (isMap(entry)) {
      setOrdered(entry, 'based_on', hash)
    } else {
      const map = new YAMLMap()
      map.set('based_on', hash)
      root.set(id, map)
    }
    const kept = root.get(id, true)
    if (isMap(kept) && kept.items.length === 0) root.delete(id)
  }
  if (root.items.length === 0) delete after['agents.yaml']
  else after['agents.yaml'] = doc.toString({ lineWidth: 0, flowCollectionPadding: false })
}

function writeSettings(root: YAMLMap, id: string, input: AgentSettingsInput): void {
  const found = root.get(id, true)
  let map = new YAMLMap()
  if (isMap(found)) map = found
  else root.set(id, map)
  const values: [string, string | readonly string[] | undefined][] = [
    ['name', input.name],
    ['agent', input.agent],
    ['model', input.model],
    ['powers', input.powers],
  ]
  for (const [key, value] of values) {
    if (value === undefined) map.delete(key)
    else if (isString(value)) setOrdered(map, key, value)
    else {
      const seq = new YAMLSeq()
      seq.flow = true
      for (const item of value) seq.add(item)
      setOrdered(map, key, seq)
    }
  }
  if (input.commands === undefined || input.commands.length === 0) map.delete('commands')
  else setOrdered(map, 'commands', commandsMap(input.commands))
  if (input.outsideCommands === undefined || input.outsideCommands.length === 0)
    map.delete('outside_commands')
  else setOrdered(map, 'outside_commands', commandsMap(input.outsideCommands))
}

function commandsMap(commands: readonly AgentCommand[]): YAMLMap {
  const map = new YAMLMap()
  for (const { name, command, repo } of commands) {
    if (repo === undefined) map.set(name, command)
    else {
      const entry = new YAMLMap()
      entry.set('command', command)
      entry.set('repo', repo)
      map.set(name, entry)
    }
  }
  return map
}

function setOrdered(map: YAMLMap, key: string, value: string | YAMLSeq | YAMLMap): void {
  const node = map.get(key, true)
  if (isScalar(node) && isString(value)) {
    if (node.value !== value) node.value = value
    return
  }
  if (map.has(key)) return void map.set(key, value)
  map.set(key, value)
  const rank = settingKeys.findIndex((k) => k === key)
  const added = map.items.pop()
  if (!added) return
  const before = map.items.findIndex((pair) => {
    const other = isScalar(pair.key) ? String(pair.key.value) : ''
    return settingKeys.findIndex((k) => k === other) > rank
  })
  if (before === -1) map.items.push(added)
  else map.items.splice(before, 0, added)
}

export function agentFileRows(
  inherited: readonly CheckedLayer[],
  own: CheckedLayer,
): AgentFileRow[] {
  const below = resolveAgents(inherited)
  const all = resolveAgents([...inherited, own])
  const drifts = findAgentDrift(inherited, own)
  const order = (agent: ResolvedAgent) => {
    const builtIn = builtInAgentIds.findIndex((id) => id === agent.id)
    return builtIn === -1 ? builtInAgentIds.length : builtIn
  }
  return all
    .slice()
    .sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name))
    .map((agent) => {
      const settings = own.agentSettings[agent.id]
      const instructions = own.agentFiles[agent.id]
      const from = below.find((a) => a.id === agent.id)
      const drift = drifts.find((d) => d.agent === agent.id)
      const ownSettings = settings && settingsInput(settings)
      return {
        id: agent.id,
        name: agent.name,
        ...(isOneOf(agent.agent, agentKinds) && { agent: agent.agent }),
        ...(agent.model !== undefined && { model: agent.model }),
        powers: agent.powers,
        ...(agent.commands && { commands: agent.commands }),
        ...(agent.outsideCommands && { outsideCommands: agent.outsideCommands }),
        from: agent.source,
        builtIn: builtInAgentIds.some((id) => id === agent.id),
        ...((settings !== undefined || instructions !== undefined) && {
          own: {
            ...(ownSettings && { settings: ownSettings }),
            ...(instructions !== undefined && { instructions }),
            ...(settings?.based_on !== undefined && { basedOn: settings.based_on }),
          },
        }),
        ...(from && {
          inherited: {
            layer: inheritedLayer(inherited, agent.id, from.source),
            settings: resolvedInput(from),
            instructions: from.instructions,
          },
        }),
        ...(drift && { drift: agentDriftView(drift) }),
      }
    })
}

function inheritedLayer(layers: readonly AgentLayer[], id: string, fallback: LayerKind): LayerKind {
  const found = layers
    .slice()
    .reverse()
    .find((layer) => Object.hasOwn(layer.agentSettings, id) || Object.hasOwn(layer.agentFiles, id))
  return found?.kind ?? fallback
}

function settingsInput(settings: AgentSettings): AgentSettingsInput {
  const agent: AgentKind | undefined = isOneOf(settings.agent, agentKinds)
    ? settings.agent
    : undefined
  return {
    ...(settings.name !== undefined && { name: settings.name }),
    ...(agent !== undefined && { agent }),
    ...(settings.model !== undefined && { model: settings.model }),
    ...(settings.powers !== undefined && { powers: settings.powers }),
    ...(settings.commands !== undefined && { commands: settings.commands }),
    ...(settings.outside_commands !== undefined && { outsideCommands: settings.outside_commands }),
  }
}

function resolvedInput(agent: ResolvedAgent): AgentSettingsInput {
  return {
    name: agent.name,
    ...(isOneOf(agent.agent, agentKinds) && { agent: agent.agent }),
    ...(agent.model !== undefined && { model: agent.model }),
    powers: agent.powers,
    ...(agent.commands && { commands: agent.commands }),
    ...(agent.outsideCommands && { outsideCommands: agent.outsideCommands }),
  }
}
