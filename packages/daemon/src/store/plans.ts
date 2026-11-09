import { randomUUID } from 'node:crypto'
import { queryDb, type Store } from '@livestore/livestore'
import type {
  AgentKind,
  CommentAnswer,
  DaemonEvent,
  Effort,
  PlanRequest,
  PlanRequestKind,
  Proposal,
  Round,
} from '@ted/protocol'
import { events, planRequests, plans, planTasks, type schema } from './schema.ts'

export type PlanState = 'queued' | 'started' | 'ended'

export type PlanOutcome = 'finished' | 'stopped' | 'failed'

export interface PlanCheckout {
  clone: string
  worktree: string
}

export interface StoredPlan {
  id: string
  factoryId: string
  title: string
  message: string
  agent: AgentKind
  model?: string
  effort?: Effort
  state: PlanState
  resume?: 'queued' | 'done'
  outcome?: PlanOutcome
  error?: string
  checkout: PlanCheckout[]
  createdAt: string
  startedAt?: string
  finishedAt?: string
  from?: { planId: string; title: string; context: string }
}

export interface PlanTaskRecord {
  taskId: string
  planId: string
  row: number
  at: string
}

export interface NewPlanRequest {
  planId: string
  runId: string
  kind: PlanRequestKind
  author: 'run' | 'ted'
  title?: string
  body: string
  round?: Round
  proposal?: Proposal
}

export interface PlanStore {
  list(): StoredPlan[]
  get(id: string): StoredPlan | undefined
  start(
    input: Pick<
      StoredPlan,
      'factoryId' | 'title' | 'message' | 'agent' | 'model' | 'effort' | 'from'
    >,
  ): StoredPlan
  retried(id: string, retry: { fresh: boolean; checkout: PlanCheckout[] }): void
  rename(id: string, title: string): void
  delete(id: string): void
  began(id: string, checkout: PlanCheckout[]): void
  resumeQueued(id: string, error: string): void
  revived(id: string): void
  ended(id: string, end: { outcome: PlanOutcome; error?: string }): void
  postRequest(input: NewPlanRequest): PlanRequest
  answerRequest(id: string, answer: CommentAnswer): PlanRequest
  requests(planId?: string): PlanRequest[]
  request(id: string): PlanRequest | undefined
  taskCreated(link: Omit<PlanTaskRecord, 'at'>): void
  createdTasks(planId: string): PlanTaskRecord[]
  createdTask(taskId: string): PlanTaskRecord | undefined
}

