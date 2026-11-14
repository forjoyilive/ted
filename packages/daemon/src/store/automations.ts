import { randomUUID } from 'node:crypto'
import { queryDb, type Store } from '@livestore/livestore'
import type {
  AgentKind,
  AutomationCheck,
  AutomationCheckState,
  AutomationSchedule,
  AutomationTaskLink,
  AutomationTemplateId,
  AutomationTrigger,
  DaemonEvent,
  Effort,
  StageId,
} from '@ted/protocol'
import {
  automationCheckResults,
  automationCheckTasks,
  automationComments,
  automationFirings,
  automations,
  automationTasks,
  events,
  runs,
  type schema,
  taskSources,
  tasks,
} from './schema.ts'

export interface StoredAutomation {
  id: string
  factoryId: string
  name: string
  prompt: string
  schedule: AutomationSchedule
  timeZone: string
  agent: AgentKind
  model?: string
  effort?: Effort
  on: boolean
  checkout: boolean
  check?: AutomationCheck
  template?: AutomationTemplateId
  handledUntil: string
  createdAt: string
}

export type NewAutomation = Omit<
  StoredAutomation,
  'id' | 'handledUntil' | 'createdAt' | 'checkout' | 'check'
> & {
  checkout?: boolean
}

export type AutomationFields = Omit<NewAutomation, 'factoryId' | 'on' | 'template'>

export type FiringState = 'queued' | 'skipped' | 'dropped' | 'started' | 'ended'

export type FiringOutcome = 'finished' | 'failed' | 'stopped'

export interface StoredFiring {
  id: string
  automationId: string
  trigger: AutomationTrigger
  slotAt?: string
  retryOf?: string
  retriedAt?: string
  state: FiringState
  at: string
  startedAt?: string
  resume?: 'queued' | 'done'
  outcome?: FiringOutcome
  error?: string
  message?: string
  finishedAt?: string
}

export interface AutomationTaskRecord {
  taskId: string
  automationId: string
  firingId: string
  at: string
}

export interface StoredCheckResult {
  firingId: string
  automationId: string
  state: AutomationCheckState
  exitCode?: number
  durationMs: number
  ranWhileBusy: boolean
  skipped: string[]
  failing: string[]
  updatedTaskIds: string[]
}

export interface StoredAutomationComment {
  id: string
  automationId: string
  firingId: string
  kind: 'note' | 'question'
  body: string
  choices?: string[]
  answer?: { text: string; at: string }
  createdAt: string
}

export interface AutomationStore {
  list(): StoredAutomation[]
  get(id: string): StoredAutomation | undefined
  create(input: NewAutomation, at: string, check?: AutomationCheck): StoredAutomation
  edit(id: string, fields: AutomationFields, at: string, check?: AutomationCheck): StoredAutomation
  check(automationId: string): AutomationCheck | undefined
  checks(): Map<string, AutomationCheck>
  checkResults(firingIds: readonly string[]): Map<string, StoredCheckResult>
  checkEnded(
    id: string,
    end: { outcome: FiringOutcome; error?: string; message?: string },
    result?: Omit<StoredCheckResult, 'firingId' | 'automationId'>,
  ): void
  checkTasks(automationId: string): { taskId: string; key: string }[]
  touched(automationId: string): void
  switch(id: string, on: boolean, at: string): StoredAutomation
  delete(id: string): void
  fire(input: {
    automationId: string
    trigger: AutomationTrigger
    slotAt?: string
    retryOf?: string
    skipped?: boolean
    at: string
  }): StoredFiring
  firings(automationId?: string): StoredFiring[]
  firing(id: string): StoredFiring | undefined
  dropFiring(id: string): void
  began(id: string): void
  resumeQueued(id: string, error: string): void
  revived(id: string): void
  ended(id: string, end: { outcome: FiringOutcome; error?: string; message?: string }): void
  taskCreated(link: Omit<AutomationTaskRecord, 'at'>): void
  createdTasks(automationId?: string): AutomationTaskRecord[]
  createdTask(taskId: string): AutomationTaskRecord | undefined
  taskLinks(taskIds: readonly string[]): Map<string, AutomationTaskLink>
  firingsWithRun(firingIds: readonly string[]): Set<string>
  postComment(input: {
    automationId: string
    firingId: string
    kind: 'note' | 'question'
    body: string
    choices?: string[]
  }): StoredAutomationComment
  answerComment(id: string, text: string): StoredAutomationComment
  comments(automationId?: string): StoredAutomationComment[]
  comment(id: string): StoredAutomationComment | undefined
}

