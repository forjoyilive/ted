import type { Comment, Task } from '@ted/protocol'
import { type Clock, systemClock, type Timer } from '../../clock.ts'
import { redactSecrets } from '../../redact.ts'
import type { TedStore } from '../../store/index.ts'
import { clean } from '../github-activity.ts'
import {
  type TrackerConnector,
  type TrackerItem,
  type TrackerRecord,
  type TrackerRecords,
  TrackerWait,
} from './connector.ts'

export const archiveChoice = 'Archive'
export const keepChoice = 'Keep going'

const maxStateName = 80

export interface TrackerTaskActions {
  gone(taskId: string): boolean
  liveRun(task: Task): boolean
  openRequests(taskId: string): Comment[]
  archive(task: Task, why: string): void
  under(taskId: string): Task[]
}

export interface TrackerSyncOptions<Source, Handle> {
  store: TedStore
  connector: TrackerConnector<Source, Handle>
  records: TrackerRecords<Handle>
  actions: TrackerTaskActions
  clock?: Clock
  everyMs: number
  inBackground(what: string, work: () => Promise<void>): void
}

export interface TrackerSync {
  close(): void
}

interface Watched<Source> {
  task: Task
  source: Source
  merged: boolean
  record: TrackerRecord
}

export function createTrackerSync<Source, Handle>(
  options: TrackerSyncOptions<Source, Handle>,
): TrackerSync {
  const { store, connector, records, actions } = options
  const clock = options.clock ?? systemClock
  const finalStep = connector.steps.at(-1)
  const rank = (step: string | undefined) =>
    step === undefined ? 0 : connector.steps.indexOf(step) + 1
  let timer: Timer | undefined
  let closed = false

  function schedule(waitMs = 0): void {
    if (closed) return
    timer = clock.timeout(
      () => {
        options.inBackground(`sync Tasks with ${connector.name}`, () =>
          cycle().then(schedule, (error: unknown) => {
            schedule()
            throw error
          }),
        )
      },
      Math.max(options.everyMs, waitMs),
    )
    timer.unref()
  }

  const doneAndMerged = (id: string): boolean =>
    store.getTask(id)?.stage === 'done' && store.isMerged(id)

  function mayNeedSync(id: string, open: boolean): boolean {
    if (!doneAndMerged(id)) return open
    const record = records.record(id)
    return (
      record.step !== finalStep ||
      store.taskPullRequestUrls(id).some((url) => !record.linked.has(url))
    )
  }

  function watched(): Watched<Source>[] {
    const outlines = new Map(store.taskOutlines().map((task) => [task.id, task]))
    const ids = store.taskSourceUrls().flatMap(({ taskId, url }) => {
      const task = outlines.get(taskId)
      if (!task || !connector.source(url)) return []
      return mayNeedSync(taskId, !task.archived && task.stage !== 'done') ? [taskId] : []
    })
    return store.tasksIn(new Set(ids)).flatMap((task): Watched<Source>[] => {
      const source = task.source && connector.source(task.source.url)
      if (!source) return []
      return [{ task, source, merged: doneAndMerged(task.id), record: records.record(task.id) }]
    })
  }

  async function cycle(): Promise<number | undefined> {
    if (closed || !connector.enabled(store.settings())) return undefined
    if (connector.ready?.() === false) return undefined
    const list = watched()
    if (list.length === 0) return undefined
    const read = await connector.read(list.map((w) => w.source))
    if (!read) return undefined
    if ('waitMs' in read) return read.waitMs
    for (const item of list) {
      if (closed) return undefined
      const found = read.items.get(connector.key(item.source))
      if (!found) continue
      try {
        await syncOne(item, found)
      } catch (error) {
        if (error instanceof TrackerWait) return error.waitMs > 0 ? error.waitMs : undefined
        console.error(
          redactSecrets(
            `couldn’t sync ${item.task.displayId} with ${connector.name}: ${String(error)}`,
          ),
        )
      }
    }
    return undefined
  }

  async function syncOne(
    { task, source, merged, record }: Watched<Source>,
    read: TrackerItem<Handle>,
  ) {
    const label = connector.label(source)
    const item = { ...read, state: clean(read.state, maxStateName) }
    const before = record.seen
    records.see(task.id, label, item)
    const current = store.getTask(task.id)
    if (!current || records.syncState(current) !== 'on') return
    const open = !task.archived && task.stage !== 'done'
    const itemClosed = open && item.closed
    if (itemClosed && before !== undefined && !before.closed) {
      await closedOutside(task.id, label, item.state)
    }
    if (!open) settled(task.id, 'done')
    else if (!itemClosed && before !== undefined && before.closed) settled(task.id, 'reopened')
    if (!merged && store.getTask(task.id)?.archived) return
    const decision = await connector.advance({ task, merged, step: record.step, item })
    if (decision && rank(decision.step) > rank(record.step)) {
      records.moved(
        task.id,
        label,
        decision.step,
        decision.moved === undefined ? undefined : clean(decision.moved, maxStateName),
      )
    }
    const fresh = pullRequestLinks(task).filter((l) => !record.linked.has(l.url))
    const linked: string[] = []
    try {
      for (const pullRequest of fresh) {
        await connector.link(item, pullRequest, task)
        linked.push(pullRequest.url)
      }
    } finally {
      if (linked.length > 0) records.linked(task.id, label, linked)
    }
  }

  async function closedOutside(taskId: string, label: string, state: string): Promise<void> {
    const task = store.getTask(taskId)
    if (!task || task.archived || task.stage === 'done' || actions.gone(taskId)) return
    const marked = connector.texts.closedTitle(label, state)
    const pastSignOff = task.stage === 'merge'
    const under = actions.under(taskId)
    if (!pastSignOff && !actions.liveRun(task) && under.length === 0) {
      actions.archive(task, marked)
      const parent = task.parentId && store.getTask(task.parentId)
      if (parent && !parent.archived)
        store.postComment({
          taskId: parent.id,
          kind: 'note',
          author: { kind: 'ted' },
          body: connector.texts.childArchived(task.displayId, label, state),
        })
      return
    }
    if (actions.openRequests(taskId).some((c) => records.isClosedQuestion(c))) return
    const body = connector.texts.closedBody(label, state, pastSignOff)
    store.postComment({
      taskId,
      kind: 'question',
      author: { kind: 'ted' },
      title: marked,
      purpose: records.closedPurpose,
      body:
        under.length === 0
          ? body
          : `${body}\n\n${archiveChoice} also archives the ${under.length === 1 ? 'Task' : `${under.length} Tasks`} under it: ${under.map((t) => `${t.displayId} ${clean(t.title, 120)}`).join(', ')}.`,
      choices: [archiveChoice, keepChoice],
    })
  }

  function settled(taskId: string, why: 'reopened' | 'done'): void {
    const questions = actions.openRequests(taskId).filter((c) => records.isClosedQuestion(c))
    for (const question of questions) {
      store.answerComment(question.id, records.withdrawn(why, new Date().toISOString()))
    }
  }

  schedule()

  return {
    close() {
      closed = true
      timer?.cancel()
    },
  }
}

function pullRequestLinks(task: Task): { url: string; title: string }[] {
  return task.repos.flatMap((repo) => {
    const pr = repo.pullRequest
    return pr && !repo.removed ? [{ url: pr.url, title: `${repo.repo}#${pr.number}` }] : []
  })
}