export function createPlanStore({
  store,
  commit,
  emit,
  changed,
}: {
  store: Store<typeof schema>
  commit: Store<typeof schema>['commit']
  emit: (event: DaemonEvent) => void
  changed: () => void
}): PlanStore {
  const toPlan = (row: typeof plans.Type): StoredPlan => ({
    id: row.id,
    factoryId: row.factoryId,
    title: row.title,
    message: row.message,
    agent: row.agent as AgentKind,
    ...(row.model !== null && { model: row.model }),
    ...(row.effort !== null && { effort: row.effort as Effort }),
    state: row.state as PlanState,
    ...(row.resume !== null && { resume: row.resume as 'queued' | 'done' }),
    ...(row.outcome !== null && { outcome: row.outcome as PlanOutcome }),
    ...(row.error !== null && { error: row.error }),
    checkout: row.checkout === null ? [] : (JSON.parse(row.checkout) as PlanCheckout[]),
    createdAt: row.createdAt,
    ...(row.startedAt !== null && { startedAt: row.startedAt }),
    ...(row.finishedAt !== null && { finishedAt: row.finishedAt }),
    ...(row.fromPlanId !== null && {
      from: {
        planId: row.fromPlanId,
        title: row.fromPlanTitle ?? '',
        context: row.context ?? '',
      },
    }),
  })

  const toRequest = (row: typeof planRequests.Type): PlanRequest => ({
    id: row.id,
    planId: row.planId,
    runId: row.runId,
    kind: row.kind as PlanRequestKind,
    author: row.author === 'ted' ? 'ted' : 'run',
    ...(row.title !== null && { title: row.title }),
    body: row.body,
    ...(row.round !== null && { round: JSON.parse(row.round) as Round }),
    ...(row.proposal !== null && { proposal: JSON.parse(row.proposal) as Proposal }),
    ...(row.answer !== null && { answer: JSON.parse(row.answer) as CommentAnswer }),
    createdAt: row.createdAt,
  })

  const get = (id: string) => {
    const row = store.query(queryDb(plans.where({ id }))).at(0)
    return row && toPlan(row)
  }
  const request = (id: string) => {
    const row = store.query(queryDb(planRequests.where({ id }))).at(0)
    return row && toRequest(row)
  }
  const updated = (planId: string) => {
    emit({ type: 'plan-updated', planId })
    changed()
  }
  const now = () => new Date().toISOString()
  const planEvent = (id: string, change: (at: string) => unknown) => {
    if (!get(id)) return
    commit(change(now()) as Parameters<typeof commit>[0])
    updated(id)
  }

  return {
    list: () => store.query(queryDb(plans.orderBy('createdAt', 'asc'))).map(toPlan),
    get,
    start({ model, effort, from, ...input }) {
      const id = randomUUID()
      const at = now()
      commit(
        events.planStarted({ ...input, id, model: model ?? null, effort: effort ?? null, at }),
        ...(from
          ? [
              events.planContinued({
                id,
                fromPlanId: from.planId,
                fromTitle: from.title,
                context: from.context,
                at,
              }),
            ]
          : []),
      )
      updated(id)
      const started = get(id)
      if (!started) throw new Error(`no plan ${id}`)
      return started
    },
    rename: (id, title) => planEvent(id, (at) => events.planRenamed({ id, title, at })),
    delete(id) {
      commit(events.planDeleted({ id, at: now() }))
      emit({ type: 'plan-deleted', planId: id })
      changed()
    },
    began: (id, checkout) =>
      planEvent(id, (at) => events.planRunBegan({ id, checkout: JSON.stringify(checkout), at })),
    retried: (id, { fresh, checkout }) =>
      planEvent(id, (at) =>
        events.planRetried({
          id,
          fresh,
          checkout: checkout.length === 0 ? null : JSON.stringify(checkout),
          at,
        }),
      ),
    resumeQueued: (id, error) =>
      planEvent(id, (at) => events.planRunResumeQueued({ id, error, at })),
    revived: (id) => planEvent(id, (at) => events.planRunRevived({ id, at })),
    ended: (id, { outcome, error }) =>
      planEvent(id, (at) => events.planEnded({ id, outcome, error: error ?? null, at })),
    postRequest({ title, round, proposal, ...input }) {
      const id = randomUUID()
      commit(
        events.planRequestPosted({
          ...input,
          id,
          title: title ?? null,
          round: round === undefined ? null : JSON.stringify(round),
          proposal: proposal === undefined ? null : JSON.stringify(proposal),
          at: now(),
        }),
      )
      updated(input.planId)
      const posted = request(id)
      if (!posted) throw new Error(`no plan request ${id}`)
      return posted
    },
    answerRequest(id, answer) {
      const found = request(id)
      if (!found) throw new Error(`no plan request ${id}`)
      commit(events.planRequestAnswered({ id, answer: JSON.stringify(answer), at: answer.at }))
      updated(found.planId)
      return request(id) ?? found
    },
    requests(planId) {
      const query =
        planId === undefined
          ? planRequests.orderBy('createdAt', 'asc')
          : planRequests.where({ planId }).orderBy('createdAt', 'asc')
      return store.query(queryDb(query)).map(toRequest)
    },
    request,
    taskCreated(link) {
      commit(events.planTaskCreated({ ...link, at: now() }))
      updated(link.planId)
    },
    createdTasks: (planId) =>
      store.query(queryDb(planTasks.where({ planId }).orderBy('row', 'asc'))),
    createdTask: (taskId) => store.query(queryDb(planTasks.where({ taskId }))).at(0),
  }
}
