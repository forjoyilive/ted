import { withIntervalBoundaries } from '../interval-schema.ts'
import { taskLog } from './tasks.ts'

type Logged = { taskId: string | null; at: string; data?: Record<string, unknown> }

type Args = Record<string, unknown>

const str = (value: unknown) => (typeof value === 'string' ? value : null)

export const task = (args: Args, data?: Record<string, unknown>): Logged => ({
  taskId: str(args.taskId),
  at: String(args.at),
  ...(data && { data }),
})

const runStarted = (args: Args): Logged => ({
  taskId: str(args.taskId),
  at: String(args.startedAt),
  data: {
    runId: args.id,
    agent: args.agent,
    model: args.model ?? null,
    effort: args.effort ?? null,
  },
})

export const trackerSyncLog = [
  'v1.LinearIssueSeen',
  'v1.LinearIssueMoved',
  'v1.LinearSyncAllowed',
  'v1.LinearTeamSyncAllowed',
  'v1.LinearPullRequestsLinked',
  'v1.TrackerItemSeen',
  'v1.TrackerItemGroupsSeen',
  'v1.TrackerItemMoved',
  'v1.TrackerSyncAllowed',
  'v1.TrackerSyncDeclined',
  'v1.TrackerGroupSyncAllowed',
  'v1.TrackerPullRequestsLinked',
]

