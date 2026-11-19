import { Events, Schema, State } from '@livestore/livestore'
import { tasks } from './tasks.ts'

export const reviewers = State.SQLite.table({
  name: 'reviewers',
  indexes: [{ name: 'idx_reviewers_taskId', columns: ['taskId'] }],
  columns: {
    runId: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    stage: State.SQLite.text(),
    purpose: State.SQLite.text(),
    agent: State.SQLite.text(),
    unavailable: State.SQLite.text({ nullable: true }),
    at: State.SQLite.text(),
  },
})

export const reviewScopes = State.SQLite.table({
  name: 'reviewScopes',
  indexes: [{ name: 'idx_reviewScopes_taskId', columns: ['taskId'] }],
  columns: {
    runId: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    scope: State.SQLite.text(),
    round: State.SQLite.integer(),
    commits: State.SQLite.text(),
    since: State.SQLite.text({ nullable: true }),
    at: State.SQLite.text(),
  },
})

export const p1OnlyReviews = State.SQLite.table({
  name: 'p1OnlyReviews',
  indexes: [{ name: 'idx_p1OnlyReviews_taskId', columns: ['taskId'] }],
  columns: {
    runId: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    round: State.SQLite.integer(),
    from: State.SQLite.integer(),
    at: State.SQLite.text(),
  },
})

export const severityDeclarations = State.SQLite.table({
  name: 'severityDeclarations',
  indexes: [{ name: 'idx_severityDeclarations_taskId', columns: ['taskId'] }],
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    runId: State.SQLite.text(),
    round: State.SQLite.integer(),
    severity: State.SQLite.text(),
    at: State.SQLite.text(),
  },
})

export const loopChecks = State.SQLite.table({
  name: 'loopChecks',
  indexes: [{ name: 'idx_loopChecks_taskId', columns: ['taskId'] }],
  columns: {
    runId: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    toStage: State.SQLite.text(),
    findings: State.SQLite.text(),
    checkRunId: State.SQLite.text({ nullable: true }),
    round: State.SQLite.integer(),
    limit: State.SQLite.integer({ nullable: true }),
    verdict: State.SQLite.text({ nullable: true }),
    cause: State.SQLite.text({ nullable: true }),
    at: State.SQLite.text(),
  },
})

export const sendBackAsks = State.SQLite.table({
  name: 'sendBackAsks',
  indexes: [{ name: 'idx_sendBackAsks_taskId', columns: ['taskId'] }],
  columns: {
    commentId: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    fromStage: State.SQLite.text(),
    toStage: State.SQLite.text(),
    findings: State.SQLite.text(),
    checkRunId: State.SQLite.text({ nullable: true }),
    loop: State.SQLite.boolean(),
    cause: State.SQLite.text({ nullable: true }),
    at: State.SQLite.text(),
  },
})

export const sendBacks = State.SQLite.table({
  name: 'sendBacks',
  indexes: [{ name: 'idx_sendBacks_taskId', columns: ['taskId'] }],
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    fromStage: State.SQLite.text(),
    toStage: State.SQLite.text(),
    findings: State.SQLite.text(),
    counted: State.SQLite.boolean(),
    round: State.SQLite.integer({ nullable: true }),
    limit: State.SQLite.integer({ nullable: true }),
    checkRunId: State.SQLite.text({ nullable: true }),
    cause: State.SQLite.text({ nullable: true }),
    at: State.SQLite.text(),
  },
})

export const testInvocations = State.SQLite.table({
  name: 'testInvocations',
  indexes: [{ name: 'idx_testInvocations_taskId', columns: ['taskId'] }],
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    runId: State.SQLite.text({ nullable: true }),
    checkRunId: State.SQLite.text({ nullable: true }),
    position: State.SQLite.integer({ nullable: true }),
    ownerEnded: State.SQLite.boolean({ default: false }),
    data: State.SQLite.text(),
  },
})

export const checkRuns = State.SQLite.table({
  name: 'checkRuns',
  indexes: [{ name: 'idx_checkRuns_taskId', columns: ['taskId'] }],
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    trigger: State.SQLite.text(),
    stage: State.SQLite.text(),
    startedAt: State.SQLite.text(),
    finishedAt: State.SQLite.text({ nullable: true }),
    outcome: State.SQLite.text({ nullable: true }),
  },
})

