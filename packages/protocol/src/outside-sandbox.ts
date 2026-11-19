import { isArray, isObject, isString, type Json, reader, type Untyped } from './parse.ts'
import { RequestValidationError as HttpError } from './validation.ts'

export interface OutsideSandboxApproval {
  repo: string
  app: string
  declaration: string
}

export type OutsideSandboxApprovals = Readonly<Record<string, readonly OutsideSandboxApproval[]>>

const maxPerFactory = 100
const declarationPattern = /^[0-9a-f]{64}$/

function fail(message: string): never {
  throw new HttpError(400, message)
}
const read = reader(fail)

function name(value: Json | undefined): string | undefined {
  return isString(value) && value.trim() !== '' && value.length <= 200 ? value : undefined
}

function approval(value: Json | undefined): OutsideSandboxApproval | undefined {
  if (!isObject(value)) return undefined
  const repo = name(value.repo)
  const app = name(value.app)
  const declaration = value.declaration
  if (repo === undefined || app === undefined) return undefined
  if (!isString(declaration) || !declarationPattern.test(declaration)) return undefined
  return { repo, app, declaration }
}

function latestPerApp(list: OutsideSandboxApproval[]): OutsideSandboxApproval[] {
  const byApp = new Map<string, OutsideSandboxApproval>()
  for (const entry of list) byApp.set(JSON.stringify([entry.repo, entry.app]), entry)
  return [...byApp.values()]
}

export function readOutsideSandboxApprovals(value: Untyped): OutsideSandboxApprovals {
  if (!isObject(value)) return {}
  return Object.fromEntries(
    Object.entries(value).flatMap(([factoryId, list]) => {
      if (!isArray(list)) return []
      const kept = latestPerApp(list.flatMap((entry) => approval(entry) ?? []))
      return kept.length === 0 ? [] : [[factoryId, kept]]
    }),
  )
}

export function parseOutsideSandboxApprovalsRequest(value: Untyped): OutsideSandboxApprovals {
  const body = read.object(
    value,
    'appsOutsideSandbox',
    'appsOutsideSandbox must be an object of approved Apps by Factory ID',
  )
  const problem =
    'appsOutsideSandbox lists, for each Factory, Apps as { repo, app, declaration } with a SHA-256 declaration'
  return Object.fromEntries(
    Object.keys(body).map((factoryId) => {
      const list = read.list(body, factoryId, problem)
      if (list.length > maxPerFactory) fail(problem)
      return [factoryId, latestPerApp(list.map((entry) => approval(entry) ?? fail(problem)))]
    }),
  )
}

export function approvedOutsideSandbox(
  approvals: readonly OutsideSandboxApproval[] | undefined,
  wanted: OutsideSandboxApproval,
): boolean {
  return (approvals ?? []).some(
    (a) => a.repo === wanted.repo && a.app === wanted.app && a.declaration === wanted.declaration,
  )
}

export function withOutsideSandboxApproval(
  approvals: readonly OutsideSandboxApproval[] | undefined,
  added: OutsideSandboxApproval,
): OutsideSandboxApproval[] {
  return [...(approvals ?? []).filter((a) => a.repo !== added.repo || a.app !== added.app), added]
}
