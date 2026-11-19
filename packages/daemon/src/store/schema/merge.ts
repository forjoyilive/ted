import { Events, Schema, State } from '@livestore/livestore'
import { comments } from './requests.ts'
import { tasks } from './tasks.ts'

export function cleanupCommandText(
  state: string,
  exitCode: number | null,
  timeout: string,
): string {
  if (state === 'passed') return 'Ted ran the command; it passed'
  if (state === 'timed-out') return `Ted ran the command; it timed out after ${timeout}`
  if (exitCode === 127) return 'Ted ran the command; command not found'
  return `Ted ran the command; it failed${exitCode === null ? '' : ` with exit code ${exitCode}`}`
}

export const baseConflicts = State.SQLite.table({
  name: 'baseConflicts',
  indexes: [{ name: 'idx_baseConflicts_taskId', columns: ['taskId'] }],
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    stage: State.SQLite.text(),
    repo: State.SQLite.text(),
    base: State.SQLite.text(),
    tip: State.SQLite.text(),
    fileCount: State.SQLite.integer(),
    files: State.SQLite.text(),
    sendBackId: State.SQLite.text({ nullable: true }),
    at: State.SQLite.text(),
  },
})

export const cleanupReports = State.SQLite.table({
  name: 'cleanupReports',
  indexes: [{ name: 'idx_cleanupReports_taskId', columns: ['taskId'] }],
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    step: State.SQLite.text(),
    result: State.SQLite.text(),
    text: State.SQLite.text(),
    runId: State.SQLite.text(),
    at: State.SQLite.text(),
  },
})

export const taskRepos = State.SQLite.table({
  name: 'taskRepos',
  indexes: [{ name: 'idx_taskRepos_taskId', columns: ['taskId'] }],
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    name: State.SQLite.text(),
    repo: State.SQLite.text(),
    branch: State.SQLite.text(),
    worktree: State.SQLite.text(),
    copied: State.SQLite.text(),
    skipped: State.SQLite.text(),
    setupCommand: State.SQLite.text({ nullable: true }),
    setupTimeoutMs: State.SQLite.integer({ nullable: true }),
    setupEnv: State.SQLite.text({ nullable: true }),
    setupState: State.SQLite.text({ nullable: true }),
    setupExitCode: State.SQLite.integer({ nullable: true }),
    teardownCommand: State.SQLite.text({ nullable: true }),
    teardownOutcome: State.SQLite.text({ nullable: true }),
    removedAt: State.SQLite.text({ nullable: true }),
    createdAt: State.SQLite.text(),
  },
})

export const pullRequests = State.SQLite.table({
  name: 'pullRequests',
  indexes: [{ name: 'idx_pullRequests_taskId', columns: ['taskId'] }],
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    name: State.SQLite.text(),
    number: State.SQLite.integer({ nullable: true }),
    url: State.SQLite.text({ nullable: true }),
    base: State.SQLite.text({ nullable: true }),
    state: State.SQLite.text({ nullable: true }),
    pushedCommit: State.SQLite.text({ nullable: true }),
    pushedAt: State.SQLite.text({ nullable: true }),
    hasCi: State.SQLite.boolean({ nullable: true }),
    ciSignals: State.SQLite.text({ nullable: true }),
    pushError: State.SQLite.text({ nullable: true }),
    pushErrorAt: State.SQLite.text({ nullable: true }),
    mergedAt: State.SQLite.text({ nullable: true }),
    mergeMethod: State.SQLite.text({ nullable: true }),
    mergedWithoutCi: State.SQLite.boolean({ nullable: true }),
    autoMerge: State.SQLite.text({ nullable: true }),
    waitingOn: State.SQLite.text({ nullable: true }),
    signedOffCommit: State.SQLite.text({ nullable: true }),
    closedOnGitHubAt: State.SQLite.text({ nullable: true }),
    previewUrl: State.SQLite.text({ nullable: true }),
    previewSource: State.SQLite.text({ nullable: true }),
    previewLabel: State.SQLite.text({ nullable: true }),
  },
})

