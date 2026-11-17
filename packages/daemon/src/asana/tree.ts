import {
  type LinearFile,
  type LinearUnfetched,
  maxAsanaComments,
  maxAsanaFiles,
  maxAsanaImportDepth,
  maxAsanaImportTasks,
} from '@ted/protocol'
import type { FileStore } from '../downloads.ts'
import { AsanaReadError } from './asana.ts'
import { fetchAsanaFiles } from './files.ts'

export type AsanaRead = (
  path: string,
  query?: Record<string, string>,
) => Promise<Record<string, unknown>>

export interface AsanaComment {
  author: string
  at: string
  text: string
}

export interface AsanaNode {
  gid: string
  name: string
  url: string
  completed: boolean
  depth: number
  parentGid?: string
  assignee?: { gid: string; name: string }
  notes?: string
  comments?: AsanaComment[]
  commentsWarning?: string
  files?: LinearFile[]
  unfetched?: LinearUnfetched[]
  unreadable?: string
  partial?: string[]
  cut?: boolean
  childrenUnreadable?: string
  projects?: { gid: string; name: string }[]
  children: string[]
}

export interface AsanaTree {
  rootGid: string
  nodes: Map<string, AsanaNode>
  tooBig?: string
}

const maxListed = 1000
const pageSize = 100
const parallel = 4
const maxWaitMs = 120_000
const maxName = 300
const maxNotes = 20_000
const maxDiscussion = 40_000
const retries = 3

export function retryingRead(
  read: AsanaRead,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): AsanaRead {
  return async (path, query = {}) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await read(path, query)
      } catch (error) {
        const retryable =
          error instanceof AsanaReadError &&
          (error.status === 429 || (error.status !== undefined && error.status >= 500))
        if (!retryable || attempt >= retries) throw error
        await wait(Math.min(error.retryAfterMs ?? 1000 * 2 ** attempt, maxWaitMs))
      }
    }
  }
}

export async function readAsanaTree(input: {
  read: AsanaRead
  rootGid: string
  files?: FileStore
  tracked?: ReadonlySet<string>
  allowLoopbackFiles?: boolean
  wait?: (ms: number) => Promise<void>
}): Promise<AsanaTree> {
  const read = retryingRead(input.read, input.wait)
  const nodes = new Map<string, AsanaNode>()
  const needsDetail = (n: AsanaNode) =>
    (n.depth === 0 || !n.completed) && !input.tracked?.has(n.gid)
  const root = await read(`/tasks/${input.rootGid}`, { opt_fields: taskFields })
  const rootNode = nodeFrom(root.data, 0, undefined)
  if (!rootNode || rootNode.gid !== input.rootGid)
    throw new AsanaReadError('Asana returned an incomplete task')
  nodes.set(rootNode.gid, rootNode)
  let tooBig: string | undefined
  let level = [rootNode]
  while (level.length > 0 && tooBig === undefined) {
    const next: AsanaNode[] = []
    await each(level, async (node) => {
      if (nodes.size > maxListed) return
      const listed = await subtasks(read, node.gid).catch((error: unknown) => {
        node.childrenUnreadable = reasonOf(error)
        return { items: [], more: false }
      })
      if (listed.more) node.childrenUnreadable = 'Asana didn’t finish listing its subtasks'
      for (const child of listed.items) {
        if (nodes.has(child.gid)) continue
        const made = { ...child, depth: node.depth + 1, parentGid: node.gid, children: [] }
        nodes.set(made.gid, made)
        node.children.push(made.gid)
        next.push(made)
      }
    })
    const counted = [...nodes.values()].filter(needsDetail).length
    const atLeast = next.length > 0 ? 'at least ' : ''
    if (nodes.size > maxListed)
      tooBig = `This item has more than ${maxListed} items under it. Ted imports at most ${maxAsanaImportTasks} Tasks at a time.`
    else if (counted > maxAsanaImportTasks)
      tooBig = `This item and the unfinished items under it make ${atLeast}${counted} Tasks. Ted imports at most ${maxAsanaImportTasks} at a time.`
    else if ((next[0]?.depth ?? 0) > maxAsanaImportDepth)
      tooBig = `This item’s subtasks go more than ${maxAsanaImportDepth} levels deep. Ted imports at most ${maxAsanaImportDepth} levels.`
    level = next
  }
  if (tooBig !== undefined) return { rootGid: rootNode.gid, nodes, tooBig }
  await each([...nodes.values()].filter(needsDetail), async (node) => {
    if (node.depth > 0) {
      try {
        const detail = nodeFrom(
          (await read(`/tasks/${node.gid}`, { opt_fields: taskFields })).data,
          node.depth,
          node.parentGid,
        )
        if (!detail) throw new AsanaReadError('Asana returned an incomplete task')
        Object.assign(node, { ...detail, children: node.children })
      } catch (error) {
        node.unreadable = reasonOf(error)
        return
      }
    }
    const partly = (what: string) => (error: unknown) => {
      node.partial = [...(node.partial ?? []), `Ted couldn’t copy ${what}: ${reasonOf(error)}`]
    }
    try {
      const discussion = await comments(read, node.gid)
      node.comments = discussion.comments
      if (discussion.cut) node.cut = true
      if (discussion.warning !== undefined) node.commentsWarning = discussion.warning
    } catch (error) {
      partly('its comments')(error)
    }
    try {
      const attached = await attachments(read, node.gid)
      if (input.files) {
        const got = await fetchAsanaFiles({
          attachments: attached.items,
          store: input.files,
          allowLoopback: input.allowLoopbackFiles === true,
        })
        node.files = got.files
        node.unfetched = [...got.unfetched, ...attached.unlisted]
      } else if (attached.unlisted.length > 0) {
        node.unfetched = attached.unlisted
      }
    } catch (error) {
      partly('its files')(error)
    }
  })
  return { rootGid: rootNode.gid, nodes }
}

