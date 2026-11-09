import {
  type AgentChoiceInput,
  type AgentStageId,
  type AppInput,
  type AppKind,
  agentRoles,
  appKinds,
  type CheckInput,
  type FactorySettingsChanges,
  type RepoSettingsInput,
  type WorkflowProblem,
  type WorktreeCommandInput,
} from '@ted/protocol'
import { Document, isMap, isScalar, isSeq, parseDocument, type YAMLMap, YAMLSeq } from 'yaml'
import {
  githubRepoOf,
  isReservedEnvName,
  maxFactoryRepos,
  type RepoSettings,
  type WorkflowSettings,
} from './check.ts'

export const workflowFile = '.ted/workflow.yaml'

export interface StoredRepo {
  repo: string
  name: string
  cloneUrl: string
}

export function repoSettingsFrom(
  settings: WorkflowSettings | undefined,
  stored: readonly StoredRepo[],
): RepoSettingsInput[] {
  const primary = stored[0]
  if (!settings?.repos) {
    return stored.map((r, i) => ({
      was: r.name,
      repo: r.repo,
      ...(i > 0 && { remote: remoteFor(r) }),
      name: r.name,
      env: [],
      copy: [],
      apps: [],
    }))
  }
  return settings.repos.map((entry, i) => {
    const repo =
      i === 0
        ? (primary?.repo ?? '')
        : ((entry.remote === undefined ? undefined : githubRepoOf(entry.remote)) ?? '')
    const name = entry.name ?? defaultName(repo)
    return {
      was: name,
      repo,
      ...(i > 0 && entry.remote !== undefined && { remote: entry.remote }),
      name,
      ...(entry.base_branch !== undefined && { baseBranch: entry.base_branch }),
      ...(isMergeMethod(entry.merge_method) && { mergeMethod: entry.merge_method }),
      ...(entry.worktree?.setup && { setup: entry.worktree.setup }),
      ...(entry.worktree?.teardown && { teardown: entry.worktree.teardown }),
      env: Object.entries(entry.worktree?.env ?? {}).map(([n, value]) => ({ name: n, value })),
      copy: entry.worktree?.copy ?? [],
      apps: appsFrom(entry),
    }
  })
}

function appsFrom(entry: RepoSettings): AppInput[] {
  return (entry.apps ?? []).flatMap((app, was) => {
    if (typeof app !== 'object' || app === null) return []
    const fields = app as Record<string, unknown>
    const kind = appKinds.find((k) => k === fields.kind) ?? 'web'
    return [
      {
        was,
        name: typeof fields.name === 'string' ? fields.name : '',
        kind,
        run: typeof fields.run === 'string' ? fields.run : '',
        ...(typeof fields.url === 'string' && { url: fields.url }),
      },
    ]
  })
}

function isMergeMethod(value: string | undefined): value is 'squash' | 'merge' | 'rebase' {
  return value === 'squash' || value === 'merge' || value === 'rebase'
}

export function defaultName(repo: string): string {
  return (repo.split('/').at(-1) ?? repo).toLowerCase()
}

function remoteFor(stored: StoredRepo): string {
  return githubRepoOf(stored.cloneUrl) === undefined
    ? `https://github.com/${stored.repo}.git`
    : stored.cloneUrl
}

const envName = /^[A-Za-z_][A-Za-z0-9_]*$/
const repoPart = /^[A-Za-z0-9_.-]+$/

export function isRepo(repo: string): boolean {
  const parts = repo.split('/')
  return parts.length === 2 && parts.every((p) => repoPart.test(p) && !/^\.+$/.test(p))
}

