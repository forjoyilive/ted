import { queryDb, type Store } from '@livestore/livestore'
import type { FailureCase, FailureContext, ValidationProgress } from '@ted/protocol'
import { events, failureCases, failureContexts, type schema, validationProgress } from './schema.ts'

export type FailureChange =
  | 'repair'
  | 'verified'
  | 'recorded'
  | 'assessed'
  | 'evidence'
  | 'requested'
  | 'resolved'
  | 'invalidated'
  | 'fix-chosen'

export function failureEvent(value: FailureCase, kind: FailureChange) {
  const input = {
    id: value.id,
    taskId: value.taskId,
    data: JSON.stringify(value),
    at: new Date().toISOString(),
  }
  switch (kind) {
    case 'repair':
      return events.failureRepairIncorporated(input)
    case 'verified':
      return events.failureVerified(input)
    case 'recorded':
      return events.failureCaseRecorded(input)
    case 'assessed':
      return events.failureAssessed(input)
    case 'evidence':
      return events.failureEvidenceAdded(input)
    case 'requested':
      return events.failureDecisionRequested(input)
    case 'resolved':
      return events.failureResolved(input)
    case 'invalidated':
      return events.failureAcceptanceInvalidated(input)
    case 'fix-chosen':
      return events.failureFixChosen(input)
  }
}

export interface FailureStore {
  progress(taskId: string): ValidationProgress | undefined
  saveProgress(value: ValidationProgress): ValidationProgress
  list(taskId: string): FailureCase[]
  get(id: string): FailureCase | undefined
  contexts(taskId: string): FailureContext[]
  context(id: string): FailureContext | undefined
  capture(value: FailureContext): FailureContext
  event(value: FailureCase, kind: FailureChange): ReturnType<typeof failureEvent>
  save(value: FailureCase, kind: FailureChange): FailureCase
}

export function createFailureStore({
  store,
  commit,
  changed,
}: {
  store: Store<typeof schema>
  commit: Store<typeof schema>['commit']
  changed(taskId: string): void
}): FailureStore {
  const get = (id: string) => {
    const row = store.query(queryDb(failureCases.where({ id }))).at(0)
    return row ? (JSON.parse(row.data) as FailureCase) : undefined
  }
  const event = (value: FailureCase, kind: FailureChange) => {
    const previous = get(value.id)
    if (kind === 'recorded') {
      if (
        previous ||
        value.repairProgress?.length ||
        value.verifications?.length ||
        value.assessments.length ||
        value.additions.length ||
        value.decisions.length ||
        value.resolutions.length ||
        value.invalidations.length
      )
        throw new Error('a new failure case cannot replace history')
    } else {
      if (!previous) throw new Error('failure case does not exist')
      const fields = [
        'taskId',
        'source',
        'recordedBy',
        'provenance',
        'evidence',
        'originalCheck',
        'contextId',
        'createdAt',
        'validation',
      ] as const
      for (const field of fields) {
        if (JSON.stringify(previous[field]) !== JSON.stringify(value[field]))
          throw new Error('original failure evidence is immutable')
      }
      const changed = {
        repair: 'repairProgress',
        verified: 'verifications',
        assessed: 'assessments',
        evidence: 'additions',
        requested: 'decisions',
        resolved: 'resolutions',
        invalidated: 'invalidations',
        'fix-chosen': 'leadFixes',
      } as const
      for (const field of Object.values(changed)) {
        const old = previous[field] ?? []
        const next = value[field] ?? []
        if (
          next.length !== old.length + (field === changed[kind] ? 1 : 0) ||
          JSON.stringify(next.slice(0, old.length)) !== JSON.stringify(old)
        )
          throw new Error('failure history must be append-only')
      }
    }
    return failureEvent(value, kind)
  }
  return {
    progress(taskId) {
      const row = store.query(queryDb(validationProgress.where({ taskId }))).at(0)
      return row ? (JSON.parse(row.data) as ValidationProgress) : undefined
    },
    saveProgress(value) {
      commit(events.validationProgressed({ taskId: value.taskId, data: JSON.stringify(value) }))
      changed(value.taskId)
      return value
    },
    list: (taskId) =>
      store
        .query(queryDb(failureCases.where({ taskId }).orderBy('at', 'asc')))
        .map((r) => JSON.parse(r.data) as FailureCase),
    get,
    event,
    contexts: (taskId) =>
      store
        .query(queryDb(failureContexts.where({ taskId })))
        .map((r) => JSON.parse(r.data) as FailureContext),
    context: (id) => {
      const row = store.query(queryDb(failureContexts.where({ id }))).at(0)
      return row ? (JSON.parse(row.data) as FailureContext) : undefined
    },
    capture(value) {
      if (store.query(queryDb(failureContexts.where({ id: value.id }))).length > 0)
        throw new Error('tested context is immutable')
      commit(
        events.failureContextCaptured({
          id: value.id,
          taskId: value.taskId,
          data: JSON.stringify(value),
          at: value.capturedAt,
        }),
      )
      return value
    },
    save(value, kind) {
      commit(event(value, kind))
      changed(value.taskId)
      return value
    },
  }
}