export const checkBoundaries = State.SQLite.table({
  name: 'checkBoundaries',
  indexes: [{ name: 'idx_checkBoundaries_checkRunId', columns: ['checkRunId'] }],
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    checkRunId: State.SQLite.text(),
    kind: State.SQLite.text(),
    position: State.SQLite.integer({ nullable: true }),
    at: State.SQLite.text(),
  },
})

export const checkResults = State.SQLite.table({
  name: 'checkResults',
  indexes: [{ name: 'idx_checkResults_checkRunId', columns: ['checkRunId'] }],
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    checkRunId: State.SQLite.text(),
    position: State.SQLite.integer(),
    name: State.SQLite.text(),
    repo: State.SQLite.text({ nullable: true }),
    command: State.SQLite.text(),
    timeout: State.SQLite.text(),
    builtIn: State.SQLite.text({ nullable: true }),
    state: State.SQLite.text(),
    exitCode: State.SQLite.integer({ nullable: true }),
    durationMs: State.SQLite.integer({ nullable: true }),
    instruction: State.SQLite.text({ nullable: true }),
    fix: State.SQLite.boolean({ nullable: true }),
    agent: State.SQLite.text({ nullable: true }),
    model: State.SQLite.text({ nullable: true }),
    effort: State.SQLite.text({ nullable: true }),
    notRerun: State.SQLite.boolean({ nullable: true }),
    noReport: State.SQLite.text({ nullable: true }),
    noReportMs: State.SQLite.integer({ nullable: true }),
    changeKey: State.SQLite.text({ nullable: true }),
  },
})

export const sendBackResets = State.SQLite.table({
  name: 'sendBackResets',
  indexes: [{ name: 'idx_sendBackResets_taskId', columns: ['taskId'] }],
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    stage: State.SQLite.text(),
    at: State.SQLite.text(),
  },
})