export function inputProblems(
  changes: FactorySettingsChanges,
  current: readonly RepoSettingsInput[],
): WorkflowProblem[] {
  const problems: WorkflowProblem[] = []
  const add = (message: string) =>
    problems.push({ severity: 'error', file: workflowFile, line: 0, column: 0, message })
  if (changes.repos.length > maxFactoryRepos) {
    add(`A Factory has at most ${maxFactoryRepos} repos.`)
  }
  const primary = current[0]
  if (changes.repos[0]?.repo.toLowerCase() !== primary?.repo.toLowerCase()) {
    add('The primary repo can’t be removed or moved.')
  }
  for (const repo of changes.repos) {
    const label = repo.name || repo.repo
    if (repo.was !== undefined && !current.some((r) => r.was === repo.was)) {
      add(`${label} isn’t one of this Factory’s repos.`)
    }
    if (repo.was === undefined) {
      const remote = githubRepoOf(repo.remote ?? '')
      if (remote === undefined || !isRepo(repo.repo)) add(`${label} needs a GitHub remote.`)
      else if (remote.toLowerCase() !== repo.repo.toLowerCase()) {
        add(`${label}’s remote names another repo.`)
      }
    }
    const env = repo.env.filter((v) => v.name !== '' || v.value !== '')
    for (const variable of env) {
      if (variable.name === '') {
        add(`${label}: every environment variable needs a name.`)
      } else if (!envName.test(variable.name)) {
        add(`${label}: “${variable.name}” isn’t a valid environment variable name.`)
      } else if (isReservedEnvName(variable.name)) {
        add(`${label}: TED sets ${variable.name} itself, so it can’t be set here.`)
      }
    }
    if (new Set(env.map((v) => v.name)).size !== env.length) {
      add(`${label}: an environment variable is listed twice.`)
    }
    if (repo.copy.some((file) => file.trim() === '')) add(`${label}: a file to copy is empty.`)
    for (const app of repo.apps) {
      if (app.name.trim() === '') add(`${label}: every App needs a name.`)
      if (app.run.trim() === '') add(`${label}: the App ${app.name || ''} needs a run command.`)
    }
    if (new Set(repo.apps.map((a) => a.name.trim())).size !== repo.apps.length) {
      add(`${label}: two Apps have the same name.`)
    }
  }
  const checks = changes.checks ?? []
  for (const check of checks) {
    if (check.name.trim() === '') add('Every Check needs a name.')
    else if (check.run.trim() === '') add(`The Check ${check.name.trim()} needs a command.`)
    const timeout = check.timeout?.trim() ?? ''
    if (timeout !== '' && !/^\d+[smh]$/.test(timeout)) {
      add(`The Check ${check.name.trim()}’s timeout must be a duration such as 30s, 15m or 1h.`)
    }
  }
  if (new Set(checks.map((c) => c.name.trim())).size !== checks.length) {
    add('Two Checks have the same name.')
  }
  const limit = changes.maxWorkingRuns
  if (typeof limit === 'number' && (!Number.isInteger(limit) || limit < 1)) {
    add('The limit on working Runs must be a whole number above 0.')
  }
  return problems
}

