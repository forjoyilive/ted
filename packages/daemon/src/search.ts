import {
  type AutomationHit,
  type CommentHit,
  compactId,
  type FactoryHit,
  matchesTerms,
  type PlanHit,
  type SearchField,
  type SearchResults,
  type SearchTaskState,
  searchLimits,
  searchTerms,
  snippetAround,
  type Task,
  type TaskHit,
  type TrackerMatch,
} from '@ted/protocol'
import type { TedStore } from './store/index.ts'

export interface SearchRequest {
  query: string
  factoryId?: string
}

const stateOrder: Record<SearchTaskState, number> = { open: 0, done: 1, archived: 2 }
const fieldOrder: Record<SearchField, number> = {
  id: 0,
  tracker: 1,
  title: 2,
  description: 3,
  'original-request': 4,
  brief: 5,
}

type Exactness = 'id' | 'tracker' | 'none'

const exactOrder: Record<Exactness, number> = { id: 0, tracker: 1, none: 2 }

function trackerIds(task: Task): TrackerMatch[] {
  const ids: TrackerMatch[] = []
  const source = task.source
  if (source?.linear) ids.push({ kind: 'linear', id: source.linear.identifier })
  if (source?.github) ids.push({ kind: 'github', id: `#${source.github.number}` })
  if (source?.sentry) ids.push({ kind: 'sentry', id: source.sentry.shortId })
  return ids
}

function exactTracker(task: Task, query: string): TrackerMatch | undefined {
  if (query === '') return undefined
  return trackerIds(task).find((tracker) => compactId(tracker.id) === query)
}

function exactness(task: Task, query: string): Exactness {
  if (query === '') return 'none'
  if (compactId(task.displayId) === query || String(task.number) === query) return 'id'
  return exactTracker(task, query) ? 'tracker' : 'none'
}

function partialTracker(
  task: Task,
  terms: readonly string[],
  query: string,
): TrackerMatch | undefined {
  return trackerIds(task).find(
    (tracker) =>
      tracker.kind !== 'github' &&
      (matchesTerms(terms, tracker.id) || (query !== '' && compactId(tracker.id).includes(query))),
  )
}

function stateOf(task: Task): SearchTaskState {
  if (task.archived) return 'archived'
  return task.stage === 'done' ? 'done' : 'open'
}

function taskField(
  store: TedStore,
  task: Task,
  terms: readonly string[],
  query: string,
  exact: Exactness,
): { field: SearchField; snippet?: string; tracker?: TrackerMatch } | undefined {
  if (exact === 'id') return { field: 'id' }
  const tracker = exact === 'tracker' ? exactTracker(task, query) : undefined
  if (tracker) return { field: 'tracker', tracker }
  if (matchesTerms(terms, task.displayId)) return { field: 'id' }
  if (query !== '' && compactId(task.displayId).includes(query)) return { field: 'id' }
  const partial = partialTracker(task, terms, query)
  if (partial) return { field: 'tracker', tracker: partial }
  if (matchesTerms(terms, `${task.displayId} ${task.title}`)) return { field: 'title' }
  const snippet = (text: string) => snippetAround(terms, text)
  if (matchesTerms(terms, task.description)) {
    return { field: 'description', snippet: snippet(task.description) }
  }
  const versions = store.descriptionVersions(task.id)
  const earlier = versions.slice(0, -1).find((v) => matchesTerms(terms, v.text))
  if (earlier) {
    return {
      field: earlier.version === 1 ? 'original-request' : 'description',
      snippet: snippet(earlier.text),
    }
  }
  const brief = store.latestBrief(task.id)?.text
  if (brief !== undefined && matchesTerms(terms, brief)) {
    return { field: 'brief', snippet: snippet(brief) }
  }
  return undefined
}

