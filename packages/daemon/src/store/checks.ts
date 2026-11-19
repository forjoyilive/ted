import { randomUUID } from 'node:crypto'
import { queryDb } from '@livestore/livestore'
import {
  type AcceptRefusal,
  type AgentKind,
  type AgentStageId,
  type CheckRun,
  type CheckRunOutcome,
  type CheckRunTiming,
  type CheckRunTrigger,
  type CheckState,
  type CommentAnswer,
  checkLabel,
  type DeclaredSendBackCause,
  declaredSendBackCauses,
  type FailureCase,
  type FindingSeverity,
  failureChoiceLabels,
  namedRepairChoice,
  type SendBack,
  type SendBackCause,
  type StageId,
  type Task,
} from '@ted/protocol'
import { mergesHere, validates } from '@ted/protocol/stage'
import { offeredFailureChoices } from '../tasks/failure-choices.ts'
import type { StoreContext } from './context.ts'
import { sendBackSeverities } from './dashboard.ts'
import type { FailureStore } from './failures.ts'
import {
  checkBoundaries,
  checkRuns,
  events,
  loopChecks,
  p1OnlyReviews,
  reviewers,
  reviewScopes,
  sendBackAsks,
  sendBackResets,
  sendBacks,
  severityDeclarations,
} from './schema.ts'
import type { TestInvocationStore } from './test-invocations.ts'
import type {
  FoundConflict,
  LoopCheck,
  LoopVerdict,
  PlannedCheck,
  RepairApproval,
  RepoCommit,
  Reviewer,
  ReviewerPurpose,
  ReviewScope,
  SendBackAsk,
} from './types.ts'

const declaredCause = (cause: string | null): { cause?: DeclaredSendBackCause } => {
  const known = declaredSendBackCauses.find((c) => c === cause)
  return known === undefined ? {} : { cause: known }
}

export interface ChecksArea {
  recordSendBack(input: {
    taskId: string
    from: StageId
    to: StageId
    findings: string
    counted: boolean
    round?: number
    limit?: number
    checkRunId?: string
    cause?: SendBackCause
    conflict?: FoundConflict
  }): SendBack
  listSendBacks(taskId: string): SendBack[]
  declareSeverity(input: {
    taskId: string
    runId: string
    round: number
    severity: FindingSeverity
  }): void
  recordP1OnlyReview(input: { runId: string; taskId: string; round: number; from: number }): void
  p1OnlyReview(runId: string): boolean
  startChecks(input: {
    taskId: string
    trigger: CheckRunTrigger
    stage: StageId
    checks: PlannedCheck[]
  }): CheckRun
  replanChecks(checkRunId: string, from: number, checks: PlannedCheck[]): CheckRun
  checkSlotBoundary(
    checkRunId: string,
    boundary: 'entered' | 'acquired' | 'canceled' | 'interrupted' | 'recovered',
    at: string,
  ): void
  checkTiming(checkRunId: string): CheckRunTiming | undefined
  listCheckTimings(taskId: string): CheckRunTiming[]
  checkInterrupted(checkRunId: string, position: number): void
  checkKilledForMemory(
    checkRunId: string,
    position: number,
    killed: { lowestMemory: number; durationMs: number },
  ): CheckRun
  checkStarted(checkRunId: string, position: number): CheckRun
  checkFinished(
    checkRunId: string,
    position: number,
    result: { state: CheckState; exitCode?: number; durationMs: number },
  ): CheckRun
  recordCheckChangeKey(checkRunId: string, position: number, key: string): void
  checkReportMissing(
    checkRunId: string,
    position: number,
    missing: { reason: string; durationMs: number },
  ): CheckRun
  awaitedReport(
    checkRunId: string,
  ): { position: number; reason: string; durationMs: number } | undefined
  passedChangeKey(taskId: string, name: string): string | undefined
  finishChecks(checkRunId: string, outcome: CheckRunOutcome): CheckRun
  getCheckRun(id: string): CheckRun | undefined
  listCheckRuns(taskId?: string): CheckRun[]
  resetSendBacks(taskId: string, stage: StageId): void
  sendBackCount(taskId: string, stage: StageId): number
  chooseReviewer(reviewer: Omit<Reviewer, 'at'>): Reviewer
  reviewerOf(runId: string): Reviewer | undefined
  reviewers(taskId: string): Reviewer[]
  recordReviewScope(scope: Omit<ReviewScope, 'at'>): ReviewScope
  reviewScopes(taskId: string): ReviewScope[]
  judgeValidate(input: {
    taskId: string
    outcome: 'passed' | 'sent-back'
    checkRunId?: string
    review?: { passed: boolean; notes?: number }
    visual?: { passed: boolean; notes?: number }
    reviewer?: { agent: AgentKind; unavailable?: AgentKind }
  }): void
  startLoopCheck(check: Omit<LoopCheck, 'at' | 'verdict'>): LoopCheck
  finishLoopCheck(runId: string, verdict: LoopVerdict, reason: string): void
  loopChecks(taskId?: string): LoopCheck[]
  askAboutSendBack(ask: Omit<SendBackAsk, 'at'>): SendBackAsk
  sendBackAsk(commentId: string): SendBackAsk | undefined
  sendBackAsks(taskId: string): SendBackAsk[]
  setTaskChecking(taskId: string, on: boolean): void
  setTaskMovingAfterChecks(taskId: string, on: boolean): void
  setChecksWaiting(places: ReadonlyMap<string, number>): void
  testInvocations: TestInvocationStore
  failures: FailureStore
  invalidateFailure(value: FailureCase, note: { title: string; body: string }): void
  postFailureDecision(
    value: FailureCase,
    body: string,
    acceptRefused?: AcceptRefusal,
    askedBy?: string,
    closable?: boolean,
  ): FailureCase
  resolveFailure(
    value: FailureCase,
    commentId: string,
    answer: CommentAnswer,
    drafts: readonly string[],
  ): FailureCase
  approveRepair(
    approval: RepairApproval,
    repair: Pick<Task, 'id' | 'displayId' | 'title'>,
  ): FailureCase
}

