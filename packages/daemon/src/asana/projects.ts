import type { AsanaProjectList, AsanaProjectOption } from '@ted/protocol'
import { RequestError } from '../errors.ts'
import { redactSecrets } from '../redact.ts'
import { AsanaReadError } from './asana.ts'
import { type AsanaRead, pages } from './tree.ts'

const maxWorkspaces = 20
const maxProjectsPerWorkspace = 500
const maxName = 200

const gidOf = (value: unknown): string | undefined => {
  const gid = (value as { gid?: unknown } | null | undefined)?.gid
  return typeof gid === 'string' && /^\d{1,32}$/.test(gid) ? gid : undefined
}

const nameOf = (value: unknown, fallback: string): string => {
  const name = (value as { name?: unknown } | null | undefined)?.name
  const line = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, maxName) : ''
  return line || fallback
}

export async function listAsanaProjects(read: AsanaRead): Promise<AsanaProjectList> {
  try {
    const workspaces = await pages(read, '/workspaces', { opt_fields: 'name' }, maxWorkspaces)
    let complete = !workspaces.more
    const projects: AsanaProjectOption[] = []
    for (const workspace of workspaces.items.slice(0, maxWorkspaces)) {
      const workspaceGid = gidOf(workspace)
      if (workspaceGid === undefined) continue
      const listed = await pages(
        read,
        `/workspaces/${workspaceGid}/projects`,
        { opt_fields: 'name,archived', archived: 'false' },
        maxProjectsPerWorkspace,
      )
      if (listed.more) complete = false
      for (const project of listed.items.slice(0, maxProjectsPerWorkspace)) {
        const gid = gidOf(project)
        if (gid === undefined || project.archived === true) continue
        if (projects.some((p) => p.gid === gid)) continue
        projects.push({
          gid,
          name: nameOf(project, gid),
          workspace: nameOf(workspace, workspaceGid),
        })
      }
    }
    return { projects, complete }
  } catch (error) {
    throw readFailure(error, 'Couldn’t list Asana projects')
  }
}

export async function confirmAsanaProject(
  read: AsanaRead,
  gid: string,
): Promise<{ gid: string; name: string }> {
  try {
    const project = (await read(`/projects/${gid}`, { opt_fields: 'name,archived' })).data
    if (gidOf(project) !== gid) throw new RequestError(409, 'Asana didn’t return that project')
    if ((project as { archived?: unknown }).archived === true)
      throw new RequestError(409, 'That Asana project is archived')
    return { gid, name: nameOf(project, gid) }
  } catch (error) {
    if (error instanceof RequestError) throw error
    throw readFailure(error, 'Couldn’t check the Asana project')
  }
}

function readFailure(error: unknown, what: string): RequestError {
  const status = error instanceof AsanaReadError ? error.status : undefined
  if (status === 403 || status === 404)
    return new RequestError(409, `${what}: the connected account can’t open it.`)
  return new RequestError(
    409,
    redactSecrets(`${what}: ${error instanceof Error ? error.message : 'unknown error'}`),
  )
}
