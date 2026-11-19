import { randomUUID } from 'node:crypto'
import { queryDb } from '@livestore/livestore'
import type {
  AgentStageId,
  BaseConflictFound,
  CiSignal,
  CleanupStepReport,
  CleanupStepResult,
  CopySkip,
  GitHubWait,
  MergeMethod,
  PullRequestPreview,
  ReportCleanupStepRequest,
  StageId,
  Task,
  TaskRepo,
  WorktreeCommandOutcome,
} from '@ted/protocol'
import { mergesHere } from '@ted/protocol/stage'
import type { OvernightGuard } from '../workflow/resolve.ts'
import type { StoreContext } from './context.ts'
import { baseConflicts, cleanupReports, events, taskRepos } from './schema.ts'
import type { CleanupCommandResult, FoundConflict, RecordedSetup } from './types.ts'

export interface MergeArea {
  setTaskRepos(
    taskId: string,
    input: { repos: string[]; names: string[]; by: 'human' | 'task-lead'; runId?: string },
  ): Task
  worktreeSetupStarted(taskId: string, name: string, setup: RecordedSetup): void
  recordedSetup(taskId: string, name: string): RecordedSetup | undefined
  worktreeSetupFinished(
    taskId: string,
    name: string,
    result: { outcome: WorktreeCommandOutcome; exitCode?: number },
  ): void
  worktreeRemoved(
    taskId: string,
    name: string,
    teardown?: { command: string; outcome: WorktreeCommandOutcome },
  ): void
  branchPushed(
    taskId: string,
    name: string,
    push: { commit: string; ci: boolean; ciSignals: CiSignal[] },
  ): void
  branchPushFailed(taskId: string, name: string, message: string): void
  pushRecordReconciled(
    taskId: string,
    name: string,
    found: { recorded: string; remote: string },
  ): void
  pullRequestOpened(
    taskId: string,
    name: string,
    pullRequest: { number: number; url: string; base: string },
  ): void
  pullRequestMarkedReady(taskId: string, name: string): void
  pullRequestClosed(taskId: string, name: string): void
  pullRequestReopened(taskId: string, name: string, state: 'draft' | 'ready'): void
  pullRequestClosedOnGitHub(taskId: string, name: string): void
  pullRequestPreviewFound(taskId: string, name: string, preview: PullRequestPreview): void
  worktreeCreated(
    taskId: string,
    repo: {
      name: string
      repo: string
      branch: string
      worktree: string
      copied: string[]
      skipped: CopySkip[]
    },
  ): void
  pullRequestWaiting(taskId: string, name: string, on: GitHubWait | undefined): void
  autoMergeEnabled(
    taskId: string,
    name: string,
    input: { method: MergeMethod; requested: MergeMethod },
  ): void
  pullRequestMerged(
    taskId: string,
    name: string,
    input: { method?: MergeMethod; requested?: MergeMethod; noCi: boolean; byTed: boolean },
  ): void
  branchRebased(taskId: string, name: string, input: { commit: string; onto: string }): void
  mergeStoppedPartway(taskId: string, input: { merged: string[]; open: string[] }): void
  pullRequestSignedOff(taskId: string, name: string, commit: string | undefined): void
  autoMergeDisabled(taskId: string, name: string): void
  mergeStarted(taskId: string): void
  mergeLeadAdvanced(taskId: string, by: 'lead' | 'human'): void
  pullRequestTitleSet(taskId: string, input: { title: string; body?: string }): void
  gateSkippedOvernight(taskId: string, stage: AgentStageId): void
  gateApprovalBound(taskId: string, commentId: string, name: string, commit: string): void
  gateRequestedFor(taskId: string, commentId: string, name: string, commit: string): void
  mergeCommitChosen(taskId: string, name: string, commit: string | undefined): void
  gateKeptOvernight(taskId: string, stage: AgentStageId, reason: OvernightGuard): void
  mergeCanceled(taskId: string, commentId: string): void
  taskMarkedDone(taskId: string, by: 'human' | 'lead' | 'coordinator'): void
  mergePending(taskId: string): boolean
  isMerged(taskId: string): boolean
  recordBaseConflict(taskId: string, conflict: FoundConflict): BaseConflictFound
  baseConflicts(taskId?: string): BaseConflictFound[]
  reportCleanupStep(taskId: string, runId: string, report: ReportCleanupStepRequest): void
  cleanupReports(taskId: string): CleanupStepReport[]
  recordCleanupCommand(taskId: string, result: CleanupCommandResult): void
  retryCleanup(taskId: string, steps: readonly string[]): void
  finishCleanupAnyway(taskId: string, steps: readonly string[]): void
  baseAdopted(
    taskId: string,
    moved: readonly { repo: string; base: string; from: string; to: string }[],
  ): void
  baseMerged(
    taskId: string,
    merged: readonly { repo: string; base: string; from: string; to: string; commit: string }[],
  ): void
  taskPullRequestUrls(taskId: string): string[]
  setMergeHeld(taskId: string, why: string | undefined): void
  mergeHeld(taskId: string): string | undefined
}

