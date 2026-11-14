import { type AsanaIntakeScope, type AsanaRef, maxAsanaImportDepth } from '@ted/protocol'
import { RequestError } from '../errors.ts'
import { redactSecrets } from '../redact.ts'
import { AsanaReadError } from './asana.ts'
import { type AsanaRead, nodeFrom, oneLine, pages, reasonOf } from './tree.ts'

const maxListed = 1000

export interface IntakeItem {
  gid: string
  name: string
  url: string
}

export type RootCheck =
  | (IntakeItem & { kind: 'root'; ancestors: string[] })
  | (IntakeItem & { kind: 'outside'; reason: string })
  | (IntakeItem & { kind: 'unreadable'; reason: string })

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const gidOf = (value: unknown): string | undefined => {
  const gid = record(value)?.gid
  return typeof gid === 'string' && /^\d{1,32}$/.test(gid) ? gid : undefined
}

const refFrom = (value: unknown, saved: AsanaRef): AsanaRef => {
  const name = record(value)?.name
  const clean = typeof name === 'string' ? oneLine(name).slice(0, 500) : ''
  return { gid: saved.gid, name: clean || saved.name }
}

export const scopeName = (scope: AsanaIntakeScope) =>
  scope.section ? `${scope.project.name} › ${scope.section.name}` : scope.project.name

export async function confirmAsanaScope(
  read: AsanaRead,
  scope: AsanaIntakeScope,
): Promise<AsanaIntakeScope> {
  const stale = (why: string) =>
    new RequestError(
      409,
      `The Asana intake choice for this Factory is out of date: ${why}. Choose the project again in Factory settings.`,
    )
  try {
    const workspace = record(
      (await read(`/workspaces/${scope.workspace.gid}`, { opt_fields: 'name' })).data,
    )
    const project = record(
      (
        await read(`/projects/${scope.project.gid}`, {
          opt_fields: 'name,archived,workspace',
        })
      ).data,
    )
    if (gidOf(workspace) !== scope.workspace.gid) throw stale('Asana didn’t return the workspace')
    if (gidOf(project) !== scope.project.gid) throw stale('Asana didn’t return the project')
    if (gidOf(project?.workspace) !== scope.workspace.gid)
      throw stale(`${scope.project.name} isn’t in ${scope.workspace.name}`)
    if (project?.archived === true) throw stale(`${scope.project.name} is archived`)
    let section: AsanaRef | undefined
    if (scope.section) {
      const found = record(
        (await read(`/sections/${scope.section.gid}`, { opt_fields: 'name,project' })).data,
      )
      if (gidOf(found) !== scope.section.gid || gidOf(found?.project) !== scope.project.gid)
        throw stale(`${scope.section.name} isn’t a section of ${scope.project.name}`)
      section = refFrom(found, scope.section)
    }
    return {
      workspace: refFrom(workspace, scope.workspace),
      project: refFrom(project, scope.project),
      ...(section && { section }),
    }
  } catch (error) {
    if (error instanceof RequestError) throw error
    const status = error instanceof AsanaReadError ? error.status : undefined
    if (status === 403 || status === 404)
      throw stale('Asana can’t find it or the connected account can’t open it')
    throw new RequestError(
      409,
      redactSecrets(
        `Couldn’t confirm the Asana intake choice with Asana: ${error instanceof Error ? error.message : 'unknown error'}. Try again later.`,
      ),
    )
  }
}

export async function listAsanaIntake(
  read: AsanaRead,
  scope: AsanaIntakeScope,
): Promise<{ items: IntakeItem[]; incomplete?: string }> {
  const path = scope.section
    ? `/sections/${scope.section.gid}/tasks`
    : `/projects/${scope.project.gid}/tasks`
  try {
    const listed = await pages(
      read,
      path,
      { completed_since: 'now', opt_fields: 'gid,name,completed,permalink_url' },
      maxListed,
    )
    const items = listed.items.flatMap((item) => {
      const node = nodeFrom(item, 0, undefined)
      return node && !node.completed ? [{ gid: node.gid, name: node.name, url: node.url }] : []
    })
    return {
      items: items.slice(0, maxListed),
      ...(listed.more && {
        incomplete: `Asana listed more than ${maxListed} unfinished tasks in ${scopeName(scope)}; TED checked the first ${maxListed}.`,
      }),
    }
  } catch (error) {
    return {
      items: [],
      incomplete: redactSecrets(
        `TED couldn’t list the tasks in ${scopeName(scope)}: ${reasonOf(error)}. The next run tries again.`,
      ),
    }
  }
}

export async function checkAsanaRoot(input: {
  read: AsanaRead
  scope: AsanaIntakeScope
  userGid: string
  gid: string
  parents?: Map<string, string | null>
}): Promise<RootCheck> {
  const { read, scope, userGid, gid } = input
  const parents = input.parents ?? new Map<string, string | null>()
  let item: IntakeItem = { gid, name: gid, url: `https://app.asana.com/0/0/${gid}/f` }
  try {
    const data = record(
      (
        await read(`/tasks/${gid}`, {
          opt_fields:
            'name,completed,permalink_url,assignee,assignee.name,parent,memberships.project,memberships.section',
        })
      ).data,
    )
    const node = nodeFrom(data, 0, undefined)
    if (!data || !node || node.gid !== gid)
      throw new AsanaReadError('Asana returned an incomplete task')
    item = { gid, name: node.name, url: node.url }
    if (node.completed) return { ...item, kind: 'outside', reason: 'it’s complete in Asana' }
    if (node.assignee?.gid !== userGid)
      return { ...item, kind: 'outside', reason: 'it isn’t assigned to you in Asana' }
    const memberships = Array.isArray(data.memberships) ? data.memberships : []
    const inScope = memberships.some((m) => {
      const membership = record(m)
      return (
        gidOf(membership?.project) === scope.project.gid &&
        (scope.section === undefined || gidOf(membership?.section) === scope.section.gid)
      )
    })
    if (!inScope)
      return { ...item, kind: 'outside', reason: `it isn’t in ${scopeName(scope)} in Asana` }
    const ancestors: string[] = []
    parents.set(gid, gidOf(data.parent) ?? null)
    let at = parents.get(gid) ?? null
    while (at !== null) {
      if (ancestors.includes(at) || at === gid)
        return { ...item, kind: 'unreadable', reason: 'Asana reported a loop of parent tasks' }
      if (ancestors.length >= maxAsanaImportDepth)
        return {
          ...item,
          kind: 'unreadable',
          reason: `it sits more than ${maxAsanaImportDepth} levels under other tasks`,
        }
      ancestors.push(at)
      let parent = parents.get(at)
      if (parent === undefined) {
        const above = record((await read(`/tasks/${at}`, { opt_fields: 'parent' })).data)
        if (gidOf(above) !== at) throw new AsanaReadError('Asana returned an incomplete task')
        parent = gidOf(above?.parent) ?? null
        parents.set(at, parent)
      }
      at = parent
    }
    return { ...item, kind: 'root', ancestors }
  } catch (error) {
    return { ...item, kind: 'unreadable', reason: redactSecrets(reasonOf(error)) }
  }
}