const taskFields =
  'gid,name,notes,completed,permalink_url,assignee,assignee.gid,assignee.name,resource_subtype,memberships.project.gid,memberships.project.name'

export function nodeFrom(
  value: unknown,
  depth: number,
  parentGid: string | undefined,
): AsanaNode | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const task = value as Record<string, unknown>
  const gid = typeof task.gid === 'string' && /^\d{1,32}$/.test(task.gid) ? task.gid : undefined
  if (gid === undefined) return undefined
  const assignee = task.assignee as Record<string, unknown> | null | undefined
  const projects = projectsFrom(task.memberships)
  return {
    gid,
    name: oneLine(typeof task.name === 'string' ? task.name : '').slice(0, maxName) || '(untitled)',
    url: permalink(task.permalink_url, gid),
    completed: task.completed === true,
    depth,
    ...(parentGid !== undefined && { parentGid }),
    ...(assignee &&
      typeof assignee.gid === 'string' && {
        assignee: {
          gid: assignee.gid.slice(0, 32),
          name:
            oneLine(typeof assignee.name === 'string' ? assignee.name : '').slice(0, 200) ||
            'Someone',
        },
      }),
    ...(typeof task.notes === 'string' &&
      task.notes.trim() !== '' && { notes: task.notes.slice(0, maxNotes) }),
    ...(typeof task.notes === 'string' && task.notes.length > maxNotes && { cut: true }),
    ...(projects && { projects }),
    children: [],
  }
}

function projectsFrom(memberships: unknown): { gid: string; name: string }[] | undefined {
  if (!Array.isArray(memberships)) return undefined
  const projects: { gid: string; name: string }[] = []
  for (const membership of memberships) {
    const project = (membership as { project?: Record<string, unknown> } | null)?.project
    const gid = project?.gid
    if (typeof gid !== 'string' || !/^\d{1,32}$/.test(gid)) continue
    if (projects.some((p) => p.gid === gid)) continue
    const name = oneLine(typeof project?.name === 'string' ? project.name : '').slice(0, 200)
    projects.push({ gid, name: name || gid })
    if (projects.length === 50) break
  }
  return projects
}

function permalink(value: unknown, gid: string): string {
  if (typeof value === 'string' && URL.canParse(value)) {
    const url = new URL(value)
    if (url.protocol === 'https:' && url.host === 'app.asana.com' && !url.username) return url.href
  }
  return `https://app.asana.com/0/0/${gid}/f`
}

export async function pages(
  read: AsanaRead,
  path: string,
  query: Record<string, string>,
  limit: number,
): Promise<{ items: Record<string, unknown>[]; more: boolean }> {
  const items: Record<string, unknown>[] = []
  const seen = new Set<string>()
  let offset: string | undefined
  for (let page = 0; page < Math.ceil(limit / pageSize) + 1; page++) {
    const body = await read(path, {
      ...query,
      limit: String(pageSize),
      ...(offset !== undefined && { offset }),
    })
    if (!Array.isArray(body.data)) throw new AsanaReadError('Asana returned an incomplete list')
    for (const item of body.data) {
      if (typeof item === 'object' && item !== null) items.push(item as Record<string, unknown>)
    }
    const nextPage = body.next_page as Record<string, unknown> | null | undefined
    const nextOffset = typeof nextPage?.offset === 'string' ? nextPage.offset : undefined
    if (nextOffset === undefined) return { items, more: false }
    if (seen.has(nextOffset) || items.length >= limit) return { items, more: true }
    seen.add(nextOffset)
    offset = nextOffset
  }
  return { items, more: true }
}