export function mergeArea(ctx: StoreContext): MergeArea {
  const {
    storeState,
    store,
    heldMerges,
    commit,
    reposOf,
    history,
    isMerged,
    conflictFound,
    taskRow,
    updatedTask,
  } = ctx
  const mergePendingFor = (taskId: string, repos: readonly TaskRepo[]): boolean =>
    repos.some((r) => !r.removed && r.pullRequest && r.pullRequest.state !== 'merged') &&
    history.mergeHistory(taskId).latest === 'started'

  const toBaseConflict = ({
    files,
    sendBackId,
    ...row
  }: typeof baseConflicts.Type): BaseConflictFound => ({
    ...row,
    stage: row.stage as StageId,
    files: JSON.parse(files) as string[],
    ...(sendBackId !== null && { sendBackId }),
  })

  return {
    setTaskRepos(taskId, { repos, names, by, runId }) {
      commit(
        events.taskReposSet({
          taskId,
          repos,
          names,
          by,
          runId: runId ?? null,
          at: new Date().toISOString(),
        }),
      )
      return updatedTask(taskId)
    },
    worktreeSetupStarted(taskId, name, { command, timeoutMs, env }) {
      commit(
        events.taskWorktreeSetupStarted({
          taskId,
          name,
          command,
          timeoutMs,
          env: JSON.stringify(env),
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    recordedSetup(taskId, name) {
      const row = store.query(queryDb(taskRepos.where({ id: `${taskId}:${name}` }))).at(0)
      if (!row?.setupCommand || row.setupTimeoutMs === null || row.setupEnv === null)
        return undefined
      return {
        command: row.setupCommand,
        timeoutMs: row.setupTimeoutMs,
        env: JSON.parse(row.setupEnv) as Record<string, string>,
      }
    },
    worktreeSetupFinished(taskId, name, { outcome, exitCode }) {
      commit(
        events.taskWorktreeSetupFinished({
          taskId,
          name,
          outcome,
          exitCode: exitCode ?? null,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    worktreeRemoved(taskId, name, teardown) {
      commit(
        events.taskWorktreeRemoved({
          taskId,
          name,
          teardownCommand: teardown?.command ?? null,
          teardownOutcome: teardown?.outcome ?? null,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    branchPushed(taskId, name, { commit: pushed, ci, ciSignals }) {
      commit(
        events.taskBranchPushed({
          taskId,
          name,
          commit: pushed,
          ci,
          ciSignals,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    branchPushFailed(taskId, name, message) {
      commit(events.taskBranchPushFailed({ taskId, name, message, at: new Date().toISOString() }))
      updatedTask(taskId)
    },
    pushRecordReconciled(taskId, name, { recorded, remote }) {
      commit(
        events.taskPushRecordReconciled({
          taskId,
          name,
          recorded,
          remote,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    pullRequestOpened(taskId, name, { number, url, base }) {
      commit(
        events.pullRequestOpened({
          taskId,
          name,
          number,
          url,
          base,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    pullRequestMarkedReady(taskId, name) {
      commit(events.pullRequestMarkedReady({ taskId, name, at: new Date().toISOString() }))
      updatedTask(taskId)
    },
    pullRequestClosed(taskId, name) {
      commit(events.pullRequestClosed({ taskId, name, at: new Date().toISOString() }))
      updatedTask(taskId)
    },
    pullRequestReopened(taskId, name, state) {
      commit(events.pullRequestReopenedV2({ taskId, name, state, at: new Date().toISOString() }))
      updatedTask(taskId)
    },
    pullRequestClosedOnGitHub(taskId, name) {
      commit(events.pullRequestClosedOnGitHub({ taskId, name, at: new Date().toISOString() }))
      updatedTask(taskId)
    },
    pullRequestPreviewFound(taskId, name, preview) {
      commit(
        events.pullRequestPreviewFound({ taskId, name, ...preview, at: new Date().toISOString() }),
      )
      updatedTask(taskId)
    },
    worktreeCreated(taskId, repo) {
      commit(events.taskWorktreeCreated({ taskId, ...repo, at: new Date().toISOString() }))
      updatedTask(taskId)
    },
    pullRequestWaiting(taskId, name, on) {
      commit(
        events.pullRequestWaitChanged({
          taskId,
          name,
          on: on ?? null,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    autoMergeEnabled(taskId, name, { method, requested }) {
      commit(
        events.pullRequestAutoMergeEnabled({
          taskId,
          name,
          method,
          requested,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    pullRequestMerged(taskId, name, { method, requested, noCi, byTed }) {
      commit(
        events.pullRequestMerged({
          taskId,
          name,
          method: method ?? null,
          requested: requested ?? null,
          noCi,
          byTed,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    branchRebased(taskId, name, { commit: rebased, onto }) {
      commit(
        events.taskBranchRebased({
          taskId,
          name,
          commit: rebased,
          onto,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    mergeStoppedPartway(taskId, { merged, open }) {
      commit(events.mergeStoppedPartway({ taskId, merged, open, at: new Date().toISOString() }))
      updatedTask(taskId)
    },
    isMerged: (taskId) => isMerged(taskId),
    autoMergeDisabled(taskId, name) {
      commit(events.pullRequestAutoMergeDisabled({ taskId, name, at: new Date().toISOString() }))
      updatedTask(taskId)
    },
    mergeStarted(taskId) {
      commit(events.mergeStarted({ taskId, at: new Date().toISOString() }))
      updatedTask(taskId)
    },
    pullRequestTitleSet(taskId, { title, body }) {
      commit(
        events.pullRequestTitleSet({
          taskId,
          title,
          body: body ?? '',
          at: new Date().toISOString(),
        }),
      )
    },
    mergeLeadAdvanced(taskId, by) {
      commit(events.mergeLeadAdvanced({ taskId, by, at: new Date().toISOString() }))
      updatedTask(taskId)
    },
    gateKeptOvernight(taskId, stage, reason) {
      commit(events.gateKeptOvernight({ taskId, stage, reason, at: new Date().toISOString() }))
      updatedTask(taskId)
    },
    gateRequestedFor(taskId, commentId, name, requested) {
      commit(
        events.gateRequestedFor({
          taskId,
          commentId,
          name,
          commit: requested,
          at: new Date().toISOString(),
        }),
      )
    },
    mergeCommitChosen(taskId, name, chosen) {
      commit(
        events.mergeCommitChosen({
          taskId,
          name,
          commit: chosen ?? null,
          at: new Date().toISOString(),
        }),
      )
    },
    gateApprovalBound(taskId, commentId, name, approved) {
      commit(
        events.gateApprovalBound({
          taskId,
          commentId,
          name,
          commit: approved,
          at: new Date().toISOString(),
        }),
      )
    },
    gateSkippedOvernight(taskId, stage) {
      commit(events.gateSkippedOvernight({ taskId, stage, at: new Date().toISOString() }))
      updatedTask(taskId)
    },
    mergeCanceled(taskId, commentId) {
      commit(events.mergeCanceled({ taskId, commentId, at: new Date().toISOString() }))
      updatedTask(taskId)
    },
    taskMarkedDone(taskId, by) {
      commit(events.taskMarkedDoneBy({ taskId, by, at: new Date().toISOString() }))
      updatedTask(taskId)
    },
    mergePending(taskId) {
      const task = taskRow(taskId)
      return mergesHere(task?.stage ?? '') && mergePendingFor(taskId, reposOf(taskId))
    },
    pullRequestSignedOff(taskId, name, signedOff) {
      commit(
        events.pullRequestSignedOff({
          taskId,
          name,
          commit: signedOff ?? null,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    recordBaseConflict(taskId, conflict) {
      const event = conflictFound(taskId, conflict, new Date().toISOString(), null)
      commit(event)
      const row = store.query(queryDb(baseConflicts.where({ id: event.args.id }))).at(0)
      if (!row) throw new Error(`no base conflict ${event.args.id}`)
      return toBaseConflict(row)
    },
    baseConflicts: (taskId) =>
      store
        .query(
          queryDb(
            (taskId === undefined ? baseConflicts : baseConflicts.where({ taskId })).orderBy(
              'at',
              'asc',
            ),
          ),
        )
        .map(toBaseConflict),
    reportCleanupStep(taskId, runId, { step, result, text }) {
      commit(
        events.cleanupStepReported({
          id: randomUUID(),
          taskId,
          step,
          result,
          text,
          runId,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    cleanupReports: (taskId) => {
      const latest = new Map<string, CleanupStepReport>()
      for (const row of store.query(
        queryDb(cleanupReports.where({ taskId }).orderBy('at', 'asc')),
      )) {
        latest.set(row.step, {
          step: row.step,
          result: row.result as CleanupStepResult,
          text: row.text,
          runId: row.runId,
          at: row.at,
        })
      }
      return [...latest.values()]
    },
    recordCleanupCommand(taskId, result) {
      commit(
        events.cleanupCommandRan({
          id: randomUUID(),
          taskId,
          step: result.step,
          state: result.state,
          exitCode: result.exitCode ?? null,
          timeout: result.timeout,
          durationMs: result.durationMs,
          output: result.output,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    retryCleanup(taskId, steps) {
      commit(events.cleanupRetried({ taskId, steps: [...steps], at: new Date().toISOString() }))
      updatedTask(taskId)
    },
    finishCleanupAnyway(taskId, steps) {
      commit(
        events.cleanupFinishedAnyway({ taskId, steps: [...steps], at: new Date().toISOString() }),
      )
    },
    baseAdopted(taskId, moved) {
      if (moved.length === 0) return
      const at = new Date().toISOString()
      commit(...moved.map((row) => events.baseBranchAdopted({ taskId, ...row, at })))
      updatedTask(taskId)
    },
    baseMerged(taskId, merged) {
      if (merged.length === 0) return
      const at = new Date().toISOString()
      commit(...merged.map((row) => events.baseBranchMerged({ taskId, ...row, at })))
      updatedTask(taskId)
    },
    taskPullRequestUrls: (taskId) =>
      reposOf(taskId).flatMap((repo) =>
        repo.pullRequest && !repo.removed ? [repo.pullRequest.url] : [],
      ),
    setMergeHeld(taskId, why) {
      if (heldMerges.get(taskId) === why) return
      if (why !== undefined && !taskRow(taskId)) return
      storeState.stateCommits += 1
      if (why === undefined) heldMerges.delete(taskId)
      else heldMerges.set(taskId, why)
      if (taskRow(taskId)) updatedTask(taskId)
    },
    mergeHeld: (taskId) => heldMerges.get(taskId),
  }
}
