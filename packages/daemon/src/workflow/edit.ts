import {
  type AppInput,
  type AppKind,
  appKinds,
  type FactorySettingsChanges,
  type RepoSettingsInput,
  type WorkflowProblem,
  type WorktreeCommandInput,
} from '@ted/protocol'
import { Document, isMap, isScalar, isSeq, parseDocument, type YAMLMap, YAMLSeq } from 'yaml'
import {
  githubRepoOf,
  isReservedEnvName,
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

export function inputProblems(
  changes: FactorySettingsChanges,
  current: readonly RepoSettingsInput[],
): WorkflowProblem[] {
  const problems: WorkflowProblem[] = []
  const add = (message: string) =>
    problems.push({ severity: 'error', file: workflowFile, line: 0, column: 0, message })
  const primary = current[0]
  if (changes.repos[0]?.repo.toLowerCase() !== primary?.repo.toLowerCase()) {
    add('The primary repo can’t be removed or moved.')
  }
  for (const repo of changes.repos) {
    const label = repo.name || repo.repo
    if (repo.was !== undefined && !current.some((r) => r.was === repo.was)) {
      add(`${label} isn’t one of this Factory’s repos.`)
    }
    if (repo.was === undefined && githubRepoOf(repo.remote ?? '') === undefined) {
      add(`${label} needs a GitHub remote.`)
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
  return problems
}

export function applyChanges(
  text: string | undefined,
  changes: FactorySettingsChanges,
  current: readonly RepoSettingsInput[],
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
  return keepOriginalStyle(text, doc.toString({ lineWidth: 0, flowCollectionPadding: false }))
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
  'timeout',
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
