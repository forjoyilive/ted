import { type AsanaTaskUrl, asanaSyncing, parseAsanaTaskUrl } from '@ted/protocol'
import { AsanaReadError } from '../asana/asana.ts'
import type { Clock } from '../clock.ts'
import type { TedStore } from '../store/index.ts'
import {
  type TrackerConnector,
  type TrackerItem,
  type TrackerRecords,
  TrackerWait,
} from './tracker-sync/connector.ts'
import { trackerRecords } from './tracker-sync/records.ts'
import {
  createTrackerSync,
  type TrackerSync,
  type TrackerTaskActions,
} from './tracker-sync/sync.ts'

export interface AsanaSyncApi {
  read(path: string, query?: Record<string, string>): Promise<Record<string, unknown>>
  comment(gid: string, text: string, account: string): Promise<void>
  complete(gid: string, account: string): Promise<void>
  account(): Promise<string | undefined>
}

export interface AsanaItem {
  gid: string
  completed: boolean
  subtasks: number
  account: string
}

export interface AsanaSyncOptions {
  store: TedStore
  asana: AsanaSyncApi
  actions: TrackerTaskActions
  clock?: Clock
  everyMs: number
  requestsPerCycle?: number
  inBackground(what: string, work: () => Promise<void>): void
}

export const asanaTracker = 'asana'
const maxPages = 5
const pageSize = '100'

