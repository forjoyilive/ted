import type { FactoryLayout } from './factory.ts'
import { isString, type JsonObject, reader, type Untyped } from './parse.ts'
import { RequestValidationError as HttpError } from './validation.ts'

export interface BacklogStarts {
  enabled: boolean
  all: boolean
  groupIds: readonly string[]
  factoryIds: readonly string[]
  includeAgentFiled: boolean
  includeGitHubIssues: boolean
}

export type SetBacklogStartsRequest = BacklogStarts

export const noBacklogStarts: BacklogStarts = {
  enabled: false,
  all: false,
  groupIds: [],
  factoryIds: [],
  includeAgentFiled: false,
  includeGitHubIssues: false,
}

const maxIds = 500

function fail(message: string): never {
  throw new HttpError(400, message)
}
const read = reader(fail)

function ids(body: JsonObject, field: string): string[] {
  const problem = `${field} must be a list of IDs`
  const list = read.list(body, field, problem)
  if (list.length > maxIds) fail(`${field} can hold at most ${maxIds} IDs`)
  const values = list.map((value) => {
    if (!isString(value) || !value.trim() || value.length > 200) fail(problem)
    return value
  })
  return [...new Set(values)]
}

export function parseSetBacklogStartsRequest(value: Untyped): SetBacklogStartsRequest {
  const body = read.object(value, 'backlog starts', 'backlog starts must be an object')
  return {
    enabled: read.boolean(body, 'enabled'),
    all: read.boolean(body, 'all'),
    groupIds: ids(body, 'groupIds'),
    factoryIds: ids(body, 'factoryIds'),
    includeAgentFiled: read.optional(body, 'includeAgentFiled', read.boolean) ?? false,
    includeGitHubIssues: read.optional(body, 'includeGitHubIssues', read.boolean) ?? false,
  }
}

export function backlogStartFactories(
  starts: BacklogStarts,
  layout: FactoryLayout,
): ReadonlySet<string> | 'all' | 'none' {
  if (!starts.enabled) return 'none'
  if (starts.all) return 'all'
  const chosen = new Set(starts.factoryIds)
  for (const item of layout.items) {
    if ('group' in item && starts.groupIds.includes(item.group.id))
      for (const id of item.group.factoryIds) chosen.add(id)
  }
  return chosen
}

export function startsFromBacklog(
  starts: BacklogStarts,
  layout: FactoryLayout,
  factoryId: string,
): boolean {
  const from = backlogStartFactories(starts, layout)
  return from === 'all' || (from !== 'none' && from.has(factoryId))
}

export function sameBacklogStarts(a: BacklogStarts, b: BacklogStarts): boolean {
  const same = (x: readonly string[], y: readonly string[]) =>
    x.length === y.length && x.every((id) => y.includes(id))
  return (
    a.enabled === b.enabled &&
    a.all === b.all &&
    a.includeAgentFiled === b.includeAgentFiled &&
    a.includeGitHubIssues === b.includeGitHubIssues &&
    same(a.groupIds, b.groupIds) &&
    same(a.factoryIds, b.factoryIds)
  )
}

export function withoutGroups(
  starts: BacklogStarts,
  before: FactoryLayout,
  after: FactoryLayout,
): BacklogStarts {
  const kept = new Set(after.items.flatMap((item) => ('group' in item ? [item.group.id] : [])))
  const gone = starts.groupIds.filter((id) => !kept.has(id))
  if (gone.length === 0) return starts
  const members = before.items.flatMap((item) =>
    'group' in item && gone.includes(item.group.id) ? item.group.factoryIds : [],
  )
  return {
    ...starts,
    groupIds: starts.groupIds.filter((id) => kept.has(id)),
    factoryIds: [...new Set([...starts.factoryIds, ...members])],
  }
}
