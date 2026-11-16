import {
  type AgentStageId,
  agentStageIds,
  appEnvName,
  appKinds,
  isLoopbackUrl,
  isModelName,
  type LayerKind,
  maxCleanupStepName,
  type PullRequestCiMode,
  pullRequestCiModes,
  type StageId,
  type WorkflowProblem,
} from '@ted/protocol'
import { builtInAgentIds } from '@ted/protocol/agent-files'
import { isOneOf } from '@ted/protocol/parse'
import {
  handsOff,
  hasClarifyRounds,
  isBuiltInStage,
  isCleanup,
  isCustomStageId,
  isEntryStage,
  maxCustomStageId,
  maxStageName,
  mergesHere,
  validates,
} from '@ted/protocol/stage'
import { isMap, isScalar, isSeq, LineCounter, type Node, parseDocument, type YAMLMap } from 'yaml'
import {
  type AgentSettings,
  checkAgentFiles,
  type InheritedAgents,
  inheritedAgents,
} from './agent-files.ts'
import { displayPath } from './display-path.ts'

export { displayPath }

export type LayerFiles = Record<string, string | null>

export interface AgentChoice {
  agent?: string
  model?: string
  effort?: string
}

export interface CheckSettings {
  name: string
  run: string
  repo?: string
  timeout?: string
}

export interface CleanupInstructionStep {
  name: string
  instruction: string
}

export interface CleanupCommandStep {
  name: string
  command: string
  timeout?: string
}

export type CleanupStep = CleanupInstructionStep | CleanupCommandStep

export function isCommandStep(step: CleanupStep): step is CleanupCommandStep {
  return 'command' in step
}

export interface StageSettings {
  name?: string
  effort?: string
  enabled?: boolean
  gate?: boolean
  max_back?: number
  based_on?: string
  depth?: string
  checks?: CheckSettings[]
  loop_check?: number | false
  p1_only_from?: number | false
  sub_agents?: boolean
  lead_closes_failures?: boolean
  commit_titles?: boolean
  steps?: CleanupStep[]
}

export interface WorktreeCommand {
  run: string
  timeout?: string
}

export interface RepoSettings {
  name?: string
  remote?: string
  base_branch?: string
  merge_method?: string
  pull_request_ci?: PullRequestCiMode
  worktree?: {
    setup?: WorktreeCommand
    teardown?: WorktreeCommand
    env?: Record<string, string>
    copy?: string[]
  }
  apps?: unknown[]
}

export interface WorkflowSettings {
  version?: number
  lead?: AgentChoice
  reviewer?: AgentChoice
  planner?: AgentChoice
  permissions?: string
  max_working_runs?: number
  sandbox_sockets?: string[]
  repos?: RepoSettings[]
  order?: AgentStageId[]
  stages: Partial<Record<StageId, StageSettings>>
}

export interface CheckedLayer {
  kind: LayerKind
  files: LayerFiles
  settings: WorkflowSettings
  stageFiles: Partial<Record<AgentStageId, string>>
  agentSettings: Record<string, AgentSettings>
  agentFiles: Record<string, string>
  notes?: string
  problems: WorkflowProblem[]
  valid: boolean
}

export interface InheritedStages {
  files: readonly string[]
  order?: readonly string[]
  agents?: InheritedAgents
}

export function inheritedFrom(below: readonly CheckedLayer[]): InheritedStages {
  const files = new Set<string>(agentStageIds)
  let order: readonly string[] | undefined
  for (const layer of below) {
    for (const id of Object.keys(layer.stageFiles)) files.add(id)
    if (layer.settings.order) order = layer.settings.order
  }
  return { files: [...files], ...(order && { order }), agents: inheritedAgents(below) }
}

