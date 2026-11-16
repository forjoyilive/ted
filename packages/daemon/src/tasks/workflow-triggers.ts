import { isArray, isObject, isString, type Json, type Untyped } from '@ted/protocol/parse'
import { parse } from 'yaml'

export interface PushedBranch {
  branch: string
  base: string
}

const pullRequestTriggers = ['pull_request', 'pull_request_target']

export function runsOnChanges(workflow: string, pushed: PushedBranch): boolean {
  let document: Untyped
  try {
    document = parse(workflow)
  } catch {
    return true
  }
  return triggersRun(isObject(document) ? document.on : undefined, pushed)
}

function triggersRun(on: Json | undefined, pushed: PushedBranch): boolean {
  if (isString(on)) return runsOn(on, undefined, pushed)
  if (isArray(on))
    return on.some((trigger) => !isString(trigger) || runsOn(trigger, undefined, pushed))
  if (isObject(on)) {
    return Object.entries(on).some(([trigger, filters]) => runsOn(trigger, filters, pushed))
  }
  return true
}

function runsOn(trigger: string, filters: Json | undefined, pushed: PushedBranch): boolean {
  if (trigger === 'merge_group') return true
  if (trigger === 'push') return pushRuns(filters, pushed.branch)
  if (pullRequestTriggers.includes(trigger)) {
    return pushEventTypes(filters) && branchesMatch(filters, pushed.base)
  }
  return false
}

const pullRequestEventsFromPushes = ['opened', 'synchronize', 'reopened', 'ready_for_review']

function pushEventTypes(filters: Json | undefined): boolean {
  if (!isObject(filters) || filters.types === undefined) return true
  const types = patterns(filters.types)
  if (types === null || types === undefined) return true
  return types.some((type) => pullRequestEventsFromPushes.includes(type))
}

function pushRuns(filters: Json | undefined, branch: string): boolean {
  if (!isObject(filters)) return true
  const branchFilter = filters.branches !== undefined || filters['branches-ignore'] !== undefined
  const tagFilter = filters.tags !== undefined || filters['tags-ignore'] !== undefined
  if (tagFilter && !branchFilter) return false
  return branchesMatch(filters, branch)
}

function branchesMatch(filters: Json | undefined, branch: string): boolean {
  if (!isObject(filters)) return true
  const branches = patterns(filters.branches)
  const ignored = patterns(filters['branches-ignore'])
  if (branches === null || ignored === null) return true
  const all = [...(branches ?? []), ...(ignored ?? [])]
  if (all.some((pattern) => patternRegex(pattern.replace(/^!/, '')) === undefined)) return true
  if (branches !== undefined) return included(branches, branch)
  if (ignored !== undefined)
    return !ignored.some((pattern) => filterMatches(pattern, branch) === true)
  return true
}

function patterns(value: Json | undefined): string[] | undefined | null {
  if (value === undefined) return undefined
  if (isString(value)) return [value]
  if (isArray(value) && value.every(isString)) return value.filter(isString)
  return null
}

function included(list: readonly string[], branch: string): boolean {
  let matched = false
  for (const pattern of list) {
    if (pattern.startsWith('!')) {
      if (filterMatches(pattern.slice(1), branch) === true) matched = false
    } else if (filterMatches(pattern, branch) === true) matched = true
  }
  return matched
}

const maxPatternLength = 200
const maxWildcards = 3

export function filterMatches(pattern: string, branch: string): boolean | undefined {
  return patternRegex(pattern)?.test(branch)
}

function patternRegex(pattern: string): RegExp | undefined {
  const compact = pattern.replace(/\*{3,}/g, '**')
  const wildcards = compact.match(/\*\*|[*?+]/g)?.length ?? 0
  if (compact.length > maxPatternLength || wildcards > maxWildcards) return undefined
  try {
    return new RegExp(`^${patternSource(compact)}$`)
  } catch {
    return undefined
  }
}

function patternSource(pattern: string): string {
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern.charAt(i)
    if (char === '*' && pattern.charAt(i + 1) === '*') {
      source += '.*'
      i++
    } else if (char === '*') source += '[^/]*'
    else if (char === '?' || char === '+') source += char
    else if (char === '[') {
      const end = pattern.indexOf(']', i + 1)
      if (end === -1) source += '\\['
      else {
        source += `[${pattern.slice(i + 1, end).replace(/\\/g, '\\\\')}]`
        i = end
      }
    } else source += char.replace(/[.^$|(){}\\\]]/g, '\\$&')
  }
  return source
}
