import {
  type AgentStageId,
  agentStageIds,
  type LayerKind,
  type StageId,
  type WorkflowProblem,
} from '@ted/protocol'
import { isMap, isScalar, isSeq, LineCounter, type Node, parseDocument, type YAMLMap } from 'yaml'

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

export interface StageSettings {
  enabled?: boolean
  gate?: boolean
  max_back?: number
  based_on?: string
  depth?: string
  checks?: CheckSettings[]
  loop_check?: number | false
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
  repos?: RepoSettings[]
  order?: AgentStageId[]
  stages: Partial<Record<StageId, StageSettings>>
}

export interface CheckedLayer {
  kind: LayerKind
  files: LayerFiles
  settings: WorkflowSettings
  stageFiles: Partial<Record<AgentStageId, string>>
  notes?: string
  problems: WorkflowProblem[]
  valid: boolean
}

const allStageIds: readonly string[] = ['backlog', ...agentStageIds, 'done']
const efforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const depths = ['auto', 'none', 'few', 'grilling']
const mergeMethods = ['squash', 'merge', 'rebase']
const duration = /^\d+[smh]$/
const repoName = /^[a-z0-9-]+$/
const githubRemote =
  /^(?:(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/|git@github\.com:|github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/
const factoryOnly = '` can only be set in a Factory’s .ted/workflow.yaml'

export function displayPath(kind: LayerKind, file: string): string {
  return kind === 'factory' ? `.ted/${file}` : file
}

export function githubRepoOf(remote: string): string | undefined {
  const match = githubRemote.exec(remote.trim())
  return match ? `${match[1]}/${match[2]}` : undefined
}

export function checkLayer(input: {
  kind: LayerKind
  files: LayerFiles
  primaryRepo?: string
}): CheckedLayer {
  const { kind, files } = input
  const problems: WorkflowProblem[] = []
  const yamlText = files['workflow.yaml']
  let settings: WorkflowSettings = { stages: {} }
  if (yamlText === null) {
    problems.push({
      severity: 'error',
      file: displayPath(kind, 'workflow.yaml'),
      line: 1,
      column: 1,
      message: 'TED couldn’t read workflow.yaml',
    })
  } else if (yamlText !== undefined) {
    settings = checkWorkflowYaml(yamlText, { kind, problems, primaryRepo: input.primaryRepo })
    problems.sort((a, b) => a.line - b.line || a.column - b.column)
  }

  const stageFiles: Partial<Record<AgentStageId, string>> = {}
  if (files.stages === null) {
    problems.push({
      severity: 'error',
      file: displayPath(kind, 'stages'),
      line: 1,
      column: 1,
      message: 'TED couldn’t read the stages folder',
    })
  }
  for (const [file, text] of Object.entries(files)) {
    if (!file.startsWith('stages/')) continue
    const at = { severity: 'error' as const, file: displayPath(kind, file), line: 1, column: 1 }
    const id = file.slice('stages/'.length).replace(/\.md$/, '')
    if (!file.endsWith('.md') || !(agentStageIds as readonly string[]).includes(id)) {
      problems.push({
        ...at,
        severity: 'warning',
        message: `TED has no Stage \`${id}\`, so it ignores this file. To add a step, edit the built-in Stage file it belongs to.`,
      })
    } else if (text === null) {
      problems.push({ ...at, message: 'TED couldn’t read the Stage file' })
    } else if (text.trim() === '') {
      problems.push({ ...at, message: 'the Stage file is empty' })
    } else {
      stageFiles[id as AgentStageId] = text
    }
  }

  const notes = kind === 'factory' ? files['notes.md'] : undefined
  return {
    kind,
    files,
    settings,
    stageFiles,
    ...(typeof notes === 'string' && { notes }),
    problems,
    valid: !problems.some((p) => p.severity === 'error'),
  }
}

interface Context {
  kind: LayerKind
  problems: WorkflowProblem[]
  primaryRepo: string | undefined
}

function checkWorkflowYaml(text: string, context: Context): WorkflowSettings {
  const settings: WorkflowSettings = { stages: {} }
  const checkNodes = new Map<CheckSettings, Node | null>()
  let repoNames: Set<string> | undefined
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
    const agents = name === 'reviewer' ? ['codex', 'claude', 'same'] : ['claude', 'codex']
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
        if (!isText(entry.value)) error(entry.value, `\`${path}\` must be text`)
        else choice.model = scalar(entry.value) as string
      } else if (entry.name === 'effort') {
        if (!oneOf(entry.value, efforts)) {
          error(entry.value, `\`${path}\` must be one of ${efforts.join(', ')}`)
        } else choice.effort = scalar(entry.value) as string
      } else warn(entry.key, `unknown key \`${path}\``)
    }
    return choice
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
      } else if (typeof id !== 'string' || !(agentStageIds as readonly string[]).includes(id)) {
        error(item, `unknown Stage \`${String(id)}\``)
        ok = false
      } else if (ids.includes(id as AgentStageId)) {
        error(item, `\`${id}\` is listed twice in \`order\``)
        ok = false
      } else ids.push(id as AgentStageId)
    }
    if (!ok) return undefined
    if (ids[0] !== 'intake') return void error(value, '`order` must start with `intake`')
    if (!ids.includes('work')) return void error(value, '`order` must include `work`')
    const merge = ids.indexOf('merge')
    if (merge !== -1 && merge !== ids.length - 1) {
      return void error(value.items[merge] as Node, '`merge` must be last in `order`')
    }
    return ids
  }

  function checkStages(value: Node | null): void {
    if (!isMap(value)) return void error(value, '`stages` must be a map of Stage ids')
    for (const { key, value: stageNode, name: id } of entries(value)) {
      if (!allStageIds.includes(id)) {
        error(key, `unknown Stage \`${id}\``)
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
        switch (entry.name) {
          case 'enabled':
          case 'gate':
            if (typeof scalar(node) !== 'boolean') {
              error(node, `\`${path}\` must be true or false`)
            } else if (
              entry.name === 'enabled' &&
              (id === 'intake' || id === 'work') &&
              scalar(node) === false
            ) {
              error(node, `${id === 'work' ? 'Work' : 'Intake'} can’t be turned off`)
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
            if (id !== 'clarify') warn(entry.key, `unknown key \`${path}\``)
            else if (!oneOf(node, depths)) {
              error(node, `\`${path}\` must be one of ${depths.join(', ')}`)
            } else stage.depth = scalar(node) as string
            break
          case 'loop_check':
            if (id !== 'validate') warn(entry.key, `unknown key \`${path}\``)
            else if (scalar(node) !== false && !wholeNumber(node, 1)) {
              error(node, `\`${path}\` must be a whole number above 0, or false`)
            } else stage.loop_check = scalar(node) as number | false
            break
          case 'checks':
            if (id !== 'validate') warn(entry.key, `unknown key \`${path}\``)
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
      settings.stages[id as StageId] = stage
    }
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
              warn(node, 'the primary repo is the one holding .ted/, so TED ignores this `remote`')
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
        case 'worktree': {
          const worktree = checkWorktree(node)
          if (worktree) repo.worktree = worktree
          break
        }
        case 'apps':
          if (!isSeq(node)) error(node, '`apps` must be a list')
          else repo.apps = node.toJSON() as unknown[]
          break
        default:
          warn(entry.key, `unknown key \`${entry.name}\` in a repo`)
      }
    }
    return repo
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

const durationMessage = '`timeout` must be a duration such as 30s, 15m or 1h'

function entries(map: YAMLMap): { key: Node | null; value: Node | null; name: string }[] {
  return map.items.map((pair) => {
    const key = pair.key as Node | null
    return { key, value: pair.value as Node | null, name: String(scalar(key)) }
  })
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