const taskLogEntries: Record<string, (args: Args) => Logged> = {
  'v1.TaskCreated': (args) => ({ taskId: str(args.id), at: String(args.createdAt) }),
  'v1.SetupTaskCreated': (args) => ({ taskId: str(args.taskId), at: String(args.at) }),
  'v2.TaskCreated': (args) => ({
    taskId: str(args.id),
    at: String(args.createdAt),
    data: { clarifyDepth: args.clarifyDepth },
  }),
  'v1.TaskSnoozed': (args) => task(args, { until: args.until }),
  'v1.TaskSnoozeCleared': (args) => task(args),
  'v1.TaskAutopilotChanged': (args) => task(args, { choice: args.choice }),
  'v1.CommentAnsweredByAutopilot': (args) => task(args, { commentId: args.commentId }),
  'v1.TaskGatesChanged': (args) => task(args, { overrides: args.overrides }),
  'v1.TaskEdited': (args) => task(args, { title: args.title, version: args.version }),
  'v1.TaskBlockerAdded': (args) => task(args, { blockerId: args.blockerId, runId: null }),
  'v2.TaskBlockerAdded': (args) => task(args, { blockerId: args.blockerId, runId: args.runId }),
  'v1.TaskBlockerRemoved': (args) => task(args, { blockerId: args.blockerId, runId: args.runId }),
  'v1.TaskWaitingForBlockers': (args) => task(args),
  'v1.TaskRequeuedAfterBlockers': (args) => task(args),
  'v2.TaskRequeuedAfterBlockers': (args) => task(args, { why: args.why }),
  'v1.TaskPreparationChanged': (args) => task(args, { state: args.state }),
  'v1.TaskStopped': (args) => task(args, { runs: args.runs, why: args.why }),
  'v1.TaskResumed': (args) => task(args),
  'v1.TaskResumedOvernight': (args) => task(args),
  'v1.TaskStoppedByTed': (args) => task(args, { runId: args.runId, cause: args.cause }),
  'v1.TedStopAnswered': (args) => task(args, { choice: args.choice }),
  'v1.TaskLeadNudged': (args) => task(args, { runId: args.runId }),
  'v1.CheckKilledForMemory': (args) =>
    task(args, {
      checkRunId: args.checkRunId,
      position: args.position,
      name: args.name,
      stage: args.stage,
      lowestMemory: args.lowestMemory,
    }),
  'v1.RunKilledForMemory': (args) =>
    task(args, { runId: args.runId, lowestMemory: args.lowestMemory }),
  'v1.TaskLeadFailed': (args) =>
    task(args, {
      runId: args.runId,
      reason: args.reason,
      recovery: args.recovery,
      resumeFailed: args.resumeFailed,
    }),
  'v1.TaskRetried': (args) => task(args),
  'v1.RunRevived': (args) => task(args, { runId: args.runId }),
  'v1.TaskQueued': (args) => task(args, { stage: args.stage }),
  'v1.TaskStartCause': (args) => task(args, { cause: args.cause, blockers: args.blockers }),
  'v1.TaskMovedToBacklog': (args) => task(args),
  'v1.TaskArchived': (args) => task(args),
  'v2.TaskArchived': (args) => task(args, { closing: args.closing, branches: args.branches }),
  'v3.TaskArchived': (args) =>
    task(args, { closing: args.closing, branches: args.branches, why: args.why }),
  'v1.LinearIssueSeen': (args) =>
    task(args, {
      identifier: args.identifier,
      stateType: args.stateType,
      state: args.state,
      team: args.team,
    }),
  'v1.LinearSyncAllowed': (args) => task(args, { identifier: args.identifier, by: args.by }),
  'v1.LinearTeamSyncAllowed': (args) =>
    task(args, { identifier: args.identifier, team: args.team }),
  'v1.LinearIssueMoved': (args) =>
    task(args, { identifier: args.identifier, step: args.step, state: args.state }),
  'v1.LinearPullRequestsLinked': (args) =>
    task(args, { identifier: args.identifier, urls: args.urls }),
  'v1.TrackerItemSeen': (args) =>
    task(args, {
      tracker: args.tracker,
      item: args.item,
      closed: args.closed,
      state: args.state,
      group: args.group,
    }),
  'v1.TrackerItemGroupsSeen': (args) =>
    task(args, { tracker: args.tracker, item: args.item, groups: args.groups }),
  'v1.TrackerItemMoved': (args) =>
    task(args, { tracker: args.tracker, item: args.item, step: args.step, state: args.state }),
  'v1.TrackerSyncAllowed': (args) =>
    task(args, { tracker: args.tracker, item: args.item, by: args.by, account: args.account }),
  'v1.TrackerSyncDeclined': (args) => task(args, { tracker: args.tracker, item: args.item }),
  'v1.TrackerGroupSyncAllowed': (args) =>
    task(args, {
      tracker: args.tracker,
      item: args.item,
      group: args.group,
      account: args.account,
    }),
  'v1.TrackerPullRequestsLinked': (args) =>
    task(args, { tracker: args.tracker, item: args.item, urls: args.urls }),
  'v1.TaskUnarchived': (args) => task(args, { queued: args.rank !== null }),
  'v2.TaskUnarchived': (args) =>
    task(args, { queued: args.rank !== null, reblocked: args.reblocked }),
  'v1.TaskReset': (args) => task(args, { clarifyDepth: args.clarifyDepth }),
  'v1.TaskMovedToFactory': (args) =>
    task(args, {
      fromDisplayId: args.fromDisplayId,
      fromFactoryId: args.fromFactoryId,
      factoryId: args.factoryId,
      by: args.by,
      started: args.started,
    }),
  'v1.TaskFollowsUp': (args) => task(args, { originalId: args.originalId }),
  'v1.TaskStartedByAutomation': (args) =>
    task(args, { automationId: args.automationId, firingId: args.firingId, name: args.name }),
  'v1.TaskFollowedUp': (args) => task(args, { followUpId: args.followUpId }),
  'v1.TaskCreatedByTaskLead': (args) =>
    task(args, { creatorId: args.creatorId, runId: args.runId, child: args.child }),
  'v1.TaskLeadCreatedTask': (args) =>
    task(args, { createdId: args.createdId, runId: args.runId, child: args.child }),
  'v1.TaskSplitFrom': (args) => task(args, { originalId: args.originalId }),
  'v1.TaskSplit': (args) => task(args, { pieceIds: args.pieceIds, narrowedTo: args.narrowedTo }),
  'v1.ChildTasksCreated': (args) => task(args, { childIds: args.childIds, from: args.from }),
  'v1.ParentFinishedWithChildren': (args) => task(args),
  'v1.TaskNeedsPlanning': (args) => task(args, { runId: args.runId }),
  'v1.TaskStartedAfterPlanning': (args) => task(args, { stage: args.stage }),
  'v1.PlanStartedFromTask': (args) => task(args, { planId: args.id }),
  'v1.TaskPlanEnded': (args) => task(args, { planId: args.planId, outcome: args.outcome }),
  'v1.TaskStageEntered': (args) => task(args, { stage: args.stage }),
  'v2.TaskStageEntered': (args) => task(args, { stage: args.stage }),
  'v3.TaskStageEntered': (args) => task(args, { stage: args.stage }),
  'v4.TaskStageEntered': (args) => task(args, { stage: args.stage, names: args.names }),
  'v1.TaskSentBack': (args) =>
    task(args, { from: args.from, to: args.to, findings: args.findings }),
  'v2.TaskSentBack': (args) =>
    task(args, {
      from: args.from,
      to: args.to,
      findings: args.findings,
      round: args.round,
      limit: args.limit,
      checkRunId: args.checkRunId,
    }),
  'v1.SendBackCauseRecorded': (args) => task(args, { cause: args.cause }),
  'v1.CleanupStepReported': (args) =>
    task(args, { step: args.step, result: args.result, text: args.text, runId: args.runId }),
  'v1.CleanupCommandRan': (args) =>
    task(args, {
      step: args.step,
      state: args.state,
      exitCode: args.exitCode,
      timeout: args.timeout,
      durationMs: args.durationMs,
      output: args.output,
    }),
  'v1.CleanupRetried': (args) => task(args, { steps: args.steps }),
  'v1.CleanupFinishedAnyway': (args) => task(args, { steps: args.steps }),
  'v1.BaseConflictFound': (args) =>
    task(args, {
      stage: args.stage,
      repo: args.repo,
      base: args.base,
      fileCount: args.fileCount,
      sendBackId: args.sendBackId,
    }),
  'v1.BaseBranchAdopted': (args) => task(args, { repo: args.repo, base: args.base }),
  'v1.BaseBranchMerged': (args) => task(args, { repo: args.repo, base: args.base }),
  'v1.SendBackSeverityDeclared': (args) =>
    task(args, { runId: args.runId, round: args.round, severity: args.severity }),
  'v1.SeverityRuleReviewRecorded': (args) =>
    task(args, { runId: args.runId, round: args.round, from: args.from }),
  'v2.RunStarted': runStarted,
  'v3.RunStarted': runStarted,
  'v4.RunStarted': (args) => {
    const logged = runStarted(args)
    return { ...logged, data: { ...logged.data, parentRunId: args.parentRunId, name: args.name } }
  },
  'v5.RunStarted': (args) => {
    const logged = runStarted(args)
    return { ...logged, data: { ...logged.data, parentRunId: args.parentRunId, name: args.name } }
  },
  'v1.ClarifyDepthSet': (args) =>
    task(args, { depth: args.depth, by: args.by, runId: args.runId, why: args.why }),
  'v1.TaskLeadSet': (args) =>
    task(args, { agent: args.agent, model: args.model, effort: args.effort }),
  'v1.TaskReposSet': (args) =>
    task(args, { repos: args.repos, names: args.names, by: args.by, runId: args.runId }),
  'v1.TaskWorktreeCreated': (args) =>
    task(args, { name: args.name, copied: args.copied, skipped: args.skipped }),
  'v1.TaskWorktreeSetupStarted': (args) => task(args, { name: args.name, command: args.command }),
  'v1.PullRequestMerged': (args) =>
    task(args, {
      name: args.name,
      method: args.method,
      requested: args.requested,
      noCi: args.noCi,
      byTed: args.byTed,
    }),
  'v1.PullRequestAutoMergeEnabled': (args) =>
    task(args, { name: args.name, method: args.method, requested: args.requested }),
  'v1.PullRequestAutoMergeDisabled': (args) => task(args, { name: args.name }),
  'v1.TaskBranchRebased': (args) => task(args, { name: args.name, onto: args.onto }),
  'v1.TaskPushRecordReconciled': (args) =>
    task(args, { name: args.name, recorded: args.recorded, remote: args.remote }),
  'v1.MergeStoppedPartway': (args) => task(args, { merged: args.merged, open: args.open }),
  'v1.PullRequestSignedOff': (args) => task(args, { name: args.name, commit: args.commit }),
  'v1.PullRequestClosedOnGitHub': (args) => task(args, { name: args.name }),
  'v1.GitHubActivitySent': (args) => task(args, { runId: args.runId, notices: args.notices }),
  'v1.GitHubActivityQueued': (args) => task(args, { notices: args.notices }),
  'v1.GitHubActivityHeld': (args) => task(args, { notices: args.notices }),
  'v1.MergeStarted': (args) => task(args),
  'v1.MergeAwaitsLead': (args) => task(args),
  'v1.MergeLeadAdvanced': (args) => task(args, { by: args.by }),
  'v1.PullRequestTitleSet': (args) => task(args, { title: args.title, body: args.body }),
  'v1.GateSkippedOvernight': (args) => task(args, { stage: args.stage }),
  'v1.GateKeptOvernight': (args) => task(args, { stage: args.stage, reason: args.reason }),
  'v1.GateRequestedFor': (args) =>
    task(args, { commentId: args.commentId, name: args.name, commit: args.commit }),
  'v1.GateApprovalBound': (args) =>
    task(args, { commentId: args.commentId, name: args.name, commit: args.commit }),
  'v1.MergeCommitChosen': (args) => task(args, { name: args.name, commit: args.commit }),
  'v1.MergeCanceled': (args) => task(args, { commentId: args.commentId }),
  'v1.TaskMarkedDone': (args) => task(args),
  'v2.TaskMarkedDone': (args) => task(args, { by: args.by }),
  'v1.TaskWorktreeSetupFinished': (args) =>
    task(args, { name: args.name, outcome: args.outcome, exitCode: args.exitCode }),
  'v1.TaskWorktreeRemoved': (args) =>
    task(args, {
      name: args.name,
      teardownCommand: args.teardownCommand,
      teardownOutcome: args.teardownOutcome,
    }),
  'v1.TaskRunHeld': (args) => task(args, { agent: args.agent }),
  'v2.TaskRunHeld': (args) => task(args, { agent: args.agent }),
  'v1.AppStarted': (args) =>
    task(args, {
      repo: args.repo,
      name: args.name,
      port: args.port,
      url: args.url,
      by: args.by,
      runId: args.runId,
      restart: args.restart,
    }),
  'v1.AppStopped': (args) => task(args, { repo: args.repo, name: args.name }),
  'v2.AppStopped': (args) =>
    task(args, { repo: args.repo, name: args.name, by: args.by, runId: args.runId }),
  'v1.AppExited': (args) =>
    task(args, { repo: args.repo, name: args.name, code: args.code, signal: args.signal }),
  'v1.AppStartFailed': (args) =>
    task(args, { repo: args.repo, name: args.name, problem: args.problem }),
  'v1.SimulatorShutDown': (args) =>
    task(args, { repo: args.repo, name: args.name, forTask: args.forTask, idle: args.idle }),
  'v1.EmulatorShutDown': (args) =>
    task(args, { repo: args.repo, name: args.name, forTask: args.forTask, idle: args.idle }),
  'v1.TaskRunReleased': (args) => task(args),
  'v1.RunAutoModeUnavailable': (args) => task(args, { runId: args.runId }),
  'v1.ValidateJudged': (args) =>
    task(args, {
      outcome: args.outcome,
      checkRunId: args.checkRunId,
      review: args.review,
      visual: args.visual,
      reviewer: args.reviewer,
    }),
  'v2.ValidateJudged': (args) =>
    task(args, {
      outcome: args.outcome,
      validation: args.validation,
      checkRunId: args.checkRunId,
      review: args.review,
      visual: args.visual,
      reviewer: args.reviewer,
    }),
  'v1.LoopCheckStarted': (args) => task(args, { runId: args.runId, round: args.round }),
  'v2.LoopCheckStarted': (args) =>
    task(args, { runId: args.runId, round: args.round, cause: args.cause }),
  'v1.SendBackAsked': (args) =>
    task(args, {
      from: args.from,
      to: args.to,
      findings: args.findings,
      checkRunId: args.checkRunId,
    }),
  'v2.SendBackAsked': (args) =>
    task(args, {
      from: args.from,
      to: args.to,
      findings: args.findings,
      checkRunId: args.checkRunId,
      cause: args.cause,
    }),
  'v1.LoopCheckFinished': (args) =>
    task(args, { runId: args.runId, verdict: args.verdict, reason: args.reason }),
  'v1.RunMessageSent': (args) => ({
    taskId: args.lead === true ? str(args.taskId) : null,
    at: String(args.at),
    data: { runId: args.runId, messageId: args.id },
  }),
  'v1.RunMessageDelivered': (args) => ({
    taskId: args.lead === true ? str(args.taskId) : null,
    at: String(args.at),
    data: { runId: args.runId, messageId: args.id },
  }),
}

export function withTaskLog<T extends Record<string, (...args: never[]) => unknown>>(
  handlers: T,
): T {
  return Object.fromEntries(
    Object.entries(withIntervalBoundaries(handlers)).map(([name, handler]) => {
      const entry = taskLogEntries[name]
      if (!entry) return [name, handler]
      const call = handler as (args: Args, context: MaterializerContext) => unknown
      return [
        name,
        (args: Args, context: MaterializerContext) => {
          const result = call(args, context)
          const logged = entry(args)
          if (logged.taskId === null) return result
          const { global, client } = context.event.seqNum
          return [
            ...(Array.isArray(result) ? result : [result]),
            taskLog
              .insert({
                id: `${global}.${client}`,
                taskId: logged.taskId,
                name,
                data: JSON.stringify(logged.data ?? {}),
                at: logged.at,
              })
              .onConflict('id', 'replace'),
          ]
        },
      ]
    }),
  ) as T
}

interface MaterializerContext {
  event: { seqNum: { global: number; client: number } }
}