export function applyChanges(
  text: string | undefined,
  changes: FactorySettingsChanges,
  current: readonly RepoSettingsInput[],
  basedOn: Partial<Record<AgentStageId, string | null>> = {},
): string {
  const doc =
    text === undefined || text.trim() === '' ? new Document({ version: 1 }) : parseDocument(text)
  if (!isMap(doc.contents)) doc.contents = doc.createNode({ version: 1 }) as YAMLMap
  const root = doc.contents as YAMLMap
  const existing = root.get('repos', true)
  const items = isSeq(existing) ? (existing.items as unknown[]) : []
  const originalIndex = (was: string) => current.findIndex((r) => r.was === was)

  const seq = new YAMLSeq()
  changes.repos.forEach((repo, position) => {
    const index = repo.was === undefined ? -1 : originalIndex(repo.was)
    const found = index >= 0 ? items[index] : undefined
    const map = isMap(found) ? (found as YAMLMap) : (doc.createNode({}) as YAMLMap)
    writeRepo(doc, map, repo, position === 0)
    seq.items.push(map)
  })
  if (isSeq(existing)) {
    existing.items = seq.items
  } else {
    root.set('repos', seq)
  }

  const renames = new Map<string, string>()
  for (const repo of changes.repos) {
    if (repo.was !== undefined && repo.was !== repo.name) renames.set(repo.was, repo.name)
  }
  const removed = new Set(
    current.map((r) => r.was).filter((was) => !changes.repos.some((r) => r.was === was)),
  )
  const checks = doc.getIn(['stages', 'validate', 'checks'], true)
  if (isSeq(checks)) {
    checks.items = (checks.items as unknown[]).filter((item) => {
      if (!isMap(item)) return true
      const repo = item.get('repo')
      if (typeof repo !== 'string') return true
      if (removed.has(repo)) return false
      const renamed = renames.get(repo)
      if (renamed !== undefined) setKeepingStyle(item, 'repo', renamed)
      return true
    })
  }

  for (const [id, stage] of Object.entries(changes.stages ?? {})) {
    if (!stage) continue
    const fields: [string, unknown][] = [
      ['enabled', stage.enabled],
      ['gate', stage.gate],
      ['max_back', stage.maxBack],
      ['depth', stage.depth],
    ]
    if (fields.every(([, value]) => value === undefined)) continue
    const map = stageMap(doc, root, id)
    for (const [key, value] of fields) if (value !== undefined) setKeepingStyle(map, key, value)
  }
  for (const [id, hash] of Object.entries(basedOn)) {
    if (hash === undefined) continue
    if (hash === null) {
      const stages: unknown = root.get('stages', true)
      const map = isMap(stages) ? stages.get(id, true) : undefined
      if (isMap(map)) {
        map.delete('based_on')
        if (map.items.length === 0) (stages as unknown as YAMLMap).delete(id)
      }
      if (isMap(stages) && stages.items.length === 0) root.delete('stages')
    } else setKeepingStyle(stageMap(doc, root, id), 'based_on', hash)
  }
  if (changes.checks !== undefined) {
    const kept = changes.checks.filter((c) => !removed.has(c.repo?.trim() ?? ''))
    writeChecks(doc, root, kept)
  }
  for (const role of agentRoles) {
    const choice = changes.agents?.[role]
    if (choice === undefined) continue
    if (choice === null) root.delete(role)
    else writeAgent(doc, root, role, choice)
  }
  if (changes.permissions !== undefined) setRoot(root, 'permissions', changes.permissions)
  if (changes.maxWorkingRuns === null) root.delete('max_working_runs')
  else if (changes.maxWorkingRuns !== undefined) {
    setRoot(root, 'max_working_runs', changes.maxWorkingRuns)
  }
  return keepOriginalStyle(text, doc.toString({ lineWidth: 0, flowCollectionPadding: false }))
}

const rootOrder = [
  'version',
  'lead',
  'reviewer',
  'planner',
  'permissions',
  'max_working_runs',
  'repos',
  'order',
  'stages',
]

function setRoot(root: YAMLMap, key: string, value: unknown): void {
  if (root.has(key)) return void setKeepingStyle(root, key, value)
  root.set(key, value)
  const rank = rootOrder.indexOf(key)
  const added = root.items.pop()
  if (!added) return
  const before = root.items.findIndex((pair) => {
    const other = rootOrder.indexOf(scalarKey(pair.key))
    return other === -1 || other > rank
  })
  if (before === -1) root.items.push(added)
  else root.items.splice(before, 0, added)
}

function stageMap(doc: Document, root: YAMLMap, id: string): YAMLMap {
  let stages: unknown = root.get('stages', true)
  if (!isMap(stages)) {
    stages = doc.createNode({})
    setRoot(root, 'stages', stages)
  }
  const stagesMap = stages as YAMLMap
  const found = stagesMap.get(id, true)
  if (isMap(found)) return found
  const map = doc.createNode({}) as YAMLMap
  stagesMap.set(id, map)
  return map
}

function writeChecks(doc: Document, root: YAMLMap, checks: readonly CheckInput[]): void {
  const stages: unknown = root.get('stages', true)
  const validate = isMap(stages) ? stages.get('validate', true) : undefined
  const node = isMap(validate) ? validate.get('checks', true) : undefined
  const old = isSeq(node) ? (node.items as unknown[]) : []
  if (checks.length === 0) {
    if (isMap(validate)) {
      validate.delete('checks')
      if (validate.items.length === 0) (stages as unknown as YAMLMap).delete('validate')
    }
    return
  }
  const flow = old.length === 0 || old.some((item) => isMap(item) && item.flow === true)
  const items = checks.map((check) => {
    const found = check.was === undefined ? undefined : old[check.was]
    const map = isMap(found) ? found : (doc.createNode({}) as YAMLMap)
    if (!isMap(found)) map.flow = flow
    setKeepingStyle(map, 'name', check.name.trim())
    setKeepingStyle(map, 'run', check.run.trim())
    setOrDelete(map, 'repo', check.repo?.trim() || undefined)
    setOrDelete(map, 'timeout', check.timeout?.trim() || undefined)
    return map
  })
  if (isSeq(node)) node.items = items
  else {
    const seq = new YAMLSeq()
    seq.items = items
    setKeepingStyle(stageMap(doc, root, 'validate'), 'checks', seq)
  }
}

