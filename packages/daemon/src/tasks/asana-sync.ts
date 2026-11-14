import { type AsanaTaskUrl, asanaSyncing, type Comment, parseAsanaTaskUrl } from '@ted/protocol'
import { AsanaReadError } from '../asana/asana.ts'
import type { Clock } from '../clock.ts'
import type { TedStore } from '../store/index.ts'
import { asanaTaskUrl } from './asana-import.ts'
import {
  coveredBy,
  maxSubtreeRequests,
  type ParentStep,
  parentStep,
  planUnfinished,
  readSubtree,
  stillAsked,
  type TrackedItem,
  unfinishedChoices,
  unfinishedText,
  unfinishedTitle,
} from './asana-unfinished.ts'
import { clean } from './github-activity.ts'
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
const subtaskFields = 'gid,name,completed,permalink_url,num_subtasks'

export function trackedItems(store: TedStore, factoryId: string): Map<string, TrackedItem> {
  const outlines = new Map(store.taskOutlines().map((task) => [task.id, task]))
  const rank = { open: 3, done: 2, archived: 1 } as const
  const found = new Map<string, { taskId: string; state: TrackedItem['state'] }>()
  for (const { taskId, url } of store.taskSourceUrls()) {
    const outline = outlines.get(taskId)
    const gid = parseAsanaTaskUrl(url)?.gid
    if (!outline || outline.factoryId !== factoryId || gid === undefined) continue
    const state = outline.archived ? 'archived' : outline.stage === 'done' ? 'done' : 'open'
    const before = found.get(gid)
    if (!before || rank[state] > rank[before.state]) found.set(gid, { taskId, state })
  }
  const tracked = new Map<string, TrackedItem>()
  for (const [gid, { taskId, state }] of found) {
    const task = store.getTask(taskId)
    if (!task) continue
    tracked.set(gid, {
      state,
      displayId: task.displayId,
      childGids: task.source?.asana?.children.map((child) => child.gid) ?? [],
    })
  }
  return tracked
}

export function mentions(text: unknown, url: string): boolean {
  if (typeof text !== 'string') return false
  for (let at = text.indexOf(url); at !== -1; at = text.indexOf(url, at + 1)) {
    const before = at === 0 ? '' : (text[at - 1] ?? '')
    if (!/[\w/]/.test(text[at + url.length] ?? '') && !/[^\s(<[{"'“‘]/.test(before)) return true
  }
  return false
}

const maxTitle = 300

export function asanaComment(title: string, pullRequest: { url: string; title: string }): string {
  return `TED opened a pull request for this task: ${clean(title, maxTitle)} (${pullRequest.title}) ${pullRequest.url}`
}

export function asanaConnector(
  store: TedStore,
  asana: AsanaSyncApi,
  requestsPerCycle = 100,
): TrackerConnector<AsanaTaskUrl, AsanaItem> {
  let left = 0
  let start = 0
  let cycleNo = 0
  const treeReadIn = new Map<string, number>()
  const starved = new Map<string, number>()
  const waitingForTree = (taskId: string) =>
    [...starved].some(([id, at]) => id !== taskId && at >= cycleNo - 1)

  const spend = () => {
    if (left <= 0) throw new TrackerWait(0)
    left--
  }
  const stillSyncing = (taskId: string): boolean => {
    const state = store.getTask(taskId)?.asanaSync?.state
    return store.settings().asanaSync && state !== undefined && asanaSyncing.includes(state)
  }
  const settleParent = (taskId: string) => {
    store.setAsanaOpenChildren(taskId, undefined)
    store.setAsanaLeftOpen(taskId, false)
    treeReadIn.delete(taskId)
    starved.delete(taskId)
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
      cycleNo++
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
      const asking = () =>
        store.listComments(task.id).filter((c) => c.asanaUnfinished && c.answer === undefined)
      const withdraw = (questions: readonly Comment[]) => {
        for (const question of questions)
          store.answerComment(question.id, {
            kind: 'withdrawn',
            at: new Date().toISOString(),
            asanaReread: true,
          })
      }
      if (item.handle.completed) {
        withdraw(asking())
        settleParent(task.id)
        return { step: 'completed' }
      }
      const root = {
        gid: item.handle.gid,
        name: task.source?.asana?.title ?? task.title,
        url: asanaTaskUrl(item.handle.gid),
      }
      let step: ParentStep = { kind: 'complete' }
      if (item.handle.subtasks > 0) {
        if (waitingForTree(task.id) && treeReadIn.get(task.id) === cycleNo - 1) return undefined
        if (left < Math.min(maxSubtreeRequests + maxPages, Math.floor(requestsPerCycle / 2))) {
          starved.set(task.id, cycleNo)
          return undefined
        }
        starved.delete(task.id)
        treeReadIn.set(task.id, cycleNo)
        const tracked = trackedItems(store, task.factoryId)
        const owner = (gid: string) => tracked.get(gid)
        const budget = left
        const tree = await readSubtree({
          root,
          list: (gid) => pages(`/tasks/${gid}/subtasks`, subtaskFields, () => false),
          spent: () => budget - left,
          tracked: owner,
        })
        const questions = store.listComments(task.id).filter((c) => c.asanaUnfinished)
        step = parentStep(planUnfinished(root, tree, owner), coveredBy(questions))
      }
      if (!stillSyncing(task.id)) return undefined
      const open = asking()
      if (step.kind === 'ask') {
        store.setAsanaOpenChildren(task.id, undefined)
        store.setAsanaLeftOpen(task.id, false)
        const kept = open.find((c) => stillAsked(c, step.items))
        withdraw(open.filter((c) => c !== kept))
        if (kept) return undefined
        store.postComment({
          taskId: task.id,
          kind: 'question',
          author: { kind: 'ted' },
          title: unfinishedTitle,
          body: unfinishedText(step.items),
          choices: unfinishedChoices(step.items),
          asanaUnfinished: { parentGid: root.gid, items: step.items },
        })
        return undefined
      }
      withdraw(open)
      if (step.kind === 'wait') {
        store.setAsanaLeftOpen(task.id, false)
        store.setAsanaOpenChildren(task.id, step.waiting)
        return undefined
      }
      if (step.kind === 'leave') {
        store.setAsanaOpenChildren(task.id, undefined)
        store.setAsanaLeftOpen(task.id, true)
        return undefined
      }
      spend()
      await asana.complete(item.handle.gid, item.handle.account).catch(waitOn)
      settleParent(task.id)
      return { step: 'completed', moved: 'Completed' }
    },
    async link(item, pullRequest, task) {
      const { complete, rows } = await pages(
        `/tasks/${item.handle.gid}/stories`,
        'text,type',
        (row) => mentions(row.text, pullRequest.url),
      )
      if (rows.some((row) => mentions(row.text, pullRequest.url))) return
      if (!complete) throw new Error('too many comments to check for an earlier link')
      if (!stillSyncing(task.id)) throw new TrackerWait(0)
      spend()
      await asana
        .comment(item.handle.gid, asanaComment(task.title, pullRequest), item.handle.account)
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
