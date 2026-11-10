import { randomUUID } from 'node:crypto'
import type {
  AssessFailureRequest,
  Comment,
  FailureCase,
  FailureContext,
  RecordFailureRequest,
  ResolveFailureRequest,
  Task,
  ValidationObligations,
} from '@ted/protocol'
import { RequestError } from '../errors.ts'
import { redactSecrets } from '../redact.ts'
import type { TedStore } from '../store/index.ts'

export const failureChoices = {
  accepted: 'Accept this failure',
  fixed: 'Fixed',
  'no-longer-applicable': 'No longer applicable',
} as const

export function failureText(value: string): string {
  for (const match of value.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    try {
      const url = new URL(match[0])
      if (
        url.username ||
        url.password ||
        [...url.searchParams.keys()].some((key) =>
          /token|secret|password|credential|key|signature/i.test(key),
        )
      ) {
        throw new RequestError(400, 'evidence links must not contain credentials')
      }
    } catch (error) {
      if (error instanceof RequestError) throw error
      throw new RequestError(400, 'evidence contains an invalid link')
    }
  }
  return redactSecrets(value).slice(0, 16_000)
}

export function createFailureCases(options: {
  store: TedStore
  snapshot(task: Task): Promise<FailureContext>
  assertLead(task: Task, runId: string): void
  drafts(taskId: string): readonly string[]
  onHold(task: Task): Promise<void>
  onInvalidated(task: Task, ids: string[]): Promise<void>
  tell(task: Task, comment: Comment): Promise<void>
}) {
  const { store } = options
  const get = (task: Task, id: string) => {
    const value = store.failures.get(id)
    if (!value || value.taskId !== task.id)
      throw new RequestError(404, 'no failure case on this Task')
    return value
  }
  const tested = (task: Task, id?: string) => {
    if (!id) return undefined
    const found = store.failures.context(id)
    if (!found || found.taskId !== task.id)
      throw new RequestError(400, 'tested context must belong to this Task')
    return found
  }
  const decisionComment = (value: FailureCase) => {
    const decision = value.decisions.at(-1)
    return decision ? store.getComment(decision.commentId) : undefined
  }
  const withdraw = (value: FailureCase) => {
    const comment = decisionComment(value)
    if (comment && !comment.answer)
      store.answerComment(comment.id, {
        kind: 'withdrawn',
        at: new Date().toISOString(),
        cancelled: true,
      })
  }
  async function obligations(
    task: Task,
    observed?: FailureContext | null,
  ): Promise<ValidationObligations> {
    const values = store.failures.list(task.id)
    const checkRuns = store
      .listCheckRuns(task.id)
      .map(({ id, trigger, stage, outcome, startedAt, finishedAt }) => ({
        id,
        trigger,
        stage,
        startedAt,
        ...(outcome && { outcome }),
        ...(finishedAt && { finishedAt }),
      }))
    if (values.length === 0) return { satisfied: true, checkRuns, cases: [], blockers: [] }
    let current = observed
    if (current === undefined) current = await options.snapshot(task).catch(() => null)
    const cases: ValidationObligations['cases'] = []
    const invalidated: string[] = []
    for (let value of values) {
      const resolution = value.resolutions.at(-1)
      let disposition: ValidationObligations['cases'][number]['disposition'] =
        resolution?.resolution ?? 'unresolved'
      const context = tested(task, resolution?.contextId ?? value.contextId)
      const state =
        !current || !context
          ? 'unknown'
          : current.fingerprint === context.fingerprint
            ? 'current'
            : 'changed'
      if (resolution?.resolution === 'accepted') {
        const invalid = value.invalidations.some((i) => i.requestId === resolution.requestId)
        if (!invalid && state !== 'current') {
          value = {
            ...value,
            invalidations: [
              ...value.invalidations,
              {
                requestId: resolution.requestId,
                reason:
                  state === 'unknown' ? 'Context could not be verified' : 'Tested context changed',
                at: new Date().toISOString(),
              },
            ],
          }
          store.failures.save(value, 'invalidated')
          invalidated.push(value.id)
          withdraw(value)
        }
        if (invalid || state !== 'current') disposition = 'invalidated'
      }
      cases.push({ id: value.id, disposition, context: state })
    }
    const blockers = cases
      .filter((c) => c.disposition === 'unresolved' || c.disposition === 'invalidated')
      .map((c) => c.id)
    if (blockers.length > 0) {
      await store.persisted()
      try {
        await options.onHold(task)
      } finally {
        if (invalidated.length > 0) await options.onInvalidated(task, invalidated)
      }
    }
    return { satisfied: blockers.length === 0, checkRuns, cases, blockers }
  }
  return {
    list: (task: Task) => store.failures.list(task.id),
    get,
    obligations,
    async capture(task: Task, runId: string) {
      const context = await options.snapshot(task)
      options.assertLead(task, runId)
      return store.failures.capture(context)
    },
    async record(task: Task, runId: string, request: RecordFailureRequest): Promise<FailureCase> {
      const context = tested(task, request.contextId)
      let originalCheck: FailureCase['originalCheck']
      const source = request.source
      if (source.kind === 'factory-check' || source.kind === 'post-rebase-check') {
        const run = store.getCheckRun(source.checkRunId)
        const check = run?.checks[source.position]
        if (
          !run ||
          run.taskId !== task.id ||
          !check ||
          !['failed', 'timed-out'].includes(check.state)
        )
          throw new RequestError(
            400,
            'source must identify a failed or timed-out Check on this Task',
          )
        if ((run.trigger === 'merge') !== (source.kind === 'post-rebase-check'))
          throw new RequestError(400, 'Check source does not match its trigger')
        if (context && context.capturedAt > run.startedAt)
          throw new RequestError(
            409,
            'context must be captured before Check execution, not borrowed from the current worktree',
          )
        originalCheck = {
          ...check,
          name: failureText(check.name),
          command: failureText(check.command),
          timeout: failureText(check.timeout),
        }
      } else if (source.kind === 'finding') {
        if (store.getRun(source.runId)?.taskId !== task.id)
          throw new RequestError(400, 'Finding must originate from a Run on this Task')
      } else if (
        source.kind === 'github-ci' &&
        !task.repos.some(
          (r) => !r.removed && r.repo === source.repo && r.pullRequest?.number === source.number,
        )
      )
        throw new RequestError(400, 'CI source must identify this Task’s pull request')
      const safeSource =
        source.kind === 'finding'
          ? { ...source, finding: failureText(source.finding) }
          : source.kind === 'github-ci'
            ? { ...source, attempt: failureText(source.attempt) }
            : source
      const value: FailureCase = {
        id: randomUUID(),
        taskId: task.id,
        recordedBy: runId,
        provenance: originalCheck ? 'stored-check' : 'task-lead-reported',
        source: safeSource,
        evidence: failureText(request.evidence),
        ...(originalCheck && { originalCheck }),
        ...(context && { contextId: context.id }),
        createdAt: new Date().toISOString(),
        assessments: [],
        additions: [],
        decisions: [],
        resolutions: [],
        invalidations: [],
      }
      store.failures.save(value, 'recorded')
      await store.persisted()
      await options.onHold(task)
      return value
    },
    evidence(task: Task, id: string, runId: string, evidence: string, contextId?: string) {
      const value = get(task, id)
      tested(task, contextId)
      if (
        value.resolutions.at(-1)?.resolution &&
        value.resolutions.at(-1)?.resolution !== 'accepted'
      )
        throw new RequestError(409, 'this case is closed; record a new failure')
      withdraw(value)
      const next = {
        ...value,
        additions: [
          ...value.additions,
          {
            evidence: failureText(evidence),
            runId,
            at: new Date().toISOString(),
            ...(contextId && { contextId }),
          },
        ],
      }
      return store.failures.save(next, 'evidence')
    },
    async assess(task: Task, id: string, runId: string, request: AssessFailureRequest) {
      await obligations(task)
      options.assertLead(task, runId)
      const value = get(task, id)
      const lastResolution = value.resolutions.at(-1)
      if (lastResolution && lastResolution.resolution !== 'accepted')
        throw new RequestError(409, 'this case is closed; record a new failure')
      if (
        lastResolution?.resolution === 'accepted' &&
        !value.invalidations.some((i) => i.requestId === lastResolution.requestId)
      )
        throw new RequestError(409, 'this failure already has current acceptance')
      withdraw(value)
      const contextId = value.additions.at(-1)?.contextId ?? value.contextId
      return store.failures.save(
        {
          ...value,
          assessments: [
            ...value.assessments,
            {
              id: randomUUID(),
              ...request,
              recommendation: failureText(request.recommendation),
              runId,
              ...(contextId && { contextId }),
              at: new Date().toISOString(),
            },
          ],
        },
        'assessed',
      )
    },
    async request(task: Task, id: string, runId: string) {
      await obligations(task)
      options.assertLead(task, runId)
      const value = get(task, id)
      const resolution = value.resolutions.at(-1)
      if (
        resolution &&
        (resolution.resolution !== 'accepted' ||
          !value.invalidations.some((i) => i.requestId === resolution.requestId))
      )
        throw new RequestError(409, 'this case is already resolved')
      const assessment = value.assessments.at(-1)
      if (!assessment || (value.additions.at(-1)?.at ?? '') > assessment.at)
        throw new RequestError(409, 'assess this failure before asking for a decision')
      const previous = value.decisions.at(-1)
      if (previous?.assessmentId === assessment.id)
        throw new RequestError(
          409,
          'this assessment already has a decision request; assess again for a new decision',
        )
      return store.postFailureDecision(
        value,
        `Failure ${value.id}\n\n${value.evidence}\n\nAssessment: ${assessment.assessment}\nRecommendation: ${assessment.recommendation}\n\nAccept only this failure for its tested context, or close it as fixed or no longer applicable. Fixed and No longer applicable need a reason. Acceptance never marks the original result as passed.`,
      )
    },
    findDecision(commentId: string) {
      const comment = store.getComment(commentId)
      return (
        comment &&
        store.failures
          .list(comment.taskId)
          .find((v) => v.decisions.some((d) => d.commentId === commentId))
      )
    },
    async resolve(task: Task, id: string, request: ResolveFailureRequest) {
      await obligations(task)
      const value = get(task, id)
      const decision = value.decisions.at(-1)
      const assessment = value.assessments.at(-1)
      const comment = store.getComment(request.requestId)
      if (
        !decision ||
        decision.commentId !== request.requestId ||
        decision.assessmentId !== assessment?.id ||
        !comment ||
        comment.answer
      )
        throw new RequestError(409, 'this failure decision is stale or already answered')
      const reason = failureText(request.reason?.trim() ?? '')
      if (request.resolution !== 'accepted' && !reason)
        throw new RequestError(400, 'closing a failure needs a reason')
      const context = tested(task, decision.contextId)
      if (request.resolution === 'accepted') {
        const current = await options.snapshot(task).catch(() => undefined)
        if (!value.contextId || !context || !current || context.fingerprint !== current.fingerprint)
          throw new RequestError(409, 'acceptance requires verified matching tested context')
      }
      const at = new Date().toISOString()
      const next = {
        ...value,
        resolutions: [
          ...value.resolutions,
          {
            ...request,
            reason,
            at,
            assessmentId: assessment.id,
            ...(context && { contextId: context.id }),
          },
        ],
      }
      const answer = {
        kind: 'answered' as const,
        choice: failureChoices[request.resolution],
        text: reason,
        at,
      }
      store.resolveFailure(next, request.requestId, answer, options.drafts(task.id))
      await store.persisted()
      await options.tell(task, store.getComment(request.requestId) as Comment)
      return next
    },
  }
}