const allStageIds: readonly string[] = ['backlog', ...agentStageIds, 'done']
const cleanupKeys = ['enabled', 'effort', 'based_on', 'steps']
const customKeys = ['name', 'gate', 'max_back', 'effort', 'enabled', 'based_on']
export const maxStepName = maxCleanupStepName
const efforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const depths = ['auto', 'none', 'few', 'grilling']
const mergeMethods = ['squash', 'merge', 'rebase']
const duration = /^\d+[smh]$/
const repoName = /^[a-z0-9-]+$/
const githubRemote =
  /^(?:(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/|git@github\.com:|github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/
const factoryOnly = '` can only be set in a Factory’s .ted/workflow.yaml'

export function githubRepoOf(remote: string): string | undefined {
  const match = githubRemote.exec(remote.trim())
  if (!match?.[1] || !match[2]) return undefined
  if ([match[1], match[2]].some((part) => /^\.+$/.test(part))) return undefined
  return `${match[1]}/${match[2]}`
}

export const maxFactoryRepos = 10

export function checkLayer(input: {
  kind: LayerKind
  files: LayerFiles
  primaryRepo?: string
  inherited?: InheritedStages
}): CheckedLayer {
  const { kind, files } = input
  const problems: WorkflowProblem[] = []
  const orderAt = new Map<string, { line: number; column: number }>()
  const yamlText = files['workflow.yaml']
  let settings: WorkflowSettings = { stages: {} }
  if (yamlText === null) {
    problems.push({
      severity: 'error',
      file: displayPath(kind, 'workflow.yaml'),
      line: 1,
      column: 1,
      message: 'Ted couldn’t read workflow.yaml',
    })
  } else if (yamlText !== undefined) {
    settings = checkWorkflowYaml(yamlText, {
      kind,
      problems,
      primaryRepo: input.primaryRepo,
      orderAt,
    })
  }

  const stageFiles: Partial<Record<AgentStageId, string>> = {}
  if (files.stages === null) {
    problems.push({
      severity: 'error',
      file: displayPath(kind, 'stages'),
      line: 1,
      column: 1,
      message: 'Ted couldn’t read the stages folder',
    })
  }
  for (const [file, text] of Object.entries(files)) {
    if (!file.startsWith('stages/')) continue
    const at = { severity: 'error' as const, file: displayPath(kind, file), line: 1, column: 1 }
    const id = file.slice('stages/'.length).replace(/\.md$/, '')
    const listed = settings.order ?? input.inherited?.order ?? []
    if (!file.endsWith('.md') || (!isBuiltInStage(id) && !isCustomStageId(id))) {
      problems.push({
        ...at,
        severity: 'warning',
        message: `\`${id}\` isn’t a Stage id, so Ted ignores this file. A custom Stage id is lowercase letters, digits and hyphens, up to ${maxCustomStageId} characters.`,
      })
    } else if (
      kind === 'factory' &&
      yamlText !== undefined &&
      !isBuiltInStage(id) &&
      !listed.includes(id)
    ) {
      problems.push({
        ...at,
        severity: 'warning',
        message: `No \`order\` lists \`${id}\`, so Ted ignores this file. Add \`${id}\` to \`order\` in workflow.yaml to run it as a Stage.`,
      })
    } else if (text === null) {
      problems.push({ ...at, message: 'Ted couldn’t read the Stage file' })
    } else if (text.trim() === '') {
      problems.push({ ...at, message: 'the Stage file is empty' })
    } else {
      stageFiles[id as AgentStageId] = text
    }
  }

  const known = new Set(input.inherited?.files ?? agentStageIds)
  for (const id of settings.order ?? []) {
    if (isBuiltInStage(id) || Object.hasOwn(stageFiles, id) || known.has(id)) continue
    const at = orderAt.get(id) ?? { line: 1, column: 1 }
    problems.push({
      severity: 'error',
      file: displayPath(kind, 'workflow.yaml'),
      ...at,
      message: `\`${id}\` has no Stage file; add stages/${id}.md`,
    })
  }
  const { agentSettings, agentFiles } = checkAgentFiles({
    kind,
    files,
    inherited:
      input.inherited?.agents ??
      (kind === 'ted'
        ? { defined: [], instructed: [] }
        : { defined: builtInAgentIds, instructed: builtInAgentIds }),
    problems,
  })
  const yamlFile = displayPath(kind, 'workflow.yaml')
  const agentsFile = displayPath(kind, 'agents.yaml')
  const rank = (p: WorkflowProblem) => (p.file === yamlFile ? 0 : p.file === agentsFile ? 1 : 2)
  problems.sort(
    (a, b) => rank(a) - rank(b) || (rank(a) < 2 ? a.line - b.line || a.column - b.column : 0),
  )

  const notes = kind === 'factory' ? files['notes.md'] : undefined
  return {
    kind,
    files,
    settings,
    stageFiles,
    agentSettings,
    agentFiles,
    ...(typeof notes === 'string' && { notes }),
    problems,
    valid: !problems.some((p) => p.severity === 'error'),
  }
}

interface Context {
  kind: LayerKind
  problems: WorkflowProblem[]
  primaryRepo: string | undefined
  orderAt: Map<string, { line: number; column: number }>
}

function checkWorkflowYaml(text: string, context: Context): WorkflowSettings {
  const settings: WorkflowSettings = { stages: {} }
  const checkNodes = new Map<CheckSettings, Node | null>()
  let repoNames: Set<string> | undefined
  const appEnvNames = new Set<string>()
  const file = displayPath(context.kind, 'workflow.yaml')
  const lineCounter = new LineCounter()
  const doc = parseDocument(text, { lineCounter })
  const report = (
    severity: 'error' | 'warning',
    node: Node | null | undefined,
    message: string,
  ) => {
    const { line, col } = lineCounter.linePos(node?.range?.[0] ?? 0)
    context.problems.push({ severity, file, line, column: col, message })
  }
  const error = (node: Node | null | undefined, message: string) => report('error', node, message)
  const warn = (node: Node | null | undefined, message: string) => report('warning', node, message)

  if (doc.errors.length > 0) {
    for (const problem of doc.errors) {
      const position = problem.linePos?.[0] ?? { line: 1, col: 1 }
      context.problems.push({
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
    error(root, 'workflow.yaml must be a map of settings')
    return settings
  }

  for (const { key, value, name } of entries(root)) {
    switch (name) {
      case 'version':
        if (scalar(value) !== 1) error(value, '`version` must be 1')
        else settings.version = 1
        break
      case 'lead':
      case 'planner':
      case 'reviewer': {
        const choice = agentChoice(name, value)
        if (choice) settings[name] = choice
        break
      }
      case 'permissions':
        if (context.kind === 'library') warn(key, `\`${name}${factoryOnly}`)
        else if (!oneOf(value, ['auto', 'bypass']))
          error(value, '`permissions` must be auto or bypass')
        else settings.permissions = scalar(value) as string
        break
      case 'max_working_runs':
        if (context.kind === 'library') warn(key, `\`${name}${factoryOnly}`)
        else if (!wholeNumber(value, 1)) {
          error(value, '`max_working_runs` must be a whole number above 0')
        } else settings.max_working_runs = scalar(value) as number
        break
      case 'sandbox_sockets': {
        const sockets = checkSandboxSockets(value)
        if (sockets) settings.sandbox_sockets = sockets
        break
      }
      case 'repos':
        if (context.kind === 'library') warn(key, `\`${name}${factoryOnly}`)
        else {
          const repos = checkRepos(value)
          if (repos) settings.repos = repos
        }
        break
      case 'order': {
        const order = checkOrder(value)
        if (order) settings.order = order
        break
      }
      case 'stages':
        checkStages(value)
        break
      default:
        warn(key, `unknown key \`${name}\``)
    }
  }
  checkCheckRepos()
  return settings

  function agentChoice(name: 'lead' | 'reviewer' | 'planner', value: Node | null) {
    const agents =
      name === 'reviewer'
        ? ['codex', 'claude', 'antigravity', 'same']
        : ['claude', 'codex', 'antigravity']
    const agentMessage = (path: string) =>
      `\`${path}\` must be ${agents.slice(0, -1).join(', ')} or ${agents.at(-1)}`
    if (isScalar(value)) {
      if (!oneOf(value, agents)) return void error(value, agentMessage(name))
      return { agent: scalar(value) as string }
    }
    if (!isMap(value)) return void error(value, agentMessage(name))
    const choice: AgentChoice = {}
    for (const entry of entries(value)) {
      const path = `${name}.${entry.name}`
      if (entry.name === 'agent') {
        if (!oneOf(entry.value, agents)) error(entry.value, agentMessage(path))
        else choice.agent = scalar(entry.value) as string
      } else if (entry.name === 'model') {
        if (!isText(entry.value) || !isModelName(scalar(entry.value))) {
          error(entry.value, `\`${path}\` must be a model name`)
        } else choice.model = scalar(entry.value) as string
      } else if (entry.name === 'effort') {
        if (!oneOf(entry.value, efforts)) {
          error(entry.value, `\`${path}\` must be one of ${efforts.join(', ')}`)
        } else choice.effort = scalar(entry.value) as string
      } else warn(entry.key, `unknown key \`${path}\``)
    }
    return choice
  }

  function checkSandboxSockets(value: Node | null): string[] | undefined {
    const message =
      '`sandbox_sockets` must be a list of socket paths: absolute, starting with ~/, or a whole $NAME'
    if (!isSeq(value)) return void error(value, message)
    const sockets: string[] = []
    for (const item of value.items as (Node | null)[]) {
      const entry = scalar(item)
      if (typeof entry !== 'string' || !isSocketEntry(entry)) return void error(item, message)
      sockets.push(entry)
    }
    return sockets
  }

  function checkOrder(value: Node | null): AgentStageId[] | undefined {
    if (!isSeq(value)) return void error(value, '`order` must be a list of Stage ids')
    const ids: AgentStageId[] = []
    let ok = true
    for (const item of value.items as (Node | null)[]) {
      const id = scalar(item)
      if (id === 'backlog' || id === 'done') {
        const where = id === 'backlog' ? 'first' : 'last'
        error(item, `\`${id}\` can’t be in \`order\`; it is always ${where}`)
        ok = false
      } else if (typeof id === 'string' && isCleanup(id)) {
        error(item, '`cleanup` can’t be in `order`; turn it on with `stages.cleanup.enabled`')
        ok = false
      } else if (typeof id !== 'string' || (!isBuiltInStage(id) && !isCustomStageId(id))) {
        error(item, customIdProblem(id))
        ok = false
      } else if (ids.includes(id)) {
        error(item, `\`${id}\` is listed twice in \`order\``)
        ok = false
      } else {
        const { line, col } = lineCounter.linePos(item?.range?.[0] ?? 0)
        context.orderAt.set(id, { line, column: col })
        ids.push(id)
      }
    }
    if (!ok) return undefined
    if (ids[0] === undefined || !isEntryStage(ids[0]))
      return void error(value, '`order` must start with `intake`')
    if (!ids.some(handsOff)) return void error(value, '`order` must include `work`')
    const merge = ids.findIndex(mergesHere)
    if (merge !== -1 && merge !== ids.length - 1) {
      return void error(value.items[merge] as Node, '`merge` must be last in `order`')
    }
    return ids
  }

  function checkStages(value: Node | null): void {
    if (!isMap(value)) return void error(value, '`stages` must be a map of Stage ids')
    for (const { key, value: stageNode, name: id } of entries(value)) {
      const custom = !allStageIds.includes(id)
      if (custom && !isCustomStageId(id)) {
        error(key, customIdProblem(id))
        continue
      }
      if (stageNode === null || (isScalar(stageNode) && stageNode.value === null)) continue
      if (!isMap(stageNode)) {
        error(stageNode, `\`stages.${id}\` must be a map of settings`)
        continue
      }
      const stage: StageSettings = {}
      for (const entry of entries(stageNode)) {
        const path = `stages.${id}.${entry.name}`
        const node = entry.value
        if (id === 'done') {
          error(entry.key, 'Done takes no settings')
          continue
        }
        if (id === 'backlog' && entry.name !== 'enabled') {
          error(entry.key, 'Backlog takes only `enabled`')
          continue
        }
        if (custom && !customKeys.includes(entry.name)) {
          error(
            entry.key,
            `a custom Stage takes only ${customKeys.map((k) => `\`${k}\``).join(', ')}`,
          )
          continue
        }
        if (isCleanup(id) && !cleanupKeys.includes(entry.name)) {
          error(entry.key, `Cleanup takes only ${cleanupKeys.map((k) => `\`${k}\``).join(', ')}`)
          continue
        }
        switch (entry.name) {
          case 'name': {
            const name = scalar(node)
            if (!custom) error(entry.key, 'only a custom Stage takes `name`')
            else if (
              typeof name !== 'string' ||
              name.trim() === '' ||
              hasControlCharacters(name) ||
              name.length > maxStageName
            ) {
              error(node, `\`${path}\` must be one line of text, up to ${maxStageName} characters`)
            } else stage.name = name.trim()
            break
          }
          case 'effort':
            if (!oneOf(node, efforts))
              error(node, `\`${path}\` must be one of ${efforts.join(', ')}`)
            else stage.effort = scalar(node) as string
            break
          case 'enabled':
          case 'gate':
            if (typeof scalar(node) !== 'boolean') {
              error(node, `\`${path}\` must be true or false`)
            } else if (
              entry.name === 'enabled' &&
              (isEntryStage(id) || handsOff(id)) &&
              scalar(node) === false
            ) {
              error(node, `${handsOff(id) ? 'Work' : 'Intake'} can’t be turned off`)
            } else if (entry.name === 'enabled' && id === 'backlog' && scalar(node) === false) {
              warn(node, 'Backlog can’t be turned off; Ted ignores this')
            } else stage[entry.name] = scalar(node) as boolean
            break
          case 'max_back':
            if (!wholeNumber(node, 0)) error(node, `\`${path}\` must be a whole number, 0 or more`)
            else stage.max_back = scalar(node) as number
            break
          case 'based_on':
            if (!isText(node)) error(node, `\`${path}\` must be text`)
            else stage.based_on = scalar(node) as string
            break
          case 'depth':
            if (!hasClarifyRounds(id)) warn(entry.key, `unknown key \`${path}\``)
            else if (!oneOf(node, depths)) {
              error(node, `\`${path}\` must be one of ${depths.join(', ')}`)
            } else stage.depth = scalar(node) as string
            break
          case 'loop_check':
            if (!validates(id)) warn(entry.key, `unknown key \`${path}\``)
            else if (scalar(node) !== false && !wholeNumber(node, 1)) {
              error(node, `\`${path}\` must be a whole number above 0, or false`)
            } else stage.loop_check = scalar(node) as number | false
            break
          case 'p1_only_from':
            if (!validates(id)) warn(entry.key, `unknown key \`${path}\``)
            else if (scalar(node) !== false && !wholeNumber(node, 2)) {
              error(node, `\`${path}\` must be a round number, 2 or more, or false`)
            } else stage.p1_only_from = scalar(node) as number | false
            break
          case 'sub_agents':
            if (!validates(id)) warn(entry.key, `unknown key \`${path}\``)
            else if (typeof scalar(node) !== 'boolean') {
              error(node, `\`${path}\` must be true or false`)
            } else stage.sub_agents = scalar(node) as boolean
            break
          case 'lead_closes_failures':
            if (!handsOff(id)) warn(entry.key, `unknown key \`${path}\``)
            else if (typeof scalar(node) !== 'boolean') {
              error(node, `\`${path}\` must be true or false`)
            } else stage.lead_closes_failures = scalar(node) as boolean
            break
          case 'commit_titles':
            if (!mergesHere(id)) warn(entry.key, `unknown key \`${path}\``)
            else if (typeof scalar(node) !== 'boolean') {
              error(node, `\`${path}\` must be true or false`)
            } else stage.commit_titles = scalar(node) as boolean
            break
          case 'steps':
            if (!isCleanup(id)) warn(entry.key, `unknown key \`${path}\``)
            else {
              const steps = checkSteps(node)
              if (steps) stage.steps = steps
            }
            break
          case 'checks':
            if (!validates(id)) warn(entry.key, `unknown key \`${path}\``)
            else if (context.kind === 'library') warn(entry.key, `\`${path}${factoryOnly}`)
            else {
              const checks = checkChecks(node)
              if (checks) stage.checks = checks
            }
            break
          default:
            warn(entry.key, `unknown key \`${path}\``)
        }
      }
      const p1From = stage.p1_only_from
      if (
        typeof p1From === 'number' &&
        stage.max_back !== undefined &&
        p1From > stage.max_back + 1
      ) {
        const round = stage.max_back + 1
        warn(
          entries(stageNode).find((entry) => entry.name === 'p1_only_from')?.key ?? stageNode,
          `\`stages.${id}.p1_only_from\` is ${p1From}, but \`max_back: ${stage.max_back}\` in this file lets Validate reach round ${round} at most before Ted asks the human, so round ${p1From} comes only if the human sends the Task back again`,
        )
      }
      settings.stages[id as StageId] = stage
    }
  }

  function checkSteps(value: Node | null): CleanupStep[] | undefined {
    if (!isSeq(value)) return void error(value, '`stages.cleanup.steps` must be a list')
    const steps: CleanupStep[] = []
    for (const item of value.items as (Node | null)[]) {
      if (!isMap(item)) {
        error(
          item,
          'each Cleanup step must be a map with a `name` and an `instruction` or a `command`',
        )
        continue
      }
      const step: { name?: string; instruction?: string; command?: string; timeout?: string } = {}
      let bad = false
      for (const entry of entries(item)) {
        if (entry.name === 'name' || entry.name === 'instruction' || entry.name === 'command') {
          if (!isText(entry.value)) {
            error(entry.value, `a Cleanup step’s \`${entry.name}\` must be text`)
            bad = true
          } else step[entry.name] = (scalar(entry.value) as string).trim()
        } else if (entry.name === 'timeout') {
          if (!durationValue(entry.value)) {
            error(entry.value, durationMessage)
            bad = true
          } else step.timeout = scalar(entry.value) as string
        } else warn(entry.key, `unknown key \`${entry.name}\` in a Cleanup step`)
      }
      if (bad) continue
      if (!step.name) error(item, 'each Cleanup step needs a `name`')
      else if (/[\r\n]/.test(step.name)) error(item, 'a Cleanup step’s `name` must be one line')
      else if (step.name.length > maxStepName)
        error(item, `a Cleanup step’s \`name\` must be ${maxStepName} characters or fewer`)
      else if (step.instruction !== undefined && step.command !== undefined)
        error(item, 'a Cleanup step has an `instruction` or a `command`, not both')
      else if (!step.instruction && !step.command)
        error(item, 'each Cleanup step needs an `instruction` or a `command`')
      else if (step.instruction && step.timeout !== undefined)
        error(item, 'only a Cleanup step with a `command` takes a `timeout`')
      else if (steps.some((other) => other.name === step.name))
        error(item, `two Cleanup steps are named \`${step.name}\``)
      else
        steps.push(
          step.command
            ? {
                name: step.name,
                command: step.command,
                ...(step.timeout !== undefined && { timeout: step.timeout }),
              }
            : { name: step.name, instruction: step.instruction as string },
        )
    }
    return steps
  }

  function checkChecks(value: Node | null): CheckSettings[] | undefined {
    if (!isSeq(value)) return void error(value, '`stages.validate.checks` must be a list')
    const checks: CheckSettings[] = []
    for (const item of value.items as (Node | null)[]) {
      if (!isMap(item)) {
        error(item, 'each Check must be a map with a `name` and a `run` command')
        continue
      }
      const check: Partial<CheckSettings> = {}
      for (const entry of entries(item)) {
        if (entry.name === 'name' || entry.name === 'run' || entry.name === 'repo') {
          if (!isText(entry.value)) error(entry.value, `a Check’s \`${entry.name}\` must be text`)
          else check[entry.name] = scalar(entry.value) as string
        } else if (entry.name === 'timeout') {
          if (!durationValue(entry.value)) error(entry.value, durationMessage)
          else check.timeout = scalar(entry.value) as string
        } else warn(entry.key, `unknown key \`${entry.name}\` in a Check`)
      }
      if (check.name === undefined) error(item, 'each Check needs a `name`')
      else if (check.run === undefined) error(item, 'each Check needs a `run` command')
      else checks.push(check as CheckSettings)
      checkNodes.set(check as CheckSettings, item)
    }
    return checks
  }

  function checkRepos(value: Node | null): RepoSettings[] | undefined {
    if (!isSeq(value)) return void error(value, '`repos` must be a list')
    if (value.items.length > maxFactoryRepos) {
      return void error(value, `a Factory has at most ${maxFactoryRepos} repos`)
    }
    const repos: RepoSettings[] = []
    const seenNames = new Set<string>()
    const seenRepos = new Set<string>()
    let namesKnown = true
    for (const [index, item] of (value.items as (Node | null)[]).entries()) {
      if (!isMap(item)) {
        error(item, 'each repo must be a map')
        continue
      }
      const repo = checkRepo(item, index === 0)
      repos.push(repo)
      const nameNode = item.get('name', true) as Node | undefined
      const remoteNode = item.get('remote', true) as Node | undefined
      const remoteRepo = repo.remote === undefined ? undefined : githubRepoOf(repo.remote)
      const ownRepo = index === 0 ? (context.primaryRepo ?? remoteRepo) : remoteRepo
      if (index > 0 && repo.remote === undefined && !remoteNode) {
        error(item, 'a secondary repo needs a `remote`')
      }
      const name = repo.name ?? ownRepo?.split('/')[1]?.toLowerCase()
      if (name === undefined) namesKnown = false
      else if (seenNames.has(name)) error(nameNode ?? item, `two repos are named \`${name}\``)
      else seenNames.add(name)
      if (ownRepo !== undefined) {
        const lower = ownRepo.toLowerCase()
        if (seenRepos.has(lower))
          error(remoteNode ?? item, `${ownRepo} is listed twice in \`repos\``)
        else seenRepos.add(lower)
      }
    }
    repoNames = namesKnown ? seenNames : undefined
    return repos
  }

  function checkRepo(item: YAMLMap, primary: boolean): RepoSettings {
    const repo: RepoSettings = {}
    for (const entry of entries(item)) {
      const node = entry.value
      switch (entry.name) {
        case 'name':
          if (!isText(node)) error(node, 'a repo `name` must be text')
          else if (!repoName.test(scalar(node) as string)) {
            error(node, 'a repo `name` uses only lowercase letters, digits and dashes')
          } else repo.name = scalar(node) as string
          break
        case 'remote': {
          if (!isText(node)) {
            error(node, '`remote` must be a GitHub repo')
            break
          }
          const remote = scalar(node) as string
          const parsed = githubRepoOf(remote)
          if (parsed === undefined) error(node, '`remote` must be a GitHub repo')
          else if (primary && context.primaryRepo !== undefined) {
            if (parsed.toLowerCase() !== context.primaryRepo.toLowerCase()) {
              warn(node, 'the primary repo is the one holding .ted/, so Ted ignores this `remote`')
            }
          } else repo.remote = remote
          break
        }
        case 'base_branch':
          if (!isText(node)) error(node, '`base_branch` must be text')
          else repo.base_branch = scalar(node) as string
          break
        case 'merge_method':
          if (!oneOf(node, mergeMethods))
            error(node, '`merge_method` must be squash, merge or rebase')
          else repo.merge_method = scalar(node) as string
          break
        case 'pull_request_ci': {
          const mode = scalar(node)
          if (isOneOf(mode, pullRequestCiModes)) repo.pull_request_ci = mode
          else error(node, '`pull_request_ci` must be auto, none or required')
          break
        }
        case 'worktree': {
          const worktree = checkWorktree(node)
          if (worktree) repo.worktree = worktree
          break
        }
        case 'apps':
          if (!isSeq(node)) error(node, '`apps` must be a list')
          else {
            checkApps(node)
            repo.apps = node.toJSON() as unknown[]
          }
          break
        default:
          warn(entry.key, `unknown key \`${entry.name}\` in a repo`)
      }
    }
    return repo
  }

  function checkApps(list: Node & { items: unknown[] }): void {
    for (const item of list.items as (Node | null)[]) {
      if (!isMap(item)) {
        error(item, 'each App must be a map')
        continue
      }
      const kind = scalar(item.get('kind', true) as Node | undefined) ?? 'web'
      const name = scalar(item.get('name', true) as Node | undefined)
      for (const entry of entries(item)) {
        const node = entry.value
        switch (entry.name) {
          case 'name':
            if (!isText(node) || (scalar(node) as string).trim() === '') {
              error(node, 'an App `name` must be text')
            } else {
              const envName = appEnvName((scalar(node) as string).trim())
              if (appEnvNames.has(envName)) {
                error(node, `two Apps would both set \`TED_APP_${envName}_PORT\``)
              } else appEnvNames.add(envName)
            }
            break
          case 'run':
            if (!isText(node) || (scalar(node) as string).trim() === '') {
              error(node, 'an App `run` must be a command')
            }
            break
          case 'kind':
            if (!oneOf(node, [...appKinds])) {
              error(node, '`kind` must be web, command, ios-simulator or android-emulator')
            }
            break
          case 'url': {
            const url = scalar(node)
            if (typeof url !== 'string' || !isLoopbackUrl(url.replaceAll(`\${PORT}`, '1'))) {
              error(
                node,
                `an App \`url\` must be a localhost address, such as http://localhost:\${PORT}`,
              )
            } else if (kind !== 'web') warn(entry.key, 'only a web App has a `url`')
            break
          }
          case 'ready':
            if (!oneOf(node, ['url', 'start'])) error(node, '`ready` must be url or start')
            break
          case 'port': {
            const port = scalar(node)
            if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
              error(node, '`port` must be a number from 1 to 65535')
            }
            break
          }
          case 'device':
            if (!isText(node)) error(node, '`device` must be text')
            break
          case 'electron': {
            const value = scalar(node)
            if (typeof value !== 'boolean') error(node, '`electron` must be true or false')
            else if (value && kind !== 'command')
              warn(entry.key, 'only a command App can be an Electron app')
            else if (
              value &&
              !String(scalar(item.get('run', true) as Node | undefined)).includes(
                'TED_ELECTRON_ARGS',
              )
            )
              warn(
                entry.key,
                'pass $TED_ELECTRON_ARGS to Electron in `run`, or Ted can’t reach the app or start it in the sandbox',
              )
            break
          }
          case 'env':
            if (!isMap(node)) {
              error(node, 'an App `env` must be a map of names to text')
              break
            }
            for (const variable of entries(node)) {
              const v = scalar(variable.value)
              if (typeof v === 'object' || v === undefined) {
                error(variable.value, 'an App `env` value must be text')
              } else if (
                variable.name.toUpperCase() === 'PORT' ||
                isReservedEnvName(variable.name)
              ) {
                warn(
                  variable.key,
                  `Ted sets \`${variable.name}\` itself or keeps it out of worktrees, so it ignores it here`,
                )
              }
            }
            break
          default:
            warn(entry.key, `unknown key \`${entry.name}\` in an App`)
        }
      }
      if (typeof name !== 'string') error(item, 'each App needs a `name`')
      else if (!item.has('run')) error(item, `the App ${name} needs a \`run\` command`)
      else if (kind === 'android-emulator' && !item.has('device')) {
        error(
          item,
          `the Android emulator App ${name} needs a \`device\`: an Android virtual device name`,
        )
      }
    }
  }

  function checkWorktree(value: Node | null): RepoSettings['worktree'] {
    if (!isMap(value)) return void error(value, '`worktree` must be a map')
    const worktree: NonNullable<RepoSettings['worktree']> = {}
    for (const entry of entries(value)) {
      const node = entry.value
      switch (entry.name) {
        case 'setup':
        case 'teardown': {
          const command = checkCommand(entry.name, node)
          if (command) worktree[entry.name] = command
          break
        }
        case 'env': {
          if (!isMap(node)) {
            error(node, '`worktree.env` must be a map of names to text')
            break
          }
          const env: Record<string, string> = {}
          for (const variable of entries(node)) {
            const v = scalar(variable.value)
            if (typeof v === 'object' || v === undefined) {
              error(variable.value, '`worktree.env` values must be text')
            } else if (isReservedEnvName(variable.name)) {
              warn(
                variable.key,
                `Ted sets \`${variable.name}\` itself or keeps it out of worktrees, so it ignores it here`,
              )
            } else env[variable.name] = String(v)
          }
          worktree.env = env
          break
        }
        case 'copy': {
          if (!isSeq(node) || !(node.items as (Node | null)[]).every(isText)) {
            error(node, '`worktree.copy` must be a list of paths')
          } else worktree.copy = (node.items as Node[]).map((n) => scalar(n) as string)
          break
        }
        default:
          warn(entry.key, `unknown key \`worktree.${entry.name}\``)
      }
    }
    return worktree
  }

  function checkCommand(name: string, value: Node | null): WorktreeCommand | undefined {
    if (isText(value)) return { run: scalar(value) as string }
    if (!isMap(value))
      return void error(value, `\`${name}\` must be a command, or { run, timeout }`)
    const command: Partial<WorktreeCommand> = {}
    for (const entry of entries(value)) {
      if (entry.name === 'run') {
        if (!isText(entry.value)) error(entry.value, '`run` must be a command')
        else command.run = scalar(entry.value) as string
      } else if (entry.name === 'timeout') {
        if (!durationValue(entry.value)) error(entry.value, durationMessage)
        else command.timeout = scalar(entry.value) as string
      } else warn(entry.key, `unknown key \`${name}.${entry.name}\``)
    }
    if (command.run === undefined) return void error(value, `\`${name}\` needs a \`run\` command`)
    return command as WorktreeCommand
  }

  function checkCheckRepos(): void {
    const names =
      settings.repos === undefined
        ? context.primaryRepo === undefined
          ? undefined
          : new Set([context.primaryRepo.split('/')[1]?.toLowerCase() ?? ''])
        : repoNames
    if (names === undefined) return
    for (const check of settings.stages.validate?.checks ?? []) {
      if (check.repo === undefined || names.has(check.repo)) continue
      const node = checkNodes.get(check)
      const repoNode = isMap(node) ? (node.get('repo', true) as Node) : node
      error(repoNode, `the Check’s \`repo: ${check.repo}\` names no entry in \`repos\``)
    }
  }
}