export function createAutomationStore({
  store,
  commit,
  emit,
  changed,
  factoryKey,
}: {
  store: Store<typeof schema>
  commit: Store<typeof schema>['commit']
  emit: (event: DaemonEvent) => void
  changed: () => void
  factoryKey: (factoryId: string) => string
}): AutomationStore {
  const inChunks = <T>(ids: readonly string[], read: (chunk: string[]) => readonly T[]): T[] => {
    const unique = [...new Set(ids)]
    const found: T[] = []
    for (let at = 0; at < unique.length; at += 500) found.push(...read(unique.slice(at, at + 500)))
    return found
  }

  const toAutomation = ({
    schedule,
    model,
    effort,
    template,
    checkCommand,
    checkTimeout,
    checkRunBy,
    ...row
  }: typeof automations.Type): StoredAutomation => ({
    ...row,
    ...(checkCommand !== null && {
      check: {
        command: checkCommand,
        timeout: checkTimeout ?? '2h',
        ...(checkRunBy !== null && { runBy: checkRunBy }),
      },
    }),
    schedule: JSON.parse(schedule) as AutomationSchedule,
    agent: row.agent as AgentKind,
    ...(model !== null && { model }),
    ...(effort !== null && { effort: effort as Effort }),
    ...(template !== null && { template: template as AutomationTemplateId }),
  })

  const toFiring = (row: typeof automationFirings.Type): StoredFiring => ({
    id: row.id,
    automationId: row.automationId,
    trigger: row.trigger as AutomationTrigger,
    state: row.state as FiringState,
    at: row.at,
    ...(row.slotAt !== null && { slotAt: row.slotAt }),
    ...(row.retryOf !== null && { retryOf: row.retryOf }),
    ...(row.retriedAt !== null && { retriedAt: row.retriedAt }),
    ...(row.startedAt !== null && { startedAt: row.startedAt }),
    ...(row.resume !== null && { resume: row.resume as 'queued' | 'done' }),
    ...(row.outcome !== null && { outcome: row.outcome as FiringOutcome }),
    ...(row.error !== null && { error: row.error }),
    ...(row.message !== null && { message: row.message }),
    ...(row.finishedAt !== null && { finishedAt: row.finishedAt }),
  })

  const toComment = (row: typeof automationComments.Type): StoredAutomationComment => ({
    id: row.id,
    automationId: row.automationId,
    firingId: row.firingId,
    kind: row.kind === 'question' ? 'question' : 'note',
    body: row.body,
    ...(row.choices !== null && { choices: JSON.parse(row.choices) as string[] }),
    ...(row.answer !== null &&
      row.answeredAt !== null && { answer: { text: row.answer, at: row.answeredAt } }),
    createdAt: row.createdAt,
  })

  const checkEvent = (automationId: string, check: AutomationCheck, at: string) =>
    events.automationCheckSet({
      automationId,
      command: check.command,
      timeout: check.timeout,
      runBy: check.runBy ?? null,
      at,
    })

  const get = (id: string) => {
    const row = store.query(queryDb(automations.where({ id }))).at(0)
    return row && toAutomation(row)
  }
  const require = (id: string) => {
    const found = get(id)
    if (!found) throw new Error(`no Automation ${id}`)
    return found
  }
  const firing = (id: string) => {
    const row = store.query(queryDb(automationFirings.where({ id }))).at(0)
    return row && toFiring(row)
  }
  const comment = (id: string) => {
    const row = store.query(queryDb(automationComments.where({ id }))).at(0)
    return row && toComment(row)
  }
  const updated = (automationId: string) => {
    emit({ type: 'automation-updated', automationId })
    changed()
  }
  const now = () => new Date().toISOString()
  const firingEvent = (id: string, change: (at: string) => unknown) => {
    const found = firing(id)
    if (!found) return
    commit(change(now()) as Parameters<typeof commit>[0])
    updated(found.automationId)
  }

  return {
    list: () =>
      store.query(queryDb(automations.orderBy('createdAt', 'asc'))).map((row) => toAutomation(row)),
    get,
    create({ schedule, model, effort, template, checkout, ...input }, at, check) {
      const id = randomUUID()
      commit(
        events.automationCreated({
          ...input,
          id,
          schedule: JSON.stringify(schedule),
          model: model ?? null,
          effort: effort ?? null,
          template: template ?? null,
          at,
        }),
        ...(checkout ? [events.automationCheckoutSet({ id, checkout, at })] : []),
        ...(check ? [checkEvent(id, check, at)] : []),
      )
      updated(id)
      return require(id)
    },
    edit(id, { schedule, model, effort, checkout, ...fields }, at, check) {
      const before = require(id)
      const scheduleText = JSON.stringify(schedule)
      commit(
        ...(checkout !== undefined && checkout !== before.checkout
          ? [events.automationCheckoutSet({ id, checkout, at })]
          : []),
        events.automationEdited({
          ...fields,
          id,
          schedule: scheduleText,
          model: model ?? null,
          effort: effort ?? null,
          rescheduled:
            scheduleText !== JSON.stringify(before.schedule) || fields.timeZone !== before.timeZone,
          at,
        }),
        ...(check ? [checkEvent(id, check, at)] : []),
      )
      updated(id)
      return require(id)
    },
    check: (automationId) => get(automationId)?.check,
    checks() {
      return new Map(
        store.query(queryDb(automations)).flatMap((row) => {
          const { check } = toAutomation(row)
          return check ? [[row.id, check] as const] : []
        }),
      )
    },
    checkResults(firingIds) {
      const rows = inChunks(firingIds, (ids) =>
        store.query(queryDb(automationCheckResults.where({ firingId: { op: 'IN', value: ids } }))),
      )
      return new Map(
        rows.map((row) => [
          row.firingId,
          {
            firingId: row.firingId,
            automationId: row.automationId,
            state: row.state as AutomationCheckState,
            ...(row.exitCode !== null && { exitCode: row.exitCode }),
            durationMs: row.durationMs,
            ranWhileBusy: row.ranWhileBusy,
            skipped: JSON.parse(row.skipped) as string[],
            failing: JSON.parse(row.failing) as string[],
            updatedTaskIds: JSON.parse(row.updatedTaskIds) as string[],
          },
        ]),
      )
    },
    checkEnded(id, { outcome, error, message }, result) {
      const found = firing(id)
      if (!found) return
      const at = now()
      commit(
        events.automationRunEnded({
          id,
          outcome,
          error: error ?? null,
          message: message ?? null,
          at,
        }),
        ...(result
          ? [
              events.automationCheckFinished({
                firingId: id,
                automationId: found.automationId,
                state: result.state,
                exitCode: result.exitCode ?? null,
                durationMs: result.durationMs,
                ranWhileBusy: result.ranWhileBusy,
                skipped: result.skipped,
                failing: result.failing,
                updatedTaskIds: result.updatedTaskIds,
                at,
              }),
            ]
          : []),
      )
      updated(found.automationId)
    },
    touched(automationId) {
      emit({ type: 'automation-updated', automationId })
    },
    checkTasks(automationId) {
      return store
        .query(queryDb(automationCheckTasks.where({ automationId })))
        .map(({ taskId, key }) => ({ taskId, key }))
    },
    switch(id, on, at) {
      commit(events.automationSwitched({ id, on, at }))
      updated(id)
      return require(id)
    },
    delete(id) {
      commit(events.automationDeleted({ id, at: now() }))
      emit({ type: 'automation-deleted', automationId: id })
      changed()
    },
    fire({ automationId, trigger, slotAt, retryOf, skipped = false, at }) {
      const id = randomUUID()
      commit(
        events.automationFired({
          id,
          automationId,
          trigger,
          slotAt: slotAt ?? null,
          retryOf: retryOf ?? null,
          skipped,
          at,
        }),
      )
      updated(automationId)
      const fired = firing(id)
      if (!fired) throw new Error(`no firing ${id}`)
      return fired
    },
    firings(automationId) {
      const query =
        automationId === undefined
          ? automationFirings.orderBy('at', 'asc')
          : automationFirings.where({ automationId }).orderBy('at', 'asc')
      return store.query(queryDb(query)).map(toFiring)
    },
    firing,
    dropFiring: (id) => firingEvent(id, (at) => events.automationFiringDropped({ id, at })),
    began: (id) => firingEvent(id, (at) => events.automationRunBegan({ id, at })),
    resumeQueued: (id, error) =>
      firingEvent(id, (at) => events.automationRunResumeQueued({ id, error, at })),
    revived: (id) => firingEvent(id, (at) => events.automationRunRevived({ id, at })),
    ended: (id, { outcome, error, message }) =>
      firingEvent(id, (at) =>
        events.automationRunEnded({
          id,
          outcome,
          error: error ?? null,
          message: message ?? null,
          at,
        }),
      ),
    taskCreated(link) {
      commit(events.automationTaskCreated({ ...link, at: now() }))
      updated(link.automationId)
    },
    createdTasks(automationId) {
      const query =
        automationId === undefined
          ? automationTasks.orderBy('at', 'asc')
          : automationTasks.where({ automationId }).orderBy('at', 'asc')
      return store.query(queryDb(query))
    },
    createdTask: (taskId) => store.query(queryDb(automationTasks.where({ taskId }))).at(0),
    taskLinks(taskIds) {
      const rows = inChunks(taskIds, (ids) =>
        store.query(
          queryDb(
            tasks
              .select('id', 'factoryId', 'number', 'title', 'stage')
              .where({ id: { op: 'IN', value: ids } }),
          ),
        ),
      )
      const sources = new Map(
        inChunks(
          rows.map((row) => row.id),
          (ids) =>
            store.query(
              queryDb(
                taskSources.select('taskId', 'url').where({ taskId: { op: 'IN', value: ids } }),
              ),
            ),
        ).map((row) => [row.taskId, row.url]),
      )
      const keys = new Map<string, string>()
      const keyOf = (factoryId: string) => {
        const known = keys.get(factoryId)
        if (known !== undefined) return known
        const key = factoryKey(factoryId)
        keys.set(factoryId, key)
        return key
      }
      return new Map(
        rows.map((row) => {
          const source = sources.get(row.id)
          return [
            row.id,
            {
              id: row.id,
              displayId: `${keyOf(row.factoryId)}-${row.number}`,
              title: row.title,
              stage: row.stage as StageId,
              ...(source !== undefined && { source }),
            },
          ]
        }),
      )
    },
    firingsWithRun: (firingIds) =>
      new Set(
        inChunks(firingIds, (ids) =>
          store.query(queryDb(runs.select('id').where({ id: { op: 'IN', value: ids } }))),
        ),
      ),
    postComment({ choices, ...input }) {
      const id = randomUUID()
      commit(
        events.automationCommentPosted({
          ...input,
          id,
          choices: choices === undefined || choices.length === 0 ? null : choices,
          at: now(),
        }),
      )
      updated(input.automationId)
      const posted = comment(id)
      if (!posted) throw new Error(`no Comment ${id}`)
      return posted
    },
    answerComment(id, text) {
      const found = comment(id)
      if (!found) throw new Error(`no Comment ${id}`)
      commit(events.automationCommentAnswered({ id, text, at: now() }))
      updated(found.automationId)
      return comment(id) ?? found
    },
    comments(automationId) {
      const query =
        automationId === undefined
          ? automationComments.orderBy('createdAt', 'asc')
          : automationComments.where({ automationId }).orderBy('createdAt', 'asc')
      return store.query(queryDb(query)).map(toComment)
    },
    comment,
  }
}