export const checksEvents = {
  testInvocationRecorded: Events.synced({
    name: 'v1.TestInvocationRecorded',
    schema: Schema.Struct({ id: Schema.String, taskId: Schema.String, data: Schema.String }),
  }),
  taskSentBack: Events.synced({
    name: 'v1.TaskSentBack',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      from: Schema.String,
      to: Schema.String,
      findings: Schema.String,
      counted: Schema.Boolean,
      at: Schema.String,
    }),
  }),
  taskSentBackV2: Events.synced({
    name: 'v2.TaskSentBack',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      from: Schema.String,
      to: Schema.String,
      findings: Schema.String,
      counted: Schema.Boolean,
      round: Schema.NullOr(Schema.Number),
      limit: Schema.NullOr(Schema.Number),
      checkRunId: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  checksStarted: Events.synced({
    name: 'v1.ChecksStarted',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      trigger: Schema.String,
      stage: Schema.String,
      checks: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          repo: Schema.NullOr(Schema.String),
          command: Schema.String,
          timeout: Schema.String,
          builtIn: Schema.NullOr(Schema.String),
          state: Schema.String,
        }),
      ),
      at: Schema.String,
    }),
  }),
  checksStartedWithInstructions: Events.synced({
    name: 'v2.ChecksStarted',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      trigger: Schema.String,
      stage: Schema.String,
      checks: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          repo: Schema.NullOr(Schema.String),
          command: Schema.NullOr(Schema.String),
          timeout: Schema.String,
          builtIn: Schema.NullOr(Schema.String),
          state: Schema.String,
          instruction: Schema.NullOr(Schema.String),
          fix: Schema.NullOr(Schema.Boolean),
          agent: Schema.NullOr(Schema.String),
          model: Schema.NullOr(Schema.String),
          effort: Schema.NullOr(Schema.String),
          notRerun: Schema.NullOr(Schema.Boolean),
        }),
      ),
      at: Schema.String,
    }),
  }),
  checksReplanned: Events.synced({
    name: 'v1.ChecksReplanned',
    schema: Schema.Struct({
      taskId: Schema.String,
      checkRunId: Schema.String,
      from: Schema.Number,
      checks: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          repo: Schema.NullOr(Schema.String),
          command: Schema.NullOr(Schema.String),
          timeout: Schema.String,
          builtIn: Schema.NullOr(Schema.String),
          state: Schema.String,
          instruction: Schema.NullOr(Schema.String),
          fix: Schema.NullOr(Schema.Boolean),
          agent: Schema.NullOr(Schema.String),
          model: Schema.NullOr(Schema.String),
          effort: Schema.NullOr(Schema.String),
          notRerun: Schema.NullOr(Schema.Boolean),
        }),
      ),
      at: Schema.String,
    }),
  }),
  checkChangeKeyRecorded: Events.synced({
    name: 'v1.CheckChangeKeyRecorded',
    schema: Schema.Struct({
      checkRunId: Schema.String,
      position: Schema.Number,
      key: Schema.String,
      at: Schema.String,
    }),
  }),
  checkReportMissing: Events.synced({
    name: 'v1.CheckReportMissing',
    schema: Schema.Struct({
      taskId: Schema.String,
      checkRunId: Schema.String,
      position: Schema.Number,
      reason: Schema.String,
      durationMs: Schema.Number,
      at: Schema.String,
    }),
  }),
  checkSlotEntered: Events.synced({
    name: 'v1.CheckSlotEntered',
    schema: Schema.Struct({
      taskId: Schema.String,
      checkRunId: Schema.String,
      trigger: Schema.String,
      stage: Schema.String,
      at: Schema.String,
    }),
  }),
  checkSlotAcquired: Events.synced({
    name: 'v1.CheckSlotAcquired',
    schema: Schema.Struct({
      taskId: Schema.String,
      checkRunId: Schema.String,
      trigger: Schema.String,
      stage: Schema.String,
      at: Schema.String,
    }),
  }),
  checkSlotCanceled: Events.synced({
    name: 'v1.CheckSlotCanceled',
    schema: Schema.Struct({
      taskId: Schema.String,
      checkRunId: Schema.String,
      trigger: Schema.String,
      stage: Schema.String,
      at: Schema.String,
    }),
  }),
  checkSlotInterrupted: Events.synced({
    name: 'v1.CheckSlotInterrupted',
    schema: Schema.Struct({
      taskId: Schema.String,
      checkRunId: Schema.String,
      trigger: Schema.String,
      stage: Schema.String,
      at: Schema.String,
    }),
  }),
  checkSlotRecoveryRecorded: Events.synced({
    name: 'v1.CheckSlotRecoveryRecorded',
    schema: Schema.Struct({
      taskId: Schema.String,
      checkRunId: Schema.String,
      trigger: Schema.String,
      stage: Schema.String,
      at: Schema.String,
    }),
  }),
  checkExecutionInterrupted: Events.synced({
    name: 'v1.CheckExecutionInterrupted',
    schema: Schema.Struct({
      taskId: Schema.String,
      checkRunId: Schema.String,
      position: Schema.Number,
      at: Schema.String,
    }),
  }),
  checkStarted: Events.synced({
    name: 'v1.CheckStarted',
    schema: Schema.Struct({
      checkRunId: Schema.String,
      position: Schema.Number,
      at: Schema.String,
    }),
  }),
  checkFinished: Events.synced({
    name: 'v1.CheckFinished',
    schema: Schema.Struct({
      checkRunId: Schema.String,
      position: Schema.Number,
      state: Schema.String,
      exitCode: Schema.NullOr(Schema.Number),
      durationMs: Schema.Number,
      at: Schema.String,
    }),
  }),
  checkKilledForMemory: Events.synced({
    name: 'v1.CheckKilledForMemory',
    schema: Schema.Struct({
      taskId: Schema.String,
      checkRunId: Schema.String,
      position: Schema.Number,
      name: Schema.String,
      stage: Schema.String,
      lowestMemory: Schema.Number,
      durationMs: Schema.Number,
      at: Schema.String,
    }),
  }),
  checksFinished: Events.synced({
    name: 'v1.ChecksFinished',
    schema: Schema.Struct({ checkRunId: Schema.String, outcome: Schema.String, at: Schema.String }),
  }),
  sendBackCountReset: Events.synced({
    name: 'v1.SendBackCountReset',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      stage: Schema.String,
      at: Schema.String,
    }),
  }),
  reviewerChosen: Events.synced({
    name: 'v1.ReviewerChosen',
    schema: Schema.Struct({
      runId: Schema.String,
      taskId: Schema.String,
      stage: Schema.String,
      purpose: Schema.String,
      agent: Schema.String,
      unavailable: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  reviewScopeRecorded: Events.synced({
    name: 'v1.ReviewScopeRecorded',
    schema: Schema.Struct({
      runId: Schema.String,
      taskId: Schema.String,
      scope: Schema.String,
      round: Schema.Number,
      commits: Schema.Array(Schema.Struct({ name: Schema.String, commit: Schema.String })),
      since: Schema.NullOr(
        Schema.Array(Schema.Struct({ name: Schema.String, commit: Schema.String })),
      ),
      at: Schema.String,
    }),
  }),
  sendBackCauseRecorded: Events.synced({
    name: 'v1.SendBackCauseRecorded',
    schema: Schema.Struct({
      sendBackId: Schema.String,
      taskId: Schema.String,
      cause: Schema.String,
      at: Schema.String,
    }),
  }),
  p1OnlyReviewRecorded: Events.synced({
    name: 'v1.SeverityRuleReviewRecorded',
    schema: Schema.Struct({
      runId: Schema.String,
      taskId: Schema.String,
      round: Schema.Number,
      from: Schema.Number,
      at: Schema.String,
    }),
  }),
  sendBackSeverityDeclared: Events.synced({
    name: 'v1.SendBackSeverityDeclared',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      runId: Schema.String,
      round: Schema.Number,
      severity: Schema.String,
      at: Schema.String,
    }),
  }),
  validateJudged: Events.synced({
    name: 'v1.ValidateJudged',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      outcome: Schema.String,
      checkRunId: Schema.NullOr(Schema.String),
      review: Schema.NullOr(
        Schema.Struct({ passed: Schema.Boolean, notes: Schema.NullOr(Schema.Number) }),
      ),
      visual: Schema.NullOr(
        Schema.Struct({ passed: Schema.Boolean, notes: Schema.NullOr(Schema.Number) }),
      ),
      reviewer: Schema.NullOr(
        Schema.Struct({ agent: Schema.String, unavailable: Schema.NullOr(Schema.String) }),
      ),
      at: Schema.String,
    }),
  }),
  validateJudgedV2: Events.synced({
    name: 'v2.ValidateJudged',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      outcome: Schema.String,
      checkRunId: Schema.NullOr(Schema.String),
      review: Schema.NullOr(
        Schema.Struct({ passed: Schema.Boolean, notes: Schema.NullOr(Schema.Number) }),
      ),
      visual: Schema.NullOr(
        Schema.Struct({ passed: Schema.Boolean, notes: Schema.NullOr(Schema.Number) }),
      ),
      reviewer: Schema.NullOr(
        Schema.Struct({ agent: Schema.String, unavailable: Schema.NullOr(Schema.String) }),
      ),
      validation: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  loopCheckStarted: Events.synced({
    name: 'v1.LoopCheckStarted',
    schema: Schema.Struct({
      runId: Schema.String,
      taskId: Schema.String,
      to: Schema.String,
      findings: Schema.String,
      checkRunId: Schema.NullOr(Schema.String),
      round: Schema.Number,
      limit: Schema.NullOr(Schema.Number),
      at: Schema.String,
    }),
  }),
  loopCheckStartedV2: Events.synced({
    name: 'v2.LoopCheckStarted',
    schema: Schema.Struct({
      runId: Schema.String,
      taskId: Schema.String,
      to: Schema.String,
      findings: Schema.String,
      checkRunId: Schema.NullOr(Schema.String),
      round: Schema.Number,
      limit: Schema.NullOr(Schema.Number),
      cause: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  loopCheckFinished: Events.synced({
    name: 'v1.LoopCheckFinished',
    schema: Schema.Struct({
      runId: Schema.String,
      taskId: Schema.String,
      verdict: Schema.String,
      reason: Schema.String,
      at: Schema.String,
    }),
  }),
  sendBackAsked: Events.synced({
    name: 'v1.SendBackAsked',
    schema: Schema.Struct({
      commentId: Schema.String,
      taskId: Schema.String,
      from: Schema.String,
      to: Schema.String,
      findings: Schema.String,
      checkRunId: Schema.NullOr(Schema.String),
      loop: Schema.Boolean,
      at: Schema.String,
    }),
  }),
  sendBackAskedV2: Events.synced({
    name: 'v2.SendBackAsked',
    schema: Schema.Struct({
      commentId: Schema.String,
      taskId: Schema.String,
      from: Schema.String,
      to: Schema.String,
      findings: Schema.String,
      checkRunId: Schema.NullOr(Schema.String),
      loop: Schema.Boolean,
      cause: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
}

export const checksMaterializers = State.SQLite.materializers(checksEvents, {
  'v1.TestInvocationRecorded': (row) => {
    const value = JSON.parse(row.data) as {
      runId?: string
      checkRunId?: string
      position?: number
    }
    return testInvocations
      .insert({
        ...row,
        runId: value.runId ?? null,
        checkRunId: value.checkRunId ?? null,
        position: value.position ?? null,
      })
      .onConflict('id', 'replace')
  },
  'v1.TaskSentBack': ({ from, to, ...row }) =>
    sendBacks.insert({ ...row, fromStage: from, toStage: to }),
  'v2.TaskSentBack': ({ from, to, ...row }) =>
    sendBacks.insert({ ...row, fromStage: from, toStage: to }),
  'v1.ChecksStarted': ({ checks, at, ...run }) => [
    checkRuns.insert({ ...run, startedAt: at }),
    ...checks.map((check, position) =>
      checkResults.insert({
        ...check,
        id: `${run.id}:${position}`,
        checkRunId: run.id,
        position,
      }),
    ),
  ],
  'v2.ChecksStarted': ({ checks, at, ...run }) => [
    checkRuns.insert({ ...run, startedAt: at }),
    ...checks.map(({ command, ...check }, position) =>
      checkResults.insert({
        ...check,
        command: command ?? '',
        id: `${run.id}:${position}`,
        checkRunId: run.id,
        position,
      }),
    ),
  ],
  'v1.ChecksReplanned': ({ checkRunId, from, checks }) => [
    checkResults.delete().where({ checkRunId, position: { op: '>=', value: from } }),
    ...checks.map(({ command, ...check }, index) =>
      checkResults.insert({
        ...check,
        command: command ?? '',
        id: `${checkRunId}:${from + index}`,
        checkRunId,
        position: from + index,
      }),
    ),
  ],
  'v1.CheckChangeKeyRecorded': ({ checkRunId, position, key }) =>
    checkResults.update({ changeKey: key }).where({ id: `${checkRunId}:${position}` }),
  'v1.CheckReportMissing': ({ checkRunId, position, reason, durationMs }) => [
    checkResults
      .update({ noReport: reason, noReportMs: durationMs })
      .where({ id: `${checkRunId}:${position}` }),
    checkBoundaries.delete().where({ id: `${checkRunId}:start:${position}` }),
  ],
  'v1.CheckSlotEntered': ({ checkRunId, at }) =>
    checkBoundaries.insert({
      id: `${checkRunId}:entered`,
      checkRunId,
      position: null,
      kind: 'entered',
      at,
    }),
  'v1.CheckSlotAcquired': ({ checkRunId, at }) =>
    checkBoundaries.insert({
      id: `${checkRunId}:acquired`,
      checkRunId,
      position: null,
      kind: 'acquired',
      at,
    }),
  'v1.CheckSlotCanceled': ({ checkRunId, at }) =>
    checkBoundaries.insert({
      id: `${checkRunId}:canceled`,
      checkRunId,
      position: null,
      kind: 'canceled',
      at,
    }),
  'v1.CheckSlotInterrupted': ({ checkRunId, at }) =>
    checkBoundaries.insert({
      id: `${checkRunId}:interrupted`,
      checkRunId,
      position: null,
      kind: 'interrupted',
      at,
    }),
  'v1.CheckSlotRecoveryRecorded': ({ checkRunId, at }) =>
    checkBoundaries
      .insert({
        id: `${checkRunId}:recovered`,
        checkRunId,
        position: null,
        kind: 'recovered',
        at,
      })
      .onConflict('id', 'ignore'),
  'v1.CheckExecutionInterrupted': ({ checkRunId, position, at }) => [
    testInvocations.update({ ownerEnded: true }).where({ checkRunId, position }),
    checkBoundaries.insert({
      id: `${checkRunId}:interrupted-end:${position}`,
      checkRunId,
      position,
      kind: 'interrupted-end',
      at,
    }),
  ],
  'v1.CheckStarted': ({ checkRunId, position, at }) => [
    checkResults.update({ state: 'running' }).where({ id: `${checkRunId}:${position}` }),
    checkBoundaries.insert({
      id: `${checkRunId}:start:${position}`,
      checkRunId,
      position,
      kind: 'start',
      at,
    }),
  ],
  'v1.CheckFinished': ({ checkRunId, position, state, exitCode, durationMs, at }) => [
    testInvocations.update({ ownerEnded: true }).where({ checkRunId, position }),
    checkResults.update({ state, exitCode, durationMs }).where({ id: `${checkRunId}:${position}` }),
    checkBoundaries.insert({
      id: `${checkRunId}:end:${position}`,
      checkRunId,
      position,
      kind: 'end',
      at,
    }),
  ],
  'v1.CheckKilledForMemory': ({ checkRunId, position, durationMs }) => [
    testInvocations.update({ ownerEnded: true }).where({ checkRunId, position }),
    checkResults
      .update({ state: 'out-of-memory', exitCode: null, durationMs })
      .where({ id: `${checkRunId}:${position}` }),
    checkBoundaries.delete().where({ id: `${checkRunId}:start:${position}` }),
  ],
  'v1.ChecksFinished': ({ checkRunId, outcome, at }) => [
    testInvocations.update({ ownerEnded: true }).where({ checkRunId }),
    checkRuns.update({ outcome, finishedAt: at }).where({ id: checkRunId }),
    checkResults.update({ state: 'not-run' }).where({ checkRunId, state: 'waiting' }),
    checkResults.update({ state: 'not-run' }).where({ checkRunId, state: 'running' }),
  ],
  'v1.SendBackCountReset': (reset) => sendBackResets.insert(reset),
  'v1.ReviewerChosen': (row) => reviewers.insert(row),
  'v1.ReviewScopeRecorded': ({ commits, since, ...row }) =>
    reviewScopes.insert({
      ...row,
      commits: JSON.stringify(commits),
      since: since === null ? null : JSON.stringify(since),
    }),
  'v1.SendBackCauseRecorded': ({ sendBackId, cause }) =>
    sendBacks.update({ cause }).where({ id: sendBackId }),
  'v1.SeverityRuleReviewRecorded': (row) => p1OnlyReviews.insert(row),
  'v1.SendBackSeverityDeclared': (row) => severityDeclarations.insert(row),
  'v1.ValidateJudged': ({ taskId, at }) => tasks.update({ changedAt: at }).where({ id: taskId }),
  'v2.ValidateJudged': ({ taskId, at }) => tasks.update({ changedAt: at }).where({ id: taskId }),
  'v1.LoopCheckStarted': ({ to, ...row }) =>
    loopChecks.insert({ ...row, toStage: to, verdict: null, cause: null }),
  'v2.LoopCheckStarted': ({ to, ...row }) =>
    loopChecks.insert({ ...row, toStage: to, verdict: null }),
  'v1.LoopCheckFinished': ({ runId, verdict }) => loopChecks.update({ verdict }).where({ runId }),
  'v1.SendBackAsked': ({ from, to, ...row }) =>
    sendBackAsks.insert({ ...row, fromStage: from, toStage: to, cause: null }),
  'v2.SendBackAsked': ({ from, to, ...row }) =>
    sendBackAsks.insert({ ...row, fromStage: from, toStage: to }),
})
