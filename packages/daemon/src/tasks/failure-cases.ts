import { createHash, randomUUID } from 'node:crypto'
import type {
  AssessFailureRequest,
  Comment,
  FailureCase,
  FailureContext,
  FailureSource,
  RecordFailureRequest,
  ResolveFailureRequest,
  Task,
  ValidationObligations,
} from '@ted/protocol'
import { failureChoices, validateFailureChoices } from '@ted/protocol'
import { RequestError } from '../errors.ts'
import { redactSecrets } from '../redact.ts'
import type { TedStore } from '../store/index.ts'
import type { ResolvedWorkflow } from '../workflow/resolve.ts'

export function ciFailureKey(source: Extract<FailureSource, { kind: 'github-ci' }>): string {
  return createHash('sha256')
    .update(JSON.stringify([source.repo, source.number, source.head, source.attempt]))
    .digest('hex')
}

export const failureNoticeTitle = 'Failure acceptance invalidated'
export const failureRefusedTitle = 'Failure acceptance refused'
export const failureNoticeTitles: readonly (string | undefined)[] = [
  failureNoticeTitle,
  failureRefusedTitle,
]

const testedInputs = (context: FailureContext) =>
  JSON.stringify([
    context.version,
    context.ciFailures,
    context.repos.map(({ repo, head, tree, mergeBase }) => [repo, head, tree, mergeBase]),
    context.checks,
    context.ci,
  ])

export const sameTested = (a: FailureContext, b: FailureContext) =>
  testedInputs(a) === testedInputs(b)

const otherChoices = (validation: boolean) =>
  validation
    ? 'Choose Retry or Fix in this Task instead.'
    : 'Type a reason and choose Fixed or No longer applicable instead.'

export const acceptRefusals = {
  changed:
    'The Task’s code or Checks changed since this failure was assessed, so it can’t be accepted as it is. Ask the Task Lead to assess it again.',
  changedForGood: (validation: boolean) =>
    `The Task’s code or Checks changed since this failure was tested, and TED can’t tie a later test run to it, so it can’t be accepted any more. ${otherChoices(validation)}`,
  unverified:
    'TED couldn’t read the Task’s current code, Checks and CI to compare them with what was tested, so this failure can’t be accepted right now. Try again in a moment.',
  unknown:
    'TED has no record it can verify of what was tested when this failure happened, so it can’t be accepted. Ask the Task Lead to record it again with a tested context.',
}

const freshContextSteps = (id: string) =>
  `Capture a fresh context with \`ted failure context\`, add evidence that names it with \`ted failure evidence ${id} --file <json>\` (\`{"evidence":"…","contextId":"<new context ID>"}\`), then run \`ted failure assess ${id} --file <json>\` and \`ted failure ask ${id}\`. Evidence without the new contextId leaves the decision bound to the old context.`

const newCaseSteps =
  'A newly captured context can’t be attached to this failure, because TED can’t tie a later capture to the execution that failed. Run the verification again after `ted failure context` (`ted checks` for a Factory Check); a failure that happens again is a new case to record, assess and ask about.'

export function leadClosesFailures(workflow: ResolvedWorkflow): boolean {
  return workflow.settings.stages.work?.lead_closes_failures === true
}

export const leadClosesRefusal =
  'only the human closes a failure recorded outside Validate: assess it with a recommendation of Fixed and run `ted failure ask <id>`. A Factory lets the Task Lead close its own Finding with passing evidence with `stages.work.lead_closes_failures: true` in its `.ted/workflow.yaml`; only the human changes that'

export function acceptedResolution(value: FailureCase): boolean {
  const resolution = value.resolutions.at(-1)
  return (
    resolution?.resolution === 'accepted' &&
    !value.invalidations.some((i) => i.requestId === resolution.requestId)
  )
}

function currentAssessment(value: FailureCase) {
  const assessment = value.assessments.at(-1)
  const count = assessment?.evidenceCount ?? (value.additions.length === 0 ? 0 : undefined)
  return count === value.additions.length ? assessment : undefined
}

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

export function generatedFailureText(value: string): string {
  return failureText(
    redactSecrets(value).replace(/https?:\/\/[^\s<>"']+/gi, (link) => {
      try {
        return failureText(link)
      } catch {
        return '[unsafe or invalid link omitted]'
      }
    }),
  )
}