const reservedEnvNames = ['PATH', 'NODE_OPTIONS', 'BASH_ENV', 'ENV']
const reservedEnvPrefixes = ['TED_', 'LD_', 'DYLD_', 'ANTHROPIC_', 'CLAUDE_', 'OPENAI_', 'CODEX_']

export function isReservedEnvName(name: string): boolean {
  const upper = name.toUpperCase()
  return reservedEnvNames.includes(upper) || reservedEnvPrefixes.some((p) => upper.startsWith(p))
}

const durationMessage = '`timeout` must be a duration such as 30s, 15m or 1h'

function entries(map: YAMLMap): { key: Node | null; value: Node | null; name: string }[] {
  return map.items.map((pair) => {
    const key = pair.key as Node | null
    return { key, value: pair.value as Node | null, name: String(scalar(key)) }
  })
}

export function isSocketEntry(entry: string): boolean {
  if (entry.includes('\0') || entry.length > 1024) return false
  if (/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(entry)) return true
  const rest = entry.startsWith('~/')
    ? entry.slice(2)
    : entry.startsWith('/')
      ? entry.slice(1)
      : undefined
  return (
    rest !== undefined &&
    rest !== '' &&
    !rest.split('/').some((part) => part === '..' || part === '')
  )
}

function hasControlCharacters(text: string): boolean {
  return /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text)
}

function customIdProblem(id: unknown): string {
  return `unknown Stage \`${String(id)}\`; a custom Stage id is lowercase letters, digits and hyphens, up to ${maxCustomStageId} characters, and not a built-in id`
}

function scalar(node: Node | null | undefined): unknown {
  return isScalar(node) ? node.value : node === null ? null : undefined
}

function isText(node: Node | null | undefined): boolean {
  return typeof scalar(node) === 'string'
}

function oneOf(node: Node | null | undefined, values: string[]): boolean {
  const value = scalar(node)
  return typeof value === 'string' && values.includes(value)
}

function wholeNumber(node: Node | null | undefined, min: number): boolean {
  const value = scalar(node)
  return typeof value === 'number' && Number.isInteger(value) && value >= min
}

function durationValue(node: Node | null | undefined): boolean {
  const value = scalar(node)
  return typeof value === 'string' && duration.test(value)
}