export const mergeEvents = {
  taskReposSet: Events.synced({
    name: 'v1.TaskReposSet',
    schema: Schema.Struct({
      taskId: Schema.String,
      repos: Schema.Array(Schema.String),
      names: Schema.Array(Schema.String),
      by: Schema.String,
      runId: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  taskBranchPushed: Events.synced({
    name: 'v1.TaskBranchPushed',
    schema: Schema.Struct({
      taskId: Schema.String,
      name: Schema.String,
      commit: Schema.String,
      ci: Schema.Boolean,
      ciSignals: Schema.Array(Schema.String),
      at: Schema.String,
    }),
  }),
  taskBranchPushFailed: Events.synced({
    name: 'v1.TaskBranchPushFailed',
    schema: Schema.Struct({
      taskId: Schema.String,
      name: Schema.String,
      message: Schema.String,
      at: Schema.String,
    }),
  }),
  taskPushRecordReconciled: Events.synced({
    name: 'v1.TaskPushRecordReconciled',
    schema: Schema.Struct({
      taskId: Schema.String,
      name: Schema.String,
      recorded: Schema.String,
      remote: Schema.String,
      at: Schema.String,
    }),
  }),
  pullRequestOpened: Events.synced({
    name: 'v1.PullRequestOpened',
    schema: Schema.Struct({
      taskId: Schema.String,
      name: Schema.String,
      number: Schema.Number,
      url: Schema.String,
      base: Schema.String,
      at: Schema.String,
    }),
  }),
  pullRequestMarkedReady: Events.synced({
    name: 'v1.PullRequestMarkedReady',
    schema: Schema.Struct({ taskId: Schema.String, name: Schema.String, at: Schema.String }),
  }),
  pullRequestClosed: Events.synced({
    name: 'v1.PullRequestClosed',
    schema: Schema.Struct({ taskId: Schema.String, name: Schema.String, at: Schema.String }),
  }),
  pullRequestReopened: Events.synced({
    name: 'v1.PullRequestReopened',
    schema: Schema.Struct({
      taskId: Schema.String,
      name: Schema.String,
      state: Schema.String,
      at: Schema.String,
    }),
  }),
  pullRequestWaitChanged: Events.synced({
    name: 'v1.PullRequestWaitChanged',
    schema: Schema.Struct({
      taskId: Schema.String,
      name: Schema.String,
      on: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  pullRequestAutoMergeEnabled: Events.synced({
    name: 'v1.PullRequestAutoMergeEnabled',
    schema: Schema.Struct({
      taskId: Schema.String,
      name: Schema.String,
      method: Schema.String,
      requested: Schema.String,
      at: Schema.String,
    }),
  }),
  pullRequestAutoMergeDisabled: Events.synced({
    name: 'v1.PullRequestAutoMergeDisabled',
    schema: Schema.Struct({ taskId: Schema.String, name: Schema.String, at: Schema.String }),
  }),
  pullRequestMerged: Events.synced({
    name: 'v1.PullRequestMerged',
    schema: Schema.Struct({
      taskId: Schema.String,
      name: Schema.String,
      method: Schema.NullOr(Schema.String),
      requested: Schema.NullOr(Schema.String),
      noCi: Schema.Boolean,
      byTed: Schema.Boolean,
      at: Schema.String,
    }),
  }),
  pullRequestClosedOnGitHub: Events.synced({
    name: 'v1.PullRequestClosedOnGitHub',
    schema: Schema.Struct({ taskId: Schema.String, name: Schema.String, at: Schema.String }),
  }),
  pullRequestReopenedV2: Events.synced({
    name: 'v2.PullRequestReopened',
    schema: Schema.Struct({
      taskId: Schema.String,
      name: Schema.String,
      state: Schema.String,
      at: Schema.String,
    }),
  }),
  pullRequestPreviewFound: Events.synced({
    name: 'v1.PullRequestPreviewFound',
    schema: Schema.Struct({
      taskId: Schema.String,
      name: Schema.String,
      url: Schema.String,
      source: Schema.String,
      label: Schema.String,
      at: Schema.String,
    }),
  }),
  pullRequestSignedOff: Events.synced({
    name: 'v1.PullRequestSignedOff',
    schema: Schema.Struct({
      taskId: Schema.String,
      name: Schema.String,
      commit: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  mergeStoppedPartway: Events.synced({
    name: 'v1.MergeStoppedPartway',
    schema: Schema.Struct({
      taskId: Schema.String,
      merged: Schema.Array(Schema.String),
      open: Schema.Array(Schema.String),
      at: Schema.String,
    }),
  }),
  taskBranchRebased: Events.synced({
    name: 'v1.TaskBranchRebased',
    schema: Schema.Struct({
      taskId: Schema.String,
      name: Schema.String,
      commit: Schema.String,
      onto: Schema.String,
      at: Schema.String,
    }),
  }),
  mergeStarted: Events.synced({
    name: 'v1.MergeStarted',
    schema: Schema.Struct({ taskId: Schema.String, at: Schema.String }),
  }),
  mergeAwaitsLead: Events.synced({
    name: 'v1.MergeAwaitsLead',
    schema: Schema.Struct({ taskId: Schema.String, at: Schema.String }),
  }),
  failedRunMergeAnywayOffered: Events.synced({
    name: 'v1.FailedRunMergeAnywayOffered',
    schema: Schema.Struct({ commentId: Schema.String, choices: Schema.String }),
  }),
  mergeLeadAdvanced: Events.synced({
    name: 'v1.MergeLeadAdvanced',
    schema: Schema.Struct({
      taskId: Schema.String,
      by: Schema.String,
      at: Schema.String,
    }),
  }),
  pullRequestTitleSet: Events.synced({
    name: 'v1.PullRequestTitleSet',
    schema: Schema.Struct({
      taskId: Schema.String,
      title: Schema.String,
      body: Schema.String,
      at: Schema.String,
    }),
  }),
  gateRequestedFor: Events.synced({
    name: 'v1.GateRequestedFor',
    schema: Schema.Struct({
      taskId: Schema.String,
      commentId: Schema.String,
      name: Schema.String,
      commit: Schema.String,
      at: Schema.String,
    }),
  }),
  mergeCommitChosen: Events.synced({
    name: 'v1.MergeCommitChosen',
    schema: Schema.Struct({
      taskId: Schema.String,
      name: Schema.String,
      commit: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  gateApprovalBound: Events.synced({
    name: 'v1.GateApprovalBound',
    schema: Schema.Struct({
      taskId: Schema.String,
      commentId: Schema.String,
      name: Schema.String,
      commit: Schema.String,
      at: Schema.String,
    }),
  }),
  gateKeptOvernight: Events.synced({
    name: 'v1.GateKeptOvernight',
    schema: Schema.Struct({
      taskId: Schema.String,
      stage: Schema.String,
      reason: Schema.String,
      at: Schema.String,
    }),
  }),
  gateSkippedOvernight: Events.synced({
    name: 'v1.GateSkippedOvernight',
    schema: Schema.Struct({ taskId: Schema.String, stage: Schema.String, at: Schema.String }),
  }),
  mergeCanceled: Events.synced({
    name: 'v1.MergeCanceled',
    schema: Schema.Struct({ taskId: Schema.String, commentId: Schema.String, at: Schema.String }),
  }),
  taskMarkedDone: Events.synced({
    name: 'v1.TaskMarkedDone',
    schema: Schema.Struct({ taskId: Schema.String, at: Schema.String }),
  }),
  taskMarkedDoneBy: Events.synced({
    name: 'v2.TaskMarkedDone',
    schema: Schema.Struct({
      taskId: Schema.String,
      by: Schema.String,
      at: Schema.String,
    }),
  }),
  taskWorktreeCreated: Events.synced({
    name: 'v1.TaskWorktreeCreated',
    schema: Schema.Struct({
      taskId: Schema.String,
      name: Schema.String,
      repo: Schema.String,
      branch: Schema.String,
      worktree: Schema.String,
      copied: Schema.Array(Schema.String),
      skipped: Schema.Array(Schema.Struct({ path: Schema.String, reason: Schema.String })),
      at: Schema.String,
    }),
  }),
  taskWorktreeSetupStarted: Events.synced({
    name: 'v1.TaskWorktreeSetupStarted',
    schema: Schema.Struct({
      taskId: Schema.String,
      name: Schema.String,
      command: Schema.String,
      timeoutMs: Schema.Number,
      env: Schema.String,
      at: Schema.String,
    }),
  }),
  taskWorktreeSetupFinished: Events.synced({
    name: 'v1.TaskWorktreeSetupFinished',
    schema: Schema.Struct({
      taskId: Schema.String,
      name: Schema.String,
      outcome: Schema.String,
      exitCode: Schema.NullOr(Schema.Number),
      at: Schema.String,
    }),
  }),
  taskWorktreeRemoved: Events.synced({
    name: 'v1.TaskWorktreeRemoved',
    schema: Schema.Struct({
      taskId: Schema.String,
      name: Schema.String,
      teardownCommand: Schema.NullOr(Schema.String),
      teardownOutcome: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  cleanupStepReported: Events.synced({
    name: 'v1.CleanupStepReported',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      step: Schema.String,
      result: Schema.String,
      text: Schema.String,
      runId: Schema.String,
      at: Schema.String,
    }),
  }),
  cleanupCommandRan: Events.synced({
    name: 'v1.CleanupCommandRan',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      step: Schema.String,
      state: Schema.String,
      exitCode: Schema.NullOr(Schema.Number),
      timeout: Schema.String,
      durationMs: Schema.Number,
      output: Schema.String,
      at: Schema.String,
    }),
  }),
  cleanupRetried: Events.synced({
    name: 'v1.CleanupRetried',
    schema: Schema.Struct({
      taskId: Schema.String,
      steps: Schema.Array(Schema.String),
      at: Schema.String,
    }),
  }),
  cleanupFinishedAnyway: Events.synced({
    name: 'v1.CleanupFinishedAnyway',
    schema: Schema.Struct({
      taskId: Schema.String,
      steps: Schema.Array(Schema.String),
      at: Schema.String,
    }),
  }),
  baseConflictFound: Events.synced({
    name: 'v1.BaseConflictFound',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      stage: Schema.String,
      repo: Schema.String,
      base: Schema.String,
      tip: Schema.String,
      fileCount: Schema.Number,
      files: Schema.Array(Schema.String),
      sendBackId: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  baseBranchAdopted: Events.synced({
    name: 'v1.BaseBranchAdopted',
    schema: Schema.Struct({
      taskId: Schema.String,
      repo: Schema.String,
      base: Schema.String,
      from: Schema.String,
      to: Schema.String,
      at: Schema.String,
    }),
  }),
  baseBranchMerged: Events.synced({
    name: 'v1.BaseBranchMerged',
    schema: Schema.Struct({
      taskId: Schema.String,
      repo: Schema.String,
      base: Schema.String,
      from: Schema.String,
      to: Schema.String,
      commit: Schema.String,
      at: Schema.String,
    }),
  }),
}

export const mergeMaterializers = State.SQLite.materializers(mergeEvents, {
  'v1.MergeStarted': ({ taskId, at }) => tasks.update({ changedAt: at }).where({ id: taskId }),
  'v1.MergeAwaitsLead': ({ taskId, at }) => tasks.update({ changedAt: at }).where({ id: taskId }),
  'v1.MergeLeadAdvanced': ({ taskId, at }) => tasks.update({ changedAt: at }).where({ id: taskId }),
  'v1.PullRequestTitleSet': ({ taskId, at }) =>
    tasks.update({ changedAt: at }).where({ id: taskId }),
  'v1.GateRequestedFor': ({ taskId, at }) => tasks.update({ changedAt: at }).where({ id: taskId }),
  'v1.GateApprovalBound': ({ taskId, at }) => tasks.update({ changedAt: at }).where({ id: taskId }),
  'v1.MergeCommitChosen': ({ taskId, at }) => tasks.update({ changedAt: at }).where({ id: taskId }),
  'v1.BaseBranchAdopted': ({ taskId, at }) => tasks.update({ changedAt: at }).where({ id: taskId }),
  'v1.BaseBranchMerged': ({ taskId, at }) => tasks.update({ changedAt: at }).where({ id: taskId }),
  'v1.GateKeptOvernight': ({ taskId, at }) => tasks.update({ changedAt: at }).where({ id: taskId }),
  'v1.GateSkippedOvernight': ({ taskId, at }) =>
    tasks.update({ changedAt: at }).where({ id: taskId }),
  'v1.MergeCanceled': ({ taskId, at }) => tasks.update({ changedAt: at }).where({ id: taskId }),
  'v1.TaskMarkedDone': ({ taskId, at }) => tasks.update({ changedAt: at }).where({ id: taskId }),
  'v2.TaskMarkedDone': ({ taskId, at }) => tasks.update({ changedAt: at }).where({ id: taskId }),
  'v1.TaskReposSet': ({ taskId, repos, at }) =>
    tasks.update({ chosenRepos: JSON.stringify(repos), changedAt: at }).where({ id: taskId }),
  'v1.CleanupStepReported': (row) => cleanupReports.insert(row),
  'v1.CleanupCommandRan': ({ id, taskId, step, state, exitCode, timeout, at }) =>
    cleanupReports.insert({
      id,
      taskId,
      step,
      result: state === 'passed' ? 'done' : 'failed',
      text: cleanupCommandText(state, exitCode, timeout),
      runId: '',
      at,
    }),
  'v1.CleanupRetried': ({ taskId, steps }) =>
    cleanupReports.delete().where({ taskId, step: { op: 'IN', value: steps } }),
  'v1.CleanupFinishedAnyway': () => [],
  'v1.BaseConflictFound': ({ files, ...row }) =>
    baseConflicts.insert({ ...row, files: JSON.stringify(files) }),
  'v1.FailedRunMergeAnywayOffered': ({ commentId, choices }) =>
    comments.update({ choices }).where({ id: commentId }),
  'v1.TaskWorktreeCreated': ({ taskId, name, copied, skipped, at, ...row }) =>
    taskRepos
      .insert({
        ...row,
        id: `${taskId}:${name}`,
        taskId,
        name,
        copied: JSON.stringify(copied),
        skipped: JSON.stringify(skipped),
        createdAt: at,
      })
      .onConflict('id', 'replace'),
  'v1.TaskWorktreeSetupStarted': ({ taskId, name, command, timeoutMs, env }) =>
    taskRepos
      .update({
        setupCommand: command,
        setupTimeoutMs: timeoutMs,
        setupEnv: env,
        setupState: 'running',
        setupExitCode: null,
      })
      .where({ id: `${taskId}:${name}` }),
  'v1.TaskWorktreeSetupFinished': ({ taskId, name, outcome, exitCode }) =>
    taskRepos
      .update({ setupState: outcome, setupExitCode: exitCode })
      .where({ id: `${taskId}:${name}` }),
  'v1.TaskWorktreeRemoved': ({ taskId, name, teardownCommand, teardownOutcome, at }) => [
    taskRepos
      .update({ teardownCommand, teardownOutcome, removedAt: at })
      .where({ id: `${taskId}:${name}` }),
    tasks.update({ worktree: null }).where({ id: taskId }),
  ],
  'v1.TaskBranchPushed': ({ taskId, name, commit, ci, ciSignals, at }) => [
    pullRequests.insert({ id: `${taskId}:${name}`, taskId, name }).onConflict('id', 'ignore'),
    pullRequests
      .update({
        pushedCommit: commit,
        pushedAt: at,
        hasCi: ci,
        ciSignals: JSON.stringify(ciSignals),
        pushError: null,
        pushErrorAt: null,
        signedOffCommit: null,
      })
      .where({ id: `${taskId}:${name}` }),
  ],
  'v1.TaskBranchPushFailed': ({ taskId, name, message, at }) => [
    pullRequests.insert({ id: `${taskId}:${name}`, taskId, name }).onConflict('id', 'ignore'),
    pullRequests
      .update({ pushError: message, pushErrorAt: at, signedOffCommit: null })
      .where({ id: `${taskId}:${name}` }),
  ],
  'v1.TaskPushRecordReconciled': ({ taskId, name, remote }) =>
    pullRequests.update({ pushedCommit: remote }).where({ id: `${taskId}:${name}` }),
  'v1.PullRequestOpened': ({ taskId, name, number, url, base }) => [
    pullRequests.insert({ id: `${taskId}:${name}`, taskId, name }).onConflict('id', 'ignore'),
    pullRequests
      .update({ number, url, base, state: 'draft', signedOffCommit: null })
      .where({ id: `${taskId}:${name}` }),
  ],
  'v1.PullRequestMarkedReady': ({ taskId, name }) =>
    pullRequests.update({ state: 'ready' }).where({ id: `${taskId}:${name}` }),
  'v1.PullRequestClosed': ({ taskId, name }) =>
    pullRequests.update({ state: 'closed' }).where({ id: `${taskId}:${name}` }),
  'v1.PullRequestReopened': ({ taskId, name, state }) =>
    pullRequests.update({ state }).where({ id: `${taskId}:${name}` }),
  'v1.PullRequestWaitChanged': ({ taskId, name, on }) =>
    pullRequests.update({ waitingOn: on }).where({ id: `${taskId}:${name}` }),
  'v1.PullRequestAutoMergeEnabled': ({ taskId, name, method }) =>
    pullRequests.update({ autoMerge: method }).where({ id: `${taskId}:${name}` }),
  'v1.PullRequestAutoMergeDisabled': ({ taskId, name }) =>
    pullRequests.update({ autoMerge: null }).where({ id: `${taskId}:${name}` }),
  'v1.PullRequestMerged': ({ taskId, name, method, noCi, at }) =>
    pullRequests
      .update({
        state: 'merged',
        mergedAt: at,
        mergeMethod: method,
        mergedWithoutCi: noCi,
        waitingOn: null,
      })
      .where({ id: `${taskId}:${name}` }),
  'v1.PullRequestSignedOff': ({ taskId, name, commit }) =>
    pullRequests.update({ signedOffCommit: commit }).where({ id: `${taskId}:${name}` }),
  'v1.PullRequestClosedOnGitHub': ({ taskId, name, at }) =>
    pullRequests
      .update({ state: 'closed', closedOnGitHubAt: at, waitingOn: null })
      .where({ id: `${taskId}:${name}` }),
  'v2.PullRequestReopened': ({ taskId, name, state }) =>
    pullRequests.update({ state, closedOnGitHubAt: null }).where({ id: `${taskId}:${name}` }),
  'v1.PullRequestPreviewFound': ({ taskId, name, url, source, label }) =>
    pullRequests
      .update({ previewUrl: url, previewSource: source, previewLabel: label })
      .where({ id: `${taskId}:${name}` }),
  'v1.MergeStoppedPartway': ({ taskId, at }) =>
    tasks.update({ partlyMergedAt: at, changedAt: at }).where({ id: taskId }),
  'v1.TaskBranchRebased': ({ taskId, name, commit, at }) =>
    pullRequests
      .update({ pushedCommit: commit, pushedAt: at, signedOffCommit: commit })
      .where({ id: `${taskId}:${name}` }),
})