export function checksArea(ctx: StoreContext): ChecksArea {
  const {
    storeState,
    store,
    checkingTasks,
    movingAfterChecks,
    commit,
    toTask,
    lineCommentsSent,
    checkRunRows,
    checkResultRows,
    toCheckRun,
    conflictFound,
    taskRow,
    emit,
    requireComment,
    commentPosted,
    emitComment,
    updatedTask,
    updatedQueue,
    noteActivity,
    testInvocationStore,
    failureStore,
    repairApproved,
  } = ctx
  const toReviewer = ({ unavailable, ...row }: typeof reviewers.Type): Reviewer => ({
    ...row,
    stage: row.stage as StageId,
    purpose: row.purpose as ReviewerPurpose,
    agent: row.agent as AgentKind,
    ...(unavailable !== null && { unavailable: unavailable as AgentKind }),
  })

  const toLoopCheck = ({
    toStage,
    checkRunId,
    limit,
    verdict,
    cause,
    ...row
  }: typeof loopChecks.Type): LoopCheck => ({
    ...row,
    to: toStage as AgentStageId,
    ...(checkRunId !== null && { checkRunId }),
    ...(limit !== null && { limit }),
    ...(verdict !== null && { verdict: verdict as LoopVerdict }),
    ...declaredCause(cause),
  })

  const toSendBackAsk = ({
    fromStage,
    toStage,
    checkRunId,
    cause,
    ...row
  }: typeof sendBackAsks.Type): SendBackAsk => ({
    ...row,
    from: fromStage as AgentStageId,
    to: toStage as AgentStageId,
    ...(checkRunId !== null && { checkRunId }),
    ...declaredCause(cause),
  })

  const plannedRow = (check: PlannedCheck) => ({
    name: check.name,
    repo: check.repo ?? null,
    command: check.command ?? null,
    timeout: check.timeout,
    builtIn: check.builtIn ?? null,
    state: check.state,
    instruction: check.instruction ?? null,
    fix: check.fix ?? null,
    agent: check.agent ?? null,
    model: check.model ?? null,
    effort: check.effort ?? null,
    notRerun: check.notRerun ?? null,
  })

  const requireCheckRun = (id: string) => {
    const row = store.query(queryDb(checkRuns.where({ id }))).at(0)
    if (!row) throw new Error(`no check run ${id}`)
    return toCheckRun(row)
  }
  const updatedCheckRun = (id: string): CheckRun => {
    const checkRun = requireCheckRun(id)
    emit({ type: 'check-run-updated', checkRun })
    noteActivity()
    updatedTask(checkRun.taskId)
    return checkRun
  }

  const toSendBack = (row: typeof sendBacks.Type): SendBack => ({
    id: row.id,
    taskId: row.taskId,
    from: row.fromStage as StageId,
    to: row.toStage as StageId,
    findings: row.findings,
    counted: row.counted,
    ...(row.round !== null && { round: row.round }),
    ...(row.limit !== null && { limit: row.limit }),
    ...(row.checkRunId !== null && { checkRunId: row.checkRunId }),
    ...(row.cause !== null && { cause: row.cause as SendBackCause }),
    at: row.at,
  })

  return {
    testInvocations: testInvocationStore,
    failures: failureStore,
    invalidateFailure(value, note) {
      const { id, event, attached } = commentPosted(
        {
          taskId: value.taskId,
          kind: 'note',
          author: { kind: 'ted' },
          ...note,
        },
        new Date().toISOString(),
      )
      commit(failureStore.event(value, 'invalidated'), event, ...attached)
      emit({ type: 'comment-posted', comment: requireComment(id) })
      updatedTask(value.taskId)
    },
    approveRepair(approval, repair) {
      const { next, events: repairEvents } = repairApproved(approval, repair)
      commit(...repairEvents)
      emitComment(approval.request.requestId)
      updatedTask(approval.failure.taskId)
      updatedQueue(approval.failure.taskId)
      return next
    },
    postFailureDecision(value, body, acceptRefused, askedBy, closable = false) {
      const at = new Date().toISOString()
      const assessment = value.assessments.at(-1)
      if (!assessment) throw new Error('a failure decision needs an assessment')
      const stage = taskRow(value.taskId)?.stage ?? ''
      const repairOffered = validates(stage) || mergesHere(stage)
      const namedRow = assessment.repairTask ? taskRow(assessment.repairTask) : undefined
      const named =
        repairOffered &&
        namedRow &&
        namedRow.factoryId === taskRow(value.taskId)?.factoryId &&
        namedRow.archivedAt === null &&
        namedRow.stage !== 'done'
          ? toTask(namedRow)
          : undefined
      const repairTask = named && {
        id: named.id,
        displayId: named.displayId,
        title: named.title,
      }
      const { id, event, attached } = commentPosted(
        {
          taskId: value.taskId,
          kind: 'question',
          body,
          ...(value.validation && {
            title: `How should we handle the ${value.originalCheck?.name ?? (value.source.kind === 'github-ci' ? 'CI' : 'validation')} failure?`,
          }),
          choices: offeredFailureChoices(value, stage, !acceptRefused, closable).flatMap(
            (choice) =>
              choice === 'repair' && repairTask
                ? [namedRepairChoice(repairTask.displayId), failureChoiceLabels[choice]]
                : [failureChoiceLabels[choice]],
          ),
          purpose: { kind: 'failure' },
          author: { kind: 'ted' },
        },
        at,
        askedBy,
      )
      const next = {
        ...value,
        decisions: [
          ...value.decisions,
          {
            commentId: id,
            assessmentId: assessment.id,
            ...(assessment.contextId && { contextId: assessment.contextId }),
            ...(repairTask && { repairTask }),
            ...(acceptRefused && { acceptRefused }),
          },
        ],
      }
      commit(event, ...attached, failureStore.event(next, 'requested'))
      const comment = requireComment(id)
      if (!comment.held) emit({ type: 'comment-posted', comment })
      updatedTask(value.taskId)
      return next
    },
    resolveFailure(value, commentId, answer, drafts) {
      commit(
        failureStore.event(value, 'resolved'),
        events.commentAnswered({ id: commentId, answer: JSON.stringify(answer), at: answer.at }),
        ...lineCommentsSent(drafts, commentId, answer.at),
      )
      emitComment(commentId)
      updatedTask(value.taskId)
      if (drafts.length > 0) emit({ type: 'line-comments-changed', taskId: value.taskId })
      return value
    },
    recordSendBack({
      taskId,
      from,
      to,
      findings,
      counted,
      round,
      limit,
      checkRunId,
      cause,
      conflict,
    }) {
      const id = randomUUID()
      const at = new Date().toISOString()
      commit(
        events.taskSentBackV2({
          id,
          taskId,
          from,
          to,
          findings,
          counted,
          round: round ?? null,
          limit: limit ?? null,
          checkRunId: checkRunId ?? null,
          at,
        }),
        ...(cause === undefined
          ? []
          : [events.sendBackCauseRecorded({ sendBackId: id, taskId, cause, at })]),
        ...(conflict === undefined ? [] : [conflictFound(taskId, conflict, at, id)]),
      )
      const row = store.query(queryDb(sendBacks.where({ id }))).at(0)
      if (!row) throw new Error(`no send-back ${id}`)
      const sendBack = toSendBack(row)
      emit({ type: 'sent-back', sendBack })
      return sendBack
    },
    listSendBacks(taskId) {
      const declared = store.query(
        queryDb(severityDeclarations.where({ taskId }).orderBy('at', 'asc')),
      )
      const backs = store
        .query(queryDb(sendBacks.where({ taskId }).orderBy('at', 'asc')))
        .map(toSendBack)
      const severities = sendBackSeverities(backs, declared)
      return backs.map((sendBack, index) => {
        const severity = severities[index]
        return severity && severity !== 'none' ? { ...sendBack, severity } : sendBack
      })
    },
    declareSeverity(input) {
      commit(
        events.sendBackSeverityDeclared({
          ...input,
          id: randomUUID(),
          at: new Date().toISOString(),
        }),
      )
    },
    recordP1OnlyReview(input) {
      commit(events.p1OnlyReviewRecorded({ ...input, at: new Date().toISOString() }))
    },
    p1OnlyReview: (runId) => store.query(queryDb(p1OnlyReviews.where({ runId }))).length > 0,
    startChecks({ taskId, trigger, stage, checks }) {
      const id = randomUUID()
      commit(
        events.checksStartedWithInstructions({
          id,
          taskId,
          trigger,
          stage,
          checks: checks.map(plannedRow),
          at: new Date().toISOString(),
        }),
      )
      return updatedCheckRun(id)
    },
    replanChecks(checkRunId, from, checks) {
      const run = requireCheckRun(checkRunId)
      commit(
        events.checksReplanned({
          taskId: run.taskId,
          checkRunId,
          from,
          checks: checks.map(plannedRow),
          at: new Date().toISOString(),
        }),
      )
      return updatedCheckRun(checkRunId)
    },
    checkSlotBoundary(checkRunId, boundary, at) {
      const run = requireCheckRun(checkRunId)
      const event = {
        entered: events.checkSlotEntered,
        acquired: events.checkSlotAcquired,
        canceled: events.checkSlotCanceled,
        interrupted: events.checkSlotInterrupted,
        recovered: events.checkSlotRecoveryRecorded,
      }[boundary]
      commit(event({ taskId: run.taskId, checkRunId, stage: run.stage, trigger: run.trigger, at }))
      updatedCheckRun(checkRunId)
    },
    checkTiming(id) {
      const row = store.query(queryDb(checkRuns.where({ id }))).at(0)
      return row && toCheckRun(row).timing
    },
    listCheckTimings(taskId) {
      return checkRunRows(taskId).map((row) => toCheckRun(row).timing as CheckRunTiming)
    },
    checkInterrupted(checkRunId, position) {
      const run = requireCheckRun(checkRunId)
      commit(
        events.checkExecutionInterrupted({
          taskId: run.taskId,
          checkRunId,
          position,
          at: new Date().toISOString(),
        }),
      )
      updatedCheckRun(checkRunId)
    },
    checkKilledForMemory(checkRunId, position, { lowestMemory, durationMs }) {
      const run = requireCheckRun(checkRunId)
      const check = run.checks[position]
      if (!check) throw new Error(`Check run ${checkRunId} has no check ${position}`)
      commit(
        events.checkKilledForMemory({
          taskId: run.taskId,
          checkRunId,
          position,
          name: checkLabel(check),
          stage: run.stage,
          lowestMemory,
          durationMs,
          at: new Date().toISOString(),
        }),
      )
      return updatedCheckRun(checkRunId)
    },
    checkStarted(checkRunId, position) {
      commit(events.checkStarted({ checkRunId, position, at: new Date().toISOString() }))
      return updatedCheckRun(checkRunId)
    },
    checkFinished(checkRunId, position, { state, exitCode, durationMs }) {
      commit(
        events.checkFinished({
          checkRunId,
          position,
          state,
          exitCode: exitCode ?? null,
          durationMs,
          at: new Date().toISOString(),
        }),
      )
      return updatedCheckRun(checkRunId)
    },
    recordCheckChangeKey(checkRunId, position, key) {
      commit(
        events.checkChangeKeyRecorded({ checkRunId, position, key, at: new Date().toISOString() }),
      )
    },
    checkReportMissing(checkRunId, position, { reason, durationMs }) {
      const run = requireCheckRun(checkRunId)
      commit(
        events.checkReportMissing({
          taskId: run.taskId,
          checkRunId,
          position,
          reason,
          durationMs,
          at: new Date().toISOString(),
        }),
      )
      return updatedCheckRun(checkRunId)
    },
    awaitedReport(checkRunId) {
      const started = new Set(
        store
          .query(queryDb(checkBoundaries.where({ checkRunId, kind: 'start' })))
          .map((boundary) => boundary.position),
      )
      const row = checkResultRows(checkRunId).find(
        (result) =>
          result.noReport !== null && result.state === 'running' && !started.has(result.position),
      )
      if (!row || row.noReport === null) return undefined
      return { position: row.position, reason: row.noReport, durationMs: row.noReportMs ?? 0 }
    },
    passedChangeKey(taskId, name) {
      for (const row of [...checkRunRows(taskId)].reverse()) {
        const found = checkResultRows(row.id).find(
          (result) =>
            result.name === name &&
            result.instruction !== null &&
            result.state === 'passed' &&
            result.changeKey !== null,
        )
        if (found?.changeKey) return found.changeKey
      }
      return undefined
    },
    finishChecks(checkRunId, outcome) {
      commit(events.checksFinished({ checkRunId, outcome, at: new Date().toISOString() }))
      return updatedCheckRun(checkRunId)
    },
    getCheckRun(id) {
      const row = store.query(queryDb(checkRuns.where({ id }))).at(0)
      return row && toCheckRun(row)
    },
    listCheckRuns: (taskId) => checkRunRows(taskId).map(toCheckRun),
    resetSendBacks(taskId, stage) {
      commit(
        events.sendBackCountReset({
          id: randomUUID(),
          taskId,
          stage,
          at: new Date().toISOString(),
        }),
      )
      if (taskRow(taskId)) updatedTask(taskId)
    },
    sendBackCount(taskId, stage) {
      const since = store
        .query(queryDb(sendBackResets.where({ taskId, stage }).orderBy('at', 'asc')))
        .at(-1)?.at
      return store
        .query(queryDb(sendBacks.where({ taskId, fromStage: stage, counted: true })))
        .filter((row) => since === undefined || row.at > since).length
    },
    chooseReviewer({ unavailable, ...reviewer }) {
      const at = new Date().toISOString()
      commit(events.reviewerChosen({ ...reviewer, unavailable: unavailable ?? null, at }))
      return { ...reviewer, ...(unavailable !== undefined && { unavailable }), at }
    },
    reviewerOf: (runId) => {
      const row = store.query(queryDb(reviewers.where({ runId }))).at(0)
      return row && toReviewer(row)
    },
    reviewers: (taskId) =>
      store.query(queryDb(reviewers.where({ taskId }).orderBy('at', 'asc'))).map(toReviewer),
    recordReviewScope({ since, ...scope }) {
      const at = new Date().toISOString()
      commit(events.reviewScopeRecorded({ ...scope, since: since ?? null, at }))
      return { ...scope, ...(since !== undefined && { since }), at }
    },
    reviewScopes: (taskId) =>
      store
        .query(queryDb(reviewScopes.where({ taskId }).orderBy('at', 'asc')))
        .map(({ commits, since, ...row }) => ({
          ...row,
          scope: row.scope as ReviewScope['scope'],
          commits: JSON.parse(commits) as RepoCommit[],
          ...(since !== null && { since: JSON.parse(since) as RepoCommit[] }),
        })),
    judgeValidate({ taskId, outcome, checkRunId, review, visual, reviewer }) {
      const judged = (j: { passed: boolean; notes?: number } | undefined) =>
        j === undefined ? null : { passed: j.passed, notes: j.notes ?? null }
      commit(
        events.validateJudgedV2({
          id: randomUUID(),
          taskId,
          outcome,
          checkRunId: checkRunId ?? null,
          validation:
            outcome === 'passed'
              ? JSON.stringify({
                  progress: failureStore.progress(taskId),
                  failures: failureStore.list(taskId).filter((failure) => failure.validation),
                })
              : null,
          review: judged(review),
          visual: judged(visual),
          reviewer:
            reviewer === undefined
              ? null
              : { agent: reviewer.agent, unavailable: reviewer.unavailable ?? null },
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    startLoopCheck({ checkRunId, limit, cause, ...check }) {
      const at = new Date().toISOString()
      commit(
        events.loopCheckStartedV2({
          ...check,
          checkRunId: checkRunId ?? null,
          limit: limit ?? null,
          cause: cause ?? null,
          at,
        }),
      )
      updatedTask(check.taskId)
      return {
        ...check,
        ...(checkRunId !== undefined && { checkRunId }),
        ...(limit !== undefined && { limit }),
        ...(cause !== undefined && { cause }),
        at,
      }
    },
    finishLoopCheck(runId, verdict, reason) {
      const row = store.query(queryDb(loopChecks.where({ runId }))).at(0)
      if (!row || row.verdict !== null) return
      commit(
        events.loopCheckFinished({
          runId,
          taskId: row.taskId,
          verdict,
          reason,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(row.taskId)
    },
    loopChecks: (taskId) =>
      store
        .query(
          queryDb(
            (taskId === undefined ? loopChecks : loopChecks.where({ taskId })).orderBy('at', 'asc'),
          ),
        )
        .map(toLoopCheck),
    askAboutSendBack({ checkRunId, cause, ...ask }) {
      const at = new Date().toISOString()
      commit(
        events.sendBackAskedV2({
          ...ask,
          checkRunId: checkRunId ?? null,
          cause: cause ?? null,
          at,
        }),
        events.commentPurposeRecorded({
          commentId: ask.commentId,
          purpose: JSON.stringify({ kind: 'send-back' }),
        }),
      )
      return {
        ...ask,
        ...(checkRunId !== undefined && { checkRunId }),
        ...(cause !== undefined && { cause }),
        at,
      }
    },
    sendBackAsk: (commentId) => {
      const row = store.query(queryDb(sendBackAsks.where({ commentId }))).at(0)
      return row && toSendBackAsk(row)
    },
    sendBackAsks: (taskId) =>
      store.query(queryDb(sendBackAsks.where({ taskId }).orderBy('at', 'asc'))).map(toSendBackAsk),
    setTaskMovingAfterChecks(taskId, on) {
      if (movingAfterChecks.has(taskId) === on) return
      storeState.stateCommits += 1
      if (on) {
        if (!taskRow(taskId)) return
        movingAfterChecks.add(taskId)
      } else movingAfterChecks.delete(taskId)
      if (taskRow(taskId)) updatedTask(taskId)
    },
    setTaskChecking(taskId, on) {
      if (checkingTasks.has(taskId) === on) return
      storeState.stateCommits += 1
      if (on) {
        if (!taskRow(taskId)) return
        checkingTasks.add(taskId)
      } else checkingTasks.delete(taskId)
      if (taskRow(taskId)) updatedTask(taskId)
      noteActivity()
    },
    setChecksWaiting(places) {
      const before = storeState.checksWaiting
      storeState.stateCommits += 1
      storeState.checksWaiting = new Map([...places].filter(([taskId]) => taskRow(taskId)))
      for (const taskId of new Set([...before.keys(), ...storeState.checksWaiting.keys()])) {
        if (before.get(taskId) === storeState.checksWaiting.get(taskId) || !taskRow(taskId))
          continue
        const unfinished = checkRunRows(taskId).find((r) => r.finishedAt === null)
        if (unfinished) updatedCheckRun(unfinished.id)
        else updatedTask(taskId)
      }
      noteActivity()
    },
  }
}