export function mentions(text: unknown, url: string): boolean {
  if (typeof text !== 'string') return false
  for (let at = text.indexOf(url); at !== -1; at = text.indexOf(url, at + 1)) {
    const before = at === 0 ? '' : (text[at - 1] ?? '')
    if (!/[\w/]/.test(text[at + url.length] ?? '') && !/[^\s(<[{"'“‘]/.test(before)) return true
  }
  return false
}

export function asanaComment(pullRequest: { url: string; title: string }): string {
  return `TED opened a pull request for this task: ${pullRequest.title} ${pullRequest.url}`
}

export function asanaConnector(
  store: TedStore,
  asana: AsanaSyncApi,
  requestsPerCycle = 100,
): TrackerConnector<AsanaTaskUrl, AsanaItem> {
  let left = 0
  let start = 0

  const spend = () => {
    if (left <= 0) throw new TrackerWait(0)
    left--
  }
  const waitOn = (error: unknown): never => {
    if (error instanceof AsanaReadError && error.retryAfterMs !== undefined)
      throw new TrackerWait(error.retryAfterMs)
    throw error
  }

  async function pages(
    path: string,
    fields: string,
    found: (row: Record<string, unknown>) => boolean,
  ): Promise<{ rows: Record<string, unknown>[]; complete: boolean }> {
    const rows: Record<string, unknown>[] = []
    let offset: string | undefined
    for (let page = 0; page < maxPages; page++) {
      spend()
      const body = await asana
        .read(path, {
          opt_fields: fields,
          limit: pageSize,
          ...(offset !== undefined && { offset }),
        })
        .catch(waitOn)
      const data = Array.isArray(body.data) ? body.data : []
      for (const row of data) {
        if (typeof row !== 'object' || row === null) continue
        const record = row as Record<string, unknown>
        rows.push(record)
        if (found(record)) return { rows, complete: true }
      }
      const next = (body.next_page as { offset?: unknown } | null | undefined)?.offset
      if (typeof next !== 'string' || next === '') return { rows, complete: true }
      offset = next
    }
    return { rows, complete: false }
  }

  return {
    id: asanaTracker,
    name: 'Asana',
    groupNoun: 'project',
    enabled: (settings) => settings.asanaSync,
    source: (url) => parseAsanaTaskUrl(url),
    key: (link) => link.gid,
    label: (link) => link.gid,
    async read(links) {
      const account = await asana.account().catch(() => undefined)
      store.setAsanaConnection(account)
      if (account === undefined) return undefined
      left = requestsPerCycle
      const gids = [...new Set(links.map((link) => link.gid))]
      const offset = gids.length === 0 ? 0 : start % gids.length
      const order = [...gids.slice(offset), ...gids.slice(0, offset)]
      const items = new Map<string, TrackerItem<AsanaItem>>()
      let read = 0
      for (const gid of order) {
        if (left <= Math.floor(requestsPerCycle / 2) && read > 0) break
        left--
        read++
        let body: Record<string, unknown>
        try {
          body = await asana.read(`/tasks/${gid}`, { opt_fields: 'completed,num_subtasks' })
        } catch (error) {
          if (error instanceof AsanaReadError && error.retryAfterMs !== undefined)
            return { waitMs: error.retryAfterMs }
          if (error instanceof AsanaReadError && (error.status === 403 || error.status === 404))
            continue
          break
        }
        const data = body.data as Record<string, unknown> | undefined
        if (!data || typeof data.completed !== 'boolean') continue
        const subtasks = typeof data.num_subtasks === 'number' ? data.num_subtasks : 1
        items.set(gid, {
          closed: data.completed,
          state: data.completed ? 'Completed' : 'Open',
          handle: { gid, completed: data.completed, subtasks, account },
        })
      }
      start = offset + read
      return { items }
    },
    steps: ['completed'],
    async advance({ task, merged, item }) {
      if (!merged) return undefined
      if (item.handle.completed) {
        store.setAsanaOpenChildren(task.id, undefined)
        return { step: 'completed' }
      }
      if (item.handle.subtasks > 0) {
        const { rows, complete } = await pages(
          `/tasks/${item.handle.gid}/subtasks`,
          'completed',
          () => false,
        )
        const open = rows.filter((row) => row.completed !== true).length
        if (open > 0 || !complete) {
          store.setAsanaOpenChildren(task.id, Math.max(open, 1))
          return undefined
        }
      }
      spend()
      await asana.complete(item.handle.gid, item.handle.account).catch(waitOn)
      store.setAsanaOpenChildren(task.id, undefined)
      return { step: 'completed', moved: 'Completed' }
    },
    async link(item, pullRequest) {
      const { complete, rows } = await pages(
        `/tasks/${item.handle.gid}/stories`,
        'text,type',
        (row) => mentions(row.text, pullRequest.url),
      )
      if (rows.some((row) => mentions(row.text, pullRequest.url))) return
      if (!complete) throw new Error('too many comments to check for an earlier link')
      spend()
      await asana
        .comment(item.handle.gid, asanaComment(pullRequest), item.handle.account)
        .catch(waitOn)
    },
    texts: {
      closedTitle: () => 'Its Asana task was marked complete',
      closedBody: (_label, _state, pastSignOff) =>
        pastSignOff
          ? 'Someone completed this Task’s Asana task after you signed off. TED keeps going until you choose.'
          : 'Someone completed this Task’s Asana task while the Task is still being worked on. TED keeps going until you choose.',
      groupTitle: () => '',
      groupBody: () => '',
    },
  }
}

export function asanaRecords(
  store: TedStore,
  account: () => string | undefined,
): TrackerRecords<AsanaItem> {
  const shared = trackerRecords<AsanaItem>(store, asanaTracker, account)
  return {
    ...shared,
    syncState(task) {
      const state = store.getTask(task.id)?.asanaSync?.state
      return state !== undefined && asanaSyncing.includes(state) ? 'on' : 'ask'
    },
  }
}

export interface AsanaSync extends TrackerSync {
  refresh(): Promise<string | undefined>
}

export function createAsanaSync(options: AsanaSyncOptions): AsanaSync {
  let account: string | undefined
  const asana: AsanaSyncApi = {
    ...options.asana,
    async account() {
      account = await options.asana.account()
      return account
    },
  }
  const refresh = async () => {
    const current = await asana.account().catch(() => undefined)
    options.store.setAsanaConnection(current)
    return current
  }
  options.inBackground('check the Asana connection', async () => {
    await refresh()
  })
  const sync = createTrackerSync({
    store: options.store,
    connector: asanaConnector(options.store, asana, options.requestsPerCycle),
    records: asanaRecords(options.store, () => account),
    actions: options.actions,
    everyMs: options.everyMs,
    inBackground: options.inBackground,
    ...(options.clock && { clock: options.clock }),
  })
  return { close: () => sync.close(), refresh }
}