function writeAgent(doc: Document, root: YAMLMap, role: string, choice: AgentChoiceInput): void {
  const fields = (['agent', 'model', 'effort'] as const).flatMap((key) => {
    const value = choice[key]?.trim()
    return value ? [[key, value] as const] : []
  })
  if (fields.length === 0) return void root.delete(role)
  const [first] = fields
  if (fields.length === 1 && first?.[0] === 'agent') return void setRoot(root, role, first[1])
  const existing = root.get(role, true)
  if (isMap(existing)) {
    for (const pair of [...existing.items]) {
      const key = scalarKey(pair.key)
      if (!fields.some(([k]) => k === key)) existing.delete(key)
    }
    for (const [key, value] of fields) setKeepingStyle(existing, key, value)
    return
  }
  const map = doc.createNode(Object.fromEntries(fields)) as YAMLMap
  map.flow = true
  setRoot(root, role, map)
}

const unpadded = (line: string) => line.replace(/([[{]) +/g, '$1').replace(/ +([\]}])/g, '$1')
const flowOnly = (line: string) => /^\s*(?:- )?(?:[\w-]+: )?[[{]/.test(line) && !/["'#]/.test(line)

function keepOriginalStyle(original: string | undefined, written: string): string {
  if (original === undefined) return written
  const flowLines = original.split('\n').filter(flowOnly)
  const lines = new Map(flowLines.map((line) => [unpadded(line), line]))
  const padded = (open: string) => {
    const spaced = flowLines.join('\n').split(`${open} `).length - 1
    const tight = flowLines.join('\n').split(open).length - 1 - spaced
    return spaced > tight
  }
  const pad = { '{': padded('{'), '[': padded('[') }
  const restyle = (line: string) =>
    line
      .replace(/\{(?=[^\s}])/g, pad['{'] ? '{ ' : '{')
      .replace(/(?<=[^\s{])\}/g, pad['{'] ? ' }' : '}')
      .replace(/\[(?=[^\s\]])/g, pad['['] ? '[ ' : '[')
      .replace(/(?<=[^\s[])\]/g, pad['['] ? ' ]' : ']')
  return written
    .split('\n')
    .map((line) => (flowOnly(line) ? (lines.get(line) ?? restyle(line)) : line))
    .join('\n')
}

function writeRepo(doc: Document, map: YAMLMap, repo: RepoSettingsInput, primary: boolean): void {
  const first = map.items[0]
  if (!first || scalarKey(first.key) !== 'name') {
    map.delete('name')
    map.items.unshift(doc.createPair('name', repo.name) as (typeof map.items)[number])
  } else setKeepingStyle(map, 'name', repo.name)
  if (!primary && repo.remote !== undefined && !map.has('remote')) {
    setKeepingStyle(map, 'remote', repo.remote)
  }
  setOrDelete(map, 'base_branch', repo.baseBranch?.trim() || undefined)
  setOrDelete(map, 'merge_method', repo.mergeMethod)

  const worktree = map.get('worktree', true)
  const tree = isMap(worktree) ? worktree : (doc.createNode({}) as YAMLMap)
  setCommand(doc, tree, 'setup', repo.setup)
  setCommand(doc, tree, 'teardown', repo.teardown)
  const env = repo.env.filter((v) => v.name !== '')
  const envNode = tree.get('env', true)
  if (env.length === 0) tree.delete('env')
  else {
    const envMap = isMap(envNode) ? envNode : (doc.createNode({}) as YAMLMap)
    for (const pair of [...envMap.items]) {
      const key = scalarKey(pair.key)
      if (!env.some((v) => v.name === key)) envMap.delete(key)
    }
    for (const variable of env) setKeepingStyle(envMap, variable.name, variable.value)
    if (!isMap(envNode)) setKeepingStyle(tree, 'env', envMap)
  }
  if (repo.copy.length === 0) tree.delete('copy')
  else {
    const copyNode = tree.get('copy', true)
    const flow = isSeq(copyNode) ? copyNode.flow === true : true
    const next = doc.createNode(repo.copy) as YAMLSeq
    next.flow = flow
    if (!isSeq(copyNode) || JSON.stringify(copyNode.toJSON()) !== JSON.stringify(repo.copy)) {
      setKeepingStyle(tree, 'copy', next)
    }
  }
  if (tree.items.length === 0) map.delete('worktree')
  else if (!isMap(worktree)) setKeepingStyle(map, 'worktree', tree)

  const appsNode = map.get('apps', true)
  const oldApps = isSeq(appsNode) ? (appsNode.items as unknown[]) : []
  if (repo.apps.length === 0) map.delete('apps')
  else {
    const apps = new YAMLSeq()
    for (const app of repo.apps) {
      const found = app.was === undefined ? undefined : oldApps[app.was]
      const appMap = isMap(found) ? found : (doc.createNode({}) as YAMLMap)
      setKeepingStyle(appMap, 'name', app.name.trim())
      if (app.kind === 'web' && !appMap.has('kind')) appMap.delete('kind')
      else setKeepingStyle(appMap, 'kind', app.kind)
      setKeepingStyle(appMap, 'run', app.run.trim())
      setOrDelete(appMap, 'url', app.kind === 'web' ? app.url?.trim() || undefined : undefined)
      apps.items.push(appMap)
    }
    if (isSeq(appsNode)) appsNode.items = apps.items
    else setKeepingStyle(map, 'apps', apps)
  }
}

function setCommand(
  doc: Document,
  tree: YAMLMap,
  key: 'setup' | 'teardown',
  command: WorktreeCommandInput | undefined,
): void {
  const run = command?.run.trim() ?? ''
  const timeout = command?.timeout?.trim() ?? ''
  if (run === '') return void tree.delete(key)
  if (timeout === '') {
    setKeepingStyle(tree, key, run)
    return
  }
  const node = tree.get(key, true)
  if (isMap(node)) {
    setKeepingStyle(node, 'run', run)
    setKeepingStyle(node, 'timeout', timeout)
  } else {
    const map = doc.createNode({ run, timeout }) as YAMLMap
    map.flow = true
    setKeepingStyle(tree, key, map)
  }
}

function setOrDelete(map: YAMLMap, key: string, value: string | undefined): void {
  if (value === undefined) map.delete(key)
  else setKeepingStyle(map, key, value)
}

const keyOrder = [
  'name',
  'remote',
  'base_branch',
  'merge_method',
  'worktree',
  'apps',
  'setup',
  'teardown',
  'env',
  'copy',
  'kind',
  'run',
  'url',
  'repo',
  'timeout',
  'agent',
  'model',
  'effort',
  'enabled',
  'gate',
  'max_back',
  'depth',
  'loop_check',
  'checks',
  'based_on',
]

function setKeepingStyle(map: YAMLMap, key: string, value: unknown): void {
  const node = map.get(key, true)
  if (isScalar(node) && typeof value !== 'object') {
    if (node.value !== value) node.value = value
    return
  }
  if (map.has(key)) return void map.set(key, value)
  map.set(key, value)
  const rank = keyOrder.indexOf(key)
  if (rank === -1) return
  const added = map.items.pop()
  if (!added) return
  const before = map.items.findIndex((pair) => keyOrder.indexOf(scalarKey(pair.key)) > rank)
  if (before === -1) map.items.push(added)
  else map.items.splice(before, 0, added)
}

function scalarKey(key: unknown): string {
  return isScalar(key) ? String(key.value) : String(key)
}

export function isAppKind(value: unknown): value is AppKind {
  return appKinds.some((k) => k === value)
}