export function search(
  store: TedStore,
  { query, factoryId }: SearchRequest,
  everyTask?: readonly Task[],
): SearchResults {
  const terms = searchTerms(query)
  if (terms.length === 0) {
    return {
      query,
      conversations: [],
      tasks: [],
      comments: [],
      factories: [],
      plans: [],
      automations: [],
    }
  }
  const compact = compactId(query)
  const tasks = everyTask ?? store.listTasks()
  const here = (id: string) => (id === factoryId ? 0 : 1)

  const taskHits: TaskHit[] = []
  const exactOf = new Map<string, Exactness>()
  for (const task of tasks) {
    const exact = exactness(task, compact)
    const found = taskField(store, task, terms, compact, exact)
    if (!found) continue
    exactOf.set(task.id, exact)
    taskHits.push({
      taskId: task.id,
      displayId: task.displayId,
      factoryId: task.factoryId,
      title: task.title,
      stage: task.stage,
      state: stateOf(task),
      ...found,
    })
  }
  const updated = new Map(tasks.map((t) => [t.id, t.updatedAt]))
  taskHits.sort(
    (a, b) =>
      exactOrder[exactOf.get(a.taskId) ?? 'none'] - exactOrder[exactOf.get(b.taskId) ?? 'none'] ||
      stateOrder[a.state] - stateOrder[b.state] ||
      here(a.factoryId) - here(b.factoryId) ||
      fieldOrder[a.field] - fieldOrder[b.field] ||
      (updated.get(b.taskId) ?? '').localeCompare(updated.get(a.taskId) ?? ''),
  )

  const commentHits: CommentHit[] = []
  const texts = Map.groupBy(store.commentTexts(), (comment) => comment.taskId)
  for (const task of tasks) {
    for (const comment of (texts.get(task.id) ?? []).reverse()) {
      const text = comment.title === undefined ? comment.body : `${comment.title} ${comment.body}`
      if (!matchesTerms(terms, text)) continue
      commentHits.push({
        commentId: comment.id,
        taskId: task.id,
        displayId: task.displayId,
        factoryId: task.factoryId,
        taskTitle: task.title,
        author: comment.author,
        leadAuthor: comment.author.kind === 'run' && comment.author.runId === task.leadRunId,
        state: stateOf(task),
        snippet: snippetAround(terms, text),
        createdAt: comment.createdAt,
      })
    }
  }
  commentHits.sort(
    (a, b) =>
      stateOrder[a.state] - stateOrder[b.state] ||
      here(a.factoryId) - here(b.factoryId) ||
      b.createdAt.localeCompare(a.createdAt),
  )

  const factoryHits: FactoryHit[] = store
    .listFactories()
    .filter((f) => matchesTerms(terms, f.name))
    .sort((a, b) => here(a.id) - here(b.id))
    .map((f) => ({ factoryId: f.id, name: f.name }))

  const factoryIds = new Set(store.listFactories().map((f) => f.id))
  const planHits: PlanHit[] = store.plans
    .list()
    .filter((p) => factoryIds.has(p.factoryId) && matchesTerms(terms, p.title))
    .sort(
      (a, b) =>
        Number(a.state === 'ended') - Number(b.state === 'ended') ||
        here(a.factoryId) - here(b.factoryId) ||
        b.createdAt.localeCompare(a.createdAt),
    )
    .map((p) => ({
      planId: p.id,
      factoryId: p.factoryId,
      title: p.title,
      ended: p.state === 'ended',
    }))
  const automationHits: AutomationHit[] = store.automations
    .list()
    .filter((a) => factoryIds.has(a.factoryId) && matchesTerms(terms, a.name))
    .sort((a, b) => here(a.factoryId) - here(b.factoryId) || Number(b.on) - Number(a.on))
    .map((a) => ({ automationId: a.id, factoryId: a.factoryId, name: a.name, on: a.on }))

  return {
    query,
    conversations: [],
    tasks: taskHits.slice(0, searchLimits.tasks),
    comments: commentHits.slice(0, searchLimits.comments),
    factories: factoryHits.slice(0, searchLimits.factories),
    plans: planHits.slice(0, searchLimits.plans),
    automations: automationHits.slice(0, searchLimits.automations),
  }
}
