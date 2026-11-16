import { isModelName, type LayerKind, type WorkflowProblem } from '@ted/protocol'
import {
  type AgentPower,
  agentPowers,
  isAgentId,
  maxAgentId,
  maxAgentName,
  type ResolvedAgent,
} from '@ted/protocol/agent-files'
import { isOneOf, isString } from '@ted/protocol/parse'
import { agentKindList, agentKinds } from '@ted/protocol/run'
import { isMap, isScalar, isSeq, LineCounter, type Node, parseDocument } from 'yaml'
import { displayPath } from './display-path.ts'

export interface AgentSettings {
  name?: string
  agent?: string
  model?: string
  powers?: AgentPower[]
  based_on?: string
}

export type AgentSettingsById = Record<string, AgentSettings>

export interface InheritedAgents {
  defined: readonly string[]
  instructed: readonly string[]
}

export interface AgentLayer {
  kind: LayerKind
  agentSettings: Readonly<Record<string, AgentSettings>>
  agentFiles: Readonly<Record<string, string>>
}

const agentKeys = ['name', 'agent', 'model', 'powers', 'based_on']
const idRule = `lowercase letters, digits and hyphens, up to ${maxAgentId} characters`
const powerList = agentPowers.join(', ')

export function agentFileId(file: string): string | undefined {
  const match = /^agents\/(.+)\.md$/.exec(file)
  const id = match?.[1]
  return id !== undefined && isAgentId(id) ? id : undefined
}

export function inheritedAgents(below: readonly AgentLayer[]): InheritedAgents {
  const defined = new Set<string>()
  const instructed = new Set<string>()
  for (const layer of below) {
    for (const id of Object.keys(layer.agentSettings)) defined.add(id)
    for (const id of Object.keys(layer.agentFiles)) instructed.add(id)
  }
  return { defined: [...defined], instructed: [...instructed] }
}

export function checkAgentFiles(input: {
  kind: LayerKind
  files: Readonly<Record<string, string | null>>
  inherited: InheritedAgents
  problems: WorkflowProblem[]
}): Pick<AgentLayer, 'agentSettings' | 'agentFiles'> {
  const { kind, files, inherited, problems } = input
  const yamlFile = displayPath(kind, 'agents.yaml')
  const text = files['agents.yaml']
  const listed = new Map<string, Node | null>()
  let agentSettings: AgentSettingsById = {}
  if (text === null) {
    problems.push(at(yamlFile, 'TED couldn’t read agents.yaml'))
  } else if (text !== undefined) {
    agentSettings = Object.fromEntries(checkAgentsYaml(text, yamlFile, inherited, problems, listed))
  }

  if (files.agents === null) {
    problems.push(at(displayPath(kind, 'agents'), 'TED couldn’t read the agents folder'))
  }
  const agentFiles: Record<string, string> = {}
  for (const [file, body] of Object.entries(files)) {
    if (!file.startsWith('agents/')) continue
    const where = at(displayPath(kind, file), '')
    const id = agentFileId(file)
    if (id === undefined) {
      problems.push({
        ...where,
        severity: 'warning',
        message: `\`${file.slice('agents/'.length)}\` isn’t named after an Agent id, so TED ignores this file. An Agent id is ${idRule}.`,
      })
    } else if (!Object.hasOwn(agentSettings, id) && !inherited.defined.includes(id)) {
      problems.push({
        ...where,
        severity: 'warning',
        message: `No agents.yaml lists \`${id}\`, so TED ignores this file. Add \`${id}\` to agents.yaml to use it.`,
      })
    } else if (body === null) {
      problems.push({ ...where, message: 'TED couldn’t read the instructions file' })
    } else if (body.trim() === '') {
      problems.push({ ...where, message: 'the instructions file is empty' })
    } else {
      agentFiles[id] = body
    }
  }

  for (const [id, node] of listed) {
    if (Object.hasOwn(agentFiles, id) || inherited.instructed.includes(id)) continue
    if (Object.keys(files).some((file) => agentFileId(file) === id)) continue
    problems.push(
      atNode(yamlFile, text ?? '', node, `\`${id}\` has no instructions file; add agents/${id}.md`),
    )
  }
  return { agentSettings, agentFiles }
}