async function subtasks(
  read: AsanaRead,
  gid: string,
): Promise<{ items: Omit<AsanaNode, 'depth' | 'children'>[]; more: boolean }> {
  const listed = await pages(
    read,
    `/tasks/${gid}/subtasks`,
    { opt_fields: 'gid,name,completed,permalink_url' },
    maxListed + 1,
  )
  return {
    more: listed.more,
    items: listed.items.flatMap((item) => {
      const node = nodeFrom(item, 0, undefined)
      if (!node) return []
      const { depth: _depth, children: _children, ...rest } = node
      return [rest]
    }),
  }
}

async function comments(
  read: AsanaRead,
  gid: string,
): Promise<{ comments: AsanaComment[]; warning?: string; cut?: boolean }> {
  const listed = await pages(
    read,
    `/tasks/${gid}/stories`,
    { opt_fields: 'type,resource_subtype,text,created_at,created_by.name' },
    maxAsanaComments * 5,
  )
  const all = listed.items.filter((story) => story.resource_subtype === 'comment_added')
  let remaining = maxDiscussion
  const shortened = { any: false }
  const taken = all.slice(0, maxAsanaComments).flatMap((story) => {
    if (remaining <= 0) {
      shortened.any = true
      return []
    }
    const by = story.created_by as Record<string, unknown> | null | undefined
    const text = typeof story.text === 'string' ? story.text : ''
    if (text.length > remaining) shortened.any = true
    const kept = text.slice(0, remaining)
    remaining -= kept.length
    return [
      {
        author: oneLine(typeof by?.name === 'string' ? by.name : '').slice(0, 200) || 'Someone',
        at: typeof story.created_at === 'string' ? story.created_at.slice(0, 40) : '',
        text: kept,
      },
    ]
  })
  const cut = all.length > maxAsanaComments || listed.more
  return {
    comments: taken,
    ...(shortened.any && { cut: true }),
    ...(cut && {
      warning: `Ted copied the first ${taken.length} comments from Asana; read the rest there.`,
    }),
  }
}

export interface AsanaAttachment {
  name: string
  host: string
  downloadUrl?: string
  viewUrl: string
}

async function attachments(
  read: AsanaRead,
  gid: string,
): Promise<{ items: AsanaAttachment[]; unlisted: LinearUnfetched[] }> {
  const listed = await pages(
    read,
    '/attachments',
    { parent: gid, opt_fields: 'name,host,download_url,view_url,permanent_url' },
    maxAsanaFiles * 5,
  )
  const all = listed.items.map((item) => {
    const view = [item.permanent_url, item.view_url].find(
      (u): u is string => typeof u === 'string' && URL.canParse(u),
    )
    return {
      name: oneLine(typeof item.name === 'string' ? item.name : '').slice(0, 200) || 'file',
      host: typeof item.host === 'string' ? item.host : '',
      ...(typeof item.download_url === 'string' && { downloadUrl: item.download_url }),
      viewUrl: view ?? `https://app.asana.com/0/0/${gid}/f`,
    }
  })
  const external = all.filter((a) => a.host !== 'asana' || a.downloadUrl === undefined)
  const own = all.filter((a) => a.host === 'asana' && a.downloadUrl !== undefined)
  return {
    items: own.slice(0, maxAsanaFiles),
    unlisted: [
      ...external.map((a) => ({
        name: a.name,
        url: a.viewUrl,
        reason: 'it’s stored outside Asana',
      })),
      ...own.slice(maxAsanaFiles).map((a) => ({
        name: a.name,
        url: a.viewUrl,
        reason: `Ted takes at most ${maxAsanaFiles} files from an item`,
      })),
      ...(listed.more
        ? [
            {
              name: 'more files',
              url: `https://app.asana.com/0/0/${gid}/f`,
              reason: 'Asana listed more files than Ted reads',
            },
          ]
        : []),
    ],
  }
}

export async function each<T>(
  items: readonly T[],
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]
      if (item !== undefined) await work(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallel, items.length) }, worker))
}

export function reasonOf(error: unknown): string {
  if (error instanceof AsanaReadError) {
    if (error.status === 403) return 'Asana didn’t let Ted read it (no access)'
    if (error.status === 404) return 'Asana couldn’t find it'
    return error.message
  }
  return 'Ted couldn’t read it from Asana'
}

export function oneLine(text: string): string {
  return [...text]
    .map((c) => {
      const code = c.codePointAt(0) ?? 0
      return code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029 ? ' ' : c
    })
    .join('')
    .replace(/ {2,}/g, ' ')
    .trim()
}