export function createFailureCases(options: {
  store: TedStore
  snapshot(task: Task, bindCi: () => void): Promise<FailureContext>
  assertLead(task: Task, runId: string): void
  drafts(taskId: string): readonly string[]
  onHold(task: Task): Promise<void>
  onInvalidated(task: Task, ids: string[]): Promise<void>
  tell(task: Task, comment: Comment): Promise<void>
}) {
  const { store } = options
  const closed = (value: FailureCase) =>
    value.verifications?.length ||
    ['fixed', 'no-longer-applicable'].includes(value.resolutions.at(-1)?.resolution ?? '')
  const observations = new Map<string, { ci: string | null | undefined; generation: number }>()
  const collections = new WeakMap<FailureContext, number>()
  async function snapshot(
    task: Task,
    collect = (bindCi: () => void) => options.snapshot(task, bindCi),
  ) {
    let generation = observations.get(task.id)?.generation ?? 0
    const context = await collect(() => {
      generation = observations.get(task.id)?.generation ?? 0
    })
    collections.set(context, generation)
    return context
  }
  function verifiedContext(task: Task, context: FailureContext | null | undefined) {
    if (!context) return context
    const generation = collections.get(context)
    const observation = observations.get(task.id)
    return generation !== undefined &&
      observation &&
      (generation !== observation.generation ||
        observation.ci === null ||
        observation.ci !== context.ci)
      ? null
      : context
  }
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
  const sourceContext = (
    source: FailureSource,
    context?: Pick<FailureContext, 'capturedAt' | 'ciFailures'>,
  ) => {
    if (!context) return false
    if (source.kind === 'github-ci')
      return context.ciFailures?.includes(ciFailureKey(source)) === true
    if (source.kind === 'finding') {
      const run = store.getRun(source.runId)
      return (
        !!run &&
        context.capturedAt >= run.startedAt &&
        (run.state !== 'finished' || !!run.ended) &&
        (!run.ended || context.capturedAt <= run.ended.at)
      )
    }
    const run = store.getCheckRun(source.checkRunId)
    return !!run && context.capturedAt <= run.startedAt
  }
  const decisionComment = (value: FailureCase) => {
    const decision = value.decisions.at(-1)
    return decision ? store.getComment(decision.commentId) : undefined
  }
  const attachable = (task: Task, value: FailureCase, current?: FailureContext | null) =>
    sourceContext(value.source, tested(task, value.contextId)) &&
    sourceContext(value.source, current ?? { capturedAt: new Date().toISOString() })
  const nextSteps = (task: Task, value: FailureCase, current?: FailureContext | null) =>
    attachable(task, value, current) ? freshContextSteps(value.id) : newCaseSteps
  async function tellRefused(
    task: Task,
    value: FailureCase,
    requestId: string,
    why: string,
    current?: FailureContext | null,
  ) {
    const body = `The human chose Accept this failure for failure case ${value.id} (decision ${requestId}) and TED refused it: ${why} The question stays open and the Task stays held. ${nextSteps(task, value, current)}`
    if (
      store
        .listComments(task.id)
        .some((comment) => comment.author.kind === 'ted' && comment.body === body)
    )
      return
    store.postComment({
      taskId: task.id,
      author: { kind: 'ted' },
      title: failureRefusedTitle,
      body,
    })
    await store.persisted()
    await options.onInvalidated(task, [value.id])
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
  function verify(
    task: Task,
    current: FailureContext | null | undefined,
    observedCi?: { value: string | null | undefined },
  ) {
    current = verifiedContext(task, current)
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
    const completed = task.stage === 'done'
    const cases: ValidationObligations['cases'] = []
    const invalidated: string[] = []
    for (let value of values) {
      const resolution = value.resolutions.at(-1)
      let disposition: ValidationObligations['cases'][number]['disposition'] =
        value.verifications?.at(-1)?.replacedBy
          ? 'retried'
          : value.verifications?.length
            ? 'fixed'
            : resolution?.resolution === 'retry' || resolution?.resolution === 'fix'
              ? 'unresolved'
              : (resolution?.resolution ?? 'unresolved')
      const context = tested(task, resolution?.contextId ?? value.contextId)
      const state = completed
        ? 'historical'
        : !context ||
            !sourceContext(value.source, tested(task, value.contextId)) ||
            !sourceContext(value.source, context)
          ? 'unknown'
          : observedCi
            ? observedCi.value === null
              ? 'unknown'
              : observedCi.value === context.ci
                ? 'current'
                : 'changed'
            : !current
              ? 'unknown'
              : sameTested(current, context)
                ? 'current'
                : 'changed'
      if (resolution?.resolution === 'accepted' && !value.verifications?.length) {
        const invalid = !acceptedResolution(value)
        if (!completed && !invalid && state !== 'current') {
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
          store.invalidateFailure(value, {
            title: failureNoticeTitle,
            body: `Acceptance is no longer current for failure case ${value.id} (decision ${resolution.requestId}). Its tested context changed or could not be verified. Advancement remains held until the human decides again. ${nextSteps(task, value, current)}`,
          })
          invalidated.push(value.id)
          withdraw(value)
        }
        if (invalid || (!completed && state !== 'current')) disposition = 'invalidated'
      }
      cases.push({ id: value.id, disposition, context: state })
    }
    const blockers = cases
      .filter((c) => c.disposition === 'unresolved' || c.disposition === 'invalidated')
      .map((c) => c.id)
    return {
      result: { satisfied: blockers.length === 0, checkRuns, cases, blockers },
      invalidated,
    }
  }
  async function applyHold(task: Task, { result, invalidated }: ReturnType<typeof verify>) {
    if (task.stage !== 'done' && result.blockers.length > 0) {
      await store.persisted()
      try {
        await options.onHold(task)
      } finally {
        if (invalidated.length > 0) await options.onInvalidated(task, invalidated)
      }
    }
  }
  async function obligations(
    task: Task,
    observed?: FailureContext | null,
  ): Promise<ValidationObligations> {
    let current = observed
    if (task.stage !== 'done' && current === undefined && store.failures.list(task.id).length > 0)
      current = await snapshot(task).catch(() => null)
    const verification = verify(task, current)
    await applyHold(task, verification)
    const final = verify(task, current)
    if (final.invalidated.length > 0) await applyHold(task, final)
    return final.result
  }
  function pendingDecision(task: Task, id: string, requestId: string) {
    const value = get(task, id)
    const decision = value.decisions.at(-1)
    const assessment = currentAssessment(value)
    const comment = store.getComment(requestId)
    if (
      !decision ||
      decision.commentId !== requestId ||
      decision.assessmentId !== assessment?.id ||
      !comment ||
      comment.answer
    )
      throw new RequestError(409, 'this failure decision is stale or already answered')
    return { value, decision, assessment }
  }
  async function record(
    task: Task,
    runId: string,
    request: RecordFailureRequest,
    generated = false,
  ): Promise<FailureCase> {
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
        throw new RequestError(400, 'source must identify a failed or timed-out Check on this Task')
      if ((run.trigger === 'merge') !== (source.kind === 'post-rebase-check'))
        throw new RequestError(400, 'Check source does not match its trigger')
      if (context && context.capturedAt > run.startedAt)
        throw new RequestError(
          409,
          'context must be captured before Check execution, not borrowed from the current worktree',
        )
      originalCheck = {
        ...check,
        name: generatedFailureText(check.name),
        command: generatedFailureText(check.command),
        timeout: generatedFailureText(check.timeout),
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
    if (context && !sourceContext(source, context))
      throw new RequestError(
        409,
        'tested context does not identify this execution; omit contextId for historical or unknown evidence',
      )
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
      evidence: generated ? generatedFailureText(request.evidence) : failureText(request.evidence),
      ...(originalCheck && { originalCheck }),
      ...(context && { contextId: context.id }),
      createdAt: new Date().toISOString(),
      ...(task.stage === 'validate' && { validation: true }),
      assessments: [],
      additions: [],
      decisions: [],
      resolutions: [],
      invalidations: [],
    }
    store.failures.save(value, 'recorded')
    if (value.validation)
      store.postComment({
        taskId: task.id,
        author: { kind: 'ted' },
        title: 'Validate failure recorded',
        body: `Failure ${value.id}\n\n${value.evidence}\n\nThe Task stays in Validate for investigation. No send-back was recorded.`,
      })
    await store.persisted()
    await options.onHold(task)
    return value
  }
  return {
    pendingDecision,
    verifyResult(
      task: Task,
      id: string,
      evidence: string,
      checkRunId?: string,
      replacedBy?: string,
    ) {
      const value = get(task, id)
      withdraw(value)
      return store.failures.save(
        {
          ...value,
          verifications: [
            ...(value.verifications ?? []),
            {
              at: new Date().toISOString(),
              evidence: failureText(evidence),
              ...(checkRunId && { checkRunId }),
              ...(replacedBy && { replacedBy }),
            },
          ],
        },
        'verified',
      )
    },
    list: (task: Task) => store.failures.list(task.id),
    get,
    obligations,
    snapshot,
    forget: (taskId: string) => observations.delete(taskId),
    async observeCi(task: Task, ci: string | null | undefined) {
      const previous = observations.get(task.id)
      observations.set(task.id, {
        ci,
        generation: (previous?.generation ?? 0) + (previous && previous.ci !== ci ? 1 : 0),
      })
      if (store.failures.list(task.id).length === 0) return
      const verification = verify(task, undefined, { value: ci })
      if (verification.invalidated.length > 0) await applyHold(task, verification)
    },
    async capture(task: Task, runId: string) {
      const context = await snapshot(task).catch(async (error: unknown) => {
        await obligations(task, null)
        throw error
      })
      options.assertLead(task, runId)
      await obligations(task, context)
      options.assertLead(task, runId)
      if (!verifiedContext(task, context)) {
        await obligations(task, null)
        throw new RequestError(409, 'tested context was superseded during capture')
      }
      return store.failures.capture(context)
    },
    record,
    recordCheck(task: Task, runId: string, request: RecordFailureRequest) {
      if (request.source.kind !== 'factory-check')
        throw new RequestError(400, 'automatic evidence requires a stored Factory Check')
      return record(task, runId, request, true)
    },
    evidence(task: Task, id: string, runId: string, evidence: string, contextId?: string) {
      const value = get(task, id)
      tested(task, contextId)
      if (closed(value)) throw new RequestError(409, 'this case is closed; record a new failure')
      const safeEvidence = failureText(evidence)
      withdraw(value)
      const next = {
        ...value,
        additions: [
          ...value.additions,
          {
            evidence: safeEvidence,
            runId,
            at: new Date().toISOString(),
            ...(contextId && { contextId }),
          },
        ],
      }
      return store.failures.save(next, 'evidence')
    },
    async assess(task: Task, id: string, runId: string, request: AssessFailureRequest) {
      const recommendation = failureText(request.recommendation)
      await obligations(task)
      options.assertLead(task, runId)
      const value = get(task, id)
      if (closed(value)) throw new RequestError(409, 'this case is closed; record a new failure')
      if (acceptedResolution(value))
        throw new RequestError(409, 'this failure already has current acceptance')
      withdraw(value)
      const contextId = value.additions.at(-1)?.contextId ?? value.contextId
      if (value.validation)
        store.postComment({
          taskId: task.id,
          author: { kind: 'run', runId },
          title: 'Failure assessment',
          body: `Failure ${value.id}\n\nAssessment: ${request.assessment}\n\nRecommendation: ${recommendation}`,
        })
      return store.failures.save(
        {
          ...value,
          assessments: [
            ...value.assessments,
            {
              id: randomUUID(),
              ...request,
              recommendation,
              runId,
              evidenceCount: value.additions.length,
              ...(contextId && { contextId }),
              at: new Date().toISOString(),
            },
          ],
        },
        'assessed',
      )
    },
    async request(task: Task, id: string, runId: string) {
      const observed =
        store.failures.list(task.id).length > 0 ? await snapshot(task).catch(() => null) : undefined
      await obligations(task, observed)
      options.assertLead(task, runId)
      const value = get(task, id)
      const resolution = value.resolutions.at(-1)
      if (closed(value) || (resolution?.resolution === 'accepted' && acceptedResolution(value)))
        throw new RequestError(409, 'this case is already resolved')
      const assessment = currentAssessment(value)
      if (!assessment)
        throw new RequestError(409, 'assess this failure before asking for a decision')
      const previous = value.decisions.at(-1)
      if (previous?.assessmentId === assessment.id)
        throw new RequestError(
          409,
          'this assessment already has a decision request; assess again for a new decision',
        )
      const bound = tested(task, assessment.contextId)
      const current = verifiedContext(task, observed)
      const stale = !!bound && !!current && !sameTested(bound, current)
      if (stale && attachable(task, value, current))
        throw new RequestError(
          409,
          `The Task’s code, Checks or CI changed since tested context ${bound.id}, which this assessment is bound to, so the human could not accept this failure. ${freshContextSteps(value.id)}`,
        )
      return store.postFailureDecision(
        value,
        [
          `Failure ${value.id}`,
          `Source: ${JSON.stringify(value.source)}`,
          `Original tested context: ${value.contextId ?? 'unknown'}`,
          `Decision tested context: ${assessment.contextId ?? 'unknown'}`,
          `Original evidence:\n${value.evidence}`,
          ...value.additions.map(
            (addition) =>
              `Evidence added ${addition.at} (context ${addition.contextId ?? 'unknown'}):\n${addition.evidence}`,
          ),
          `Assessment: ${assessment.assessment}\nRecommendation: ${assessment.recommendation}`,
          value.validation
            ? 'Retry repeats the failed verification; Fix in this Task sends Findings to Work through the existing send-back rules. Accept this failure allows only this execution in its tested context and resumes remaining Checks and validation. Acceptance never means passed or grants merge approval.'
            : 'Accept only this failure for its tested context, or close it as fixed or no longer applicable. Fixed and No longer applicable need a reason. Acceptance never marks the original result as passed.',
          ...(stale
            ? [
                `Accept this failure will be refused: the Task’s code or Checks changed since it was tested, and TED can’t tie a later test run to this failure. ${otherChoices(value.validation === true)}`,
              ]
            : []),
        ].join('\n\n'),
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
    async resolve(task: Task, id: string, request: ResolveFailureRequest, sendDrafts = true) {
      await obligations(task)
      pendingDecision(task, id, request.requestId)
      const reason = failureText(request.reason?.trim() ?? '')
      if (
        request.resolution !== 'accepted' &&
        request.resolution !== 'retry' &&
        request.resolution !== 'fix' &&
        !reason
      )
        throw new RequestError(400, 'closing a failure needs a reason')
      const current =
        request.resolution === 'accepted'
          ? verifiedContext(task, await snapshot(task).catch(() => null))
          : undefined
      const verification = current === undefined ? undefined : verify(task, current)
      let refused: { value: FailureCase; why: string } | undefined
      try {
        const { value, decision, assessment } = pendingDecision(task, id, request.requestId)
        const context = tested(task, decision.contextId)
        if (request.resolution === 'accepted') {
          if (
            !sourceContext(value.source, tested(task, value.contextId)) ||
            !sourceContext(value.source, context) ||
            !context
          ) {
            refused = {
              value,
              why: 'TED can’t verify what was tested for the context this decision is bound to.',
            }
            throw new RequestError(409, acceptRefusals.unknown)
          }
          if (!current) throw new RequestError(409, acceptRefusals.unverified)
          if (!sameTested(context, current)) {
            refused = {
              value,
              why: 'the Task’s code, Checks or CI changed since the tested context this decision is bound to.',
            }
            throw new RequestError(
              409,
              attachable(task, value, current)
                ? acceptRefusals.changed
                : acceptRefusals.changedForGood(value.validation === true),
            )
          }
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
          choice:
            request.resolution === 'retry' || request.resolution === 'fix'
              ? validateFailureChoices[request.resolution]
              : failureChoices[request.resolution],
          text: reason,
          at,
        }
        store.resolveFailure(
          next,
          request.requestId,
          answer,
          sendDrafts ? options.drafts(task.id) : [],
        )
        await store.persisted()
        await options.tell(task, store.getComment(request.requestId) as Comment)
        return next
      } finally {
        try {
          if (verification) await applyHold(task, verification)
        } finally {
          if (refused)
            await tellRefused(task, refused.value, request.requestId, refused.why, current).catch(
              (error: unknown) =>
                console.error('couldn’t tell the Task Lead about a refusal:', error),
            )
        }
      }
    },
  }
}