function checkAgentsYaml(
  text: string,
  file: string,
  inherited: InheritedAgents,
  problems: WorkflowProblem[],
  listed: Map<string, Node | null>,
): Map<string, AgentSettings> {
  const settings = new Map<string, AgentSettings>()
  const lineCounter = new LineCounter()
  const doc = parseDocument(text, { lineCounter })
  const error = (node: Node | null | undefined, message: string) => {
    const { line, col } = lineCounter.linePos(node?.range?.[0] ?? 0)
    problems.push({ severity: 'error', file, line, column: col, message })
  }
  if (doc.errors.length > 0) {
    for (const problem of doc.errors) {
      const position = problem.linePos?.[0] ?? { line: 1, col: 1 }
      problems.push({
        severity: 'error',
        file,
        line: position.line,
        column: position.col,
        message: (problem.message.split('\n')[0] ?? '').replace(/ at line \d+, column \d+:?$/, ''),
      })
    }
    return settings
  }
  const root = doc.contents
  if (root === null || (isScalar(root) && root.value === null)) return settings
  if (!isMap(root)) {
    error(root, 'agents.yaml must be a map of Agent ids to their settings')
    return settings
  }
  for (const pair of root.items) {
    const key = isScalar(pair.key) ? pair.key : null
    const value = isScalar(pair.value) || isMap(pair.value) || isSeq(pair.value) ? pair.value : null
    const id = textOf(key)
    if (id === undefined || !isAgentId(id)) {
      error(key, `\`${String(key?.value ?? '')}\` isn’t an Agent id; an Agent id is ${idRule}`)
      continue
    }
    if (!isMap(value)) {
      error(value ?? key, `\`${id}\` must be a map of settings`)
      continue
    }
    const agent: AgentSettings = {}
    for (const entry of value.items) {
      const entryKey = isScalar(entry.key) ? entry.key : null
      const node = isScalar(entry.value) || isSeq(entry.value) ? entry.value : null
      const name = textOf(entryKey) ?? ''
      const path = `${id}.${name}`
      if (!agentKeys.includes(name)) {
        error(entryKey, `unknown key \`${path}\`; an Agent has ${agentKeys.join(', ')}`)
        continue
      }
      const raw = isScalar(node) ? textOf(node) : undefined
      switch (name) {
        case 'name':
          if (raw === undefined || raw.trim() === '' || raw.length > maxAgentName) {
            error(node, `\`${path}\` must be text of up to ${maxAgentName} characters`)
          } else agent.name = raw.trim()
          break
        case 'agent':
          if (!isOneOf(raw, agentKinds)) {
            error(node, `\`${path}\` must be ${agentKindList}`)
          } else agent.agent = raw
          break
        case 'model':
          if (!isModelName(raw)) error(node, `\`${path}\` must be a model name`)
          else agent.model = raw
          break
        case 'based_on':
          if (raw === undefined) error(node, `\`${path}\` must be text`)
          else agent.based_on = raw
          break
        case 'powers': {
          const powers = checkPowers(node, path, error)
          if (powers) agent.powers = powers
          break
        }
      }
    }
    if (agent.name === undefined && !inherited.defined.includes(id)) {
      error(key, `\`${id}\` needs a \`name\``)
    }
    listed.set(id, key)
    settings.set(id, agent)
  }
  return settings
}

function checkPowers(
  node: Node | null,
  path: string,
  error: (node: Node | null | undefined, message: string) => void,
): AgentPower[] | undefined {
  if (isScalar(node) && node.value === null) return []
  if (!isSeq(node)) return void error(node, `\`${path}\` must be a list of powers: ${powerList}`)
  const powers: AgentPower[] = []
  let ok = true
  for (const item of node.items) {
    const value = isScalar(item) ? textOf(item) : undefined
    if (!isOneOf(value, agentPowers)) {
      error(
        isScalar(item) ? item : node,
        `unknown power \`${String(value ?? '')}\` in \`${path}\`; the powers are ${powerList}`,
      )
      ok = false
    } else if (!powers.includes(value)) powers.push(value)
  }
  return ok ? powers : undefined
}

function textOf(node: Node | null): string | undefined {
  if (!isScalar(node)) return undefined
  const { value } = node
  return isString(value) ? value : undefined
}

function at(file: string, message: string): WorkflowProblem {
  return { severity: 'error', file, line: 1, column: 1, message }
}

function atNode(file: string, text: string, node: Node | null, message: string): WorkflowProblem {
  const offset = node?.range?.[0] ?? 0
  const before = text.slice(0, offset).split('\n')
  return {
    severity: 'error',
    file,
    line: before.length,
    column: (before.at(-1)?.length ?? 0) + 1,
    message,
  }
}

export function resolveAgents(layers: readonly AgentLayer[]): ResolvedAgent[] {
  const merged = new Map<string, { settings: AgentSettings; source: LayerKind }>()
  const texts = new Map<string, { text: string; kind: LayerKind }>()
  for (const layer of layers) {
    for (const [id, own] of Object.entries(layer.agentSettings)) {
      const before = merged.get(id)
      merged.set(id, { settings: { ...before?.settings, ...own }, source: layer.kind })
    }
    for (const [id, text] of Object.entries(layer.agentFiles)) {
      texts.set(id, { text, kind: layer.kind })
      const before = merged.get(id)
      if (before) before.source = layer.kind
    }
  }
  return [...merged].flatMap(([id, { settings, source }]) => {
    const text = texts.get(id)
    if (!text || settings.name === undefined) return []
    return [
      {
        id,
        name: settings.name,
        ...(settings.agent !== undefined && { agent: settings.agent }),
        ...(settings.model !== undefined && { model: settings.model }),
        powers: agentPowers.filter((power) => settings.powers?.includes(power)),
        instructions: text.text,
        source,
        path: displayPath(text.kind, `agents/${id}.md`),
      },
    ]
  })
}
