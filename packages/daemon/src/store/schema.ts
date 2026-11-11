import { Events, makeSchema, Schema, State } from '@livestore/livestore'
import { counted } from './progress.ts'

export const factories = State.SQLite.table({
  name: 'factories',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    key: State.SQLite.text(),
    name: State.SQLite.text(),
    repo: State.SQLite.text(),
    cloneUrl: State.SQLite.text(),
    defaultBranch: State.SQLite.text(),
    showTutorial: State.SQLite.boolean({ default: false }),
    autoStartBacklog: State.SQLite.boolean({ default: false }),
    clonedAt: State.SQLite.text({ nullable: true }),
    createdAt: State.SQLite.text(),
  },
})

export const factoryRepos = State.SQLite.table({
  name: 'factoryRepos',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    factoryId: State.SQLite.text(),
    position: State.SQLite.integer(),
    repo: State.SQLite.text(),
    name: State.SQLite.text(),
    cloneUrl: State.SQLite.text(),
  },
})

export const taskDrafts = State.SQLite.table({
  name: 'taskDrafts',
  columns: {
    factoryId: State.SQLite.text({ primaryKey: true }),
    draft: State.SQLite.text({ nullable: true }),
    clearedRevision: State.SQLite.text({ nullable: true }),
  },
})

export const taskDraftConsumptions = State.SQLite.table({
  name: 'taskDraftConsumptions',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    factoryId: State.SQLite.text(),
    revision: State.SQLite.text(),
  },
})

export const factoryOrder = State.SQLite.table({
  name: 'factoryOrder',
  columns: {
    factoryId: State.SQLite.text({ primaryKey: true }),
    position: State.SQLite.integer(),
  },
})

export const tasks = State.SQLite.table({
  name: 'tasks',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    factoryId: State.SQLite.text(),
    number: State.SQLite.integer(),
    title: State.SQLite.text(),
    description: State.SQLite.text({ default: '' }),
    priority: State.SQLite.text({ default: 'none' }),
    clarifyDepth: State.SQLite.text({ default: 'auto' }),
    clarifyDepthBy: State.SQLite.text({ nullable: true }),
    leadAgent: State.SQLite.text({ nullable: true }),
    leadModel: State.SQLite.text({ nullable: true }),
    leadEffort: State.SQLite.text({ nullable: true }),
    snoozedUntil: State.SQLite.text({ nullable: true }),
    leadEffortMode: State.SQLite.text({ nullable: true }),
    stageEffort: State.SQLite.text({ nullable: true }),
    pendingLeadMessage: State.SQLite.text({ nullable: true }),
    pendingLeadDeliveries: State.SQLite.text({ nullable: true }),
    leadRestartPending: State.SQLite.boolean({ default: false }),
    startRequested: State.SQLite.boolean({ default: false }),
    waitsForBlockers: State.SQLite.boolean({ default: false }),
    stage: State.SQLite.text({ default: 'backlog' }),
    branch: State.SQLite.text({ nullable: true }),
    worktree: State.SQLite.text({ nullable: true }),
    chosenRepos: State.SQLite.text({ nullable: true }),
    activity: State.SQLite.text({ nullable: true }),
    activityEntries: State.SQLite.integer({ nullable: true }),
    rank: State.SQLite.real({ nullable: true }),
    changedAt: State.SQLite.text({ nullable: true }),
    archivedAt: State.SQLite.text({ nullable: true }),
    stoppedAt: State.SQLite.text({ nullable: true }),
    stoppedRuns: State.SQLite.integer({ nullable: true }),
    stoppedWhy: State.SQLite.text({ nullable: true }),
    failedAt: State.SQLite.text({ nullable: true }),
    followUpOf: State.SQLite.text({ nullable: true }),
    forcedGates: State.SQLite.text({ nullable: true }),
    gateOverrides: State.SQLite.text({ nullable: true }),
    changesSettings: State.SQLite.boolean({ default: false }),
    splitFrom: State.SQLite.text({ nullable: true }),
    needsPlanningAt: State.SQLite.text({ nullable: true }),
    partlyMergedAt: State.SQLite.text({ nullable: true }),
    setup: State.SQLite.boolean({ default: false }),
    createdAt: State.SQLite.text(),
  },
})

export const taskQueue = State.SQLite.table({
  name: 'taskQueue',
  columns: {
    taskId: State.SQLite.text({ primaryKey: true }),
    rank: State.SQLite.real(),
    queuedAt: State.SQLite.text(),
  },
})

export const taskBlockers = State.SQLite.table({
  name: 'taskBlockers',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    blockerId: State.SQLite.text(),
    setByRunId: State.SQLite.text({ nullable: true }),
    at: State.SQLite.text(),
  },
})

export const deletedTasks = State.SQLite.table({
  name: 'deletedTasks',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    factoryId: State.SQLite.text(),
    number: State.SQLite.integer(),
    at: State.SQLite.text(),
  },
})

export const taskAttachments = State.SQLite.table({
  name: 'taskAttachments',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    hash: State.SQLite.text(),
    name: State.SQLite.text(),
    size: State.SQLite.integer(),
    mediaType: State.SQLite.text(),
    at: State.SQLite.text(),
  },
})

export const commentAttachments = State.SQLite.table({
  name: 'commentAttachments',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    commentId: State.SQLite.text(),
    taskId: State.SQLite.text(),
    hash: State.SQLite.text(),
    name: State.SQLite.text(),
    size: State.SQLite.integer(),
    mediaType: State.SQLite.text(),
    position: State.SQLite.integer(),
  },
})

export const taskSources = State.SQLite.table({
  name: 'taskSources',
  columns: {
    taskId: State.SQLite.text({ primaryKey: true }),
    url: State.SQLite.text(),
    linearIdentifier: State.SQLite.text({ nullable: true }),
    linearTitle: State.SQLite.text({ nullable: true }),
    linearBranchName: State.SQLite.text({ nullable: true }),
    linearDescription: State.SQLite.text({ nullable: true }),
    sentryShortId: State.SQLite.text({ nullable: true }),
    at: State.SQLite.text(),
  },
})

export const runs = State.SQLite.table({
  name: 'runs',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    agent: State.SQLite.text(),
    sessionId: State.SQLite.text(),
    model: State.SQLite.text({ nullable: true }),
    effort: State.SQLite.text({ nullable: true }),
    usesDefaultModel: State.SQLite.boolean({ default: false }),
    problem: State.SQLite.text({ nullable: true }),
    permissions: State.SQLite.text({ default: 'auto' }),
    manualPermissions: State.SQLite.boolean({ default: false }),
    prompt: State.SQLite.text(),
    cwd: State.SQLite.text(),
    taskId: State.SQLite.text({ nullable: true }),
    parentRunId: State.SQLite.text({ nullable: true }),
    name: State.SQLite.text({ nullable: true }),
    failure: State.SQLite.text({ nullable: true }),
    state: State.SQLite.text(),
    readOffset: State.SQLite.integer(),
    lastOutputAt: State.SQLite.text({ nullable: true }),
    startedAt: State.SQLite.text(),
    revivedAt: State.SQLite.text({ nullable: true }),
    ended: State.SQLite.text({ nullable: true }),
    retrying: State.SQLite.boolean({ default: false }),
    steeringRelease: State.SQLite.text({ nullable: true }),
  },
})

export const subAgentRequests = State.SQLite.table({
  name: 'subAgentRequests',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    parentRunId: State.SQLite.text(),
    name: State.SQLite.text(),
    agent: State.SQLite.text(),
    model: State.SQLite.text({ nullable: true }),
    effort: State.SQLite.text({ nullable: true }),
    prompt: State.SQLite.text(),
    ownWorktree: State.SQLite.boolean({ default: false }),
    at: State.SQLite.text(),
  },
})

export const reviewers = State.SQLite.table({
  name: 'reviewers',
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

export const loopChecks = State.SQLite.table({
  name: 'loopChecks',
  columns: {
    runId: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    toStage: State.SQLite.text(),
    findings: State.SQLite.text(),
    checkRunId: State.SQLite.text({ nullable: true }),
    round: State.SQLite.integer(),
    limit: State.SQLite.integer({ nullable: true }),
    verdict: State.SQLite.text({ nullable: true }),
    at: State.SQLite.text(),
  },
})

export const sendBackAsks = State.SQLite.table({
  name: 'sendBackAsks',
  columns: {
    commentId: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    fromStage: State.SQLite.text(),
    toStage: State.SQLite.text(),
    findings: State.SQLite.text(),
    checkRunId: State.SQLite.text({ nullable: true }),
    loop: State.SQLite.boolean(),
    at: State.SQLite.text(),
  },
})

export const runMessages = State.SQLite.table({
  name: 'runMessages',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    runId: State.SQLite.text(),
    text: State.SQLite.text(),
    at: State.SQLite.text(),
    queued: State.SQLite.boolean({ default: false }),
    fromTed: State.SQLite.boolean({ default: false }),
    deletedAt: State.SQLite.text({ nullable: true }),
  },
})

export const runInterrupts = State.SQLite.table({
  name: 'runInterrupts',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    runId: State.SQLite.text(),
    hold: State.SQLite.boolean({ default: false }),
    at: State.SQLite.text(),
  },
})

export const conversationTabs = State.SQLite.table({
  name: 'conversationTabs',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    runId: State.SQLite.text(),
    openedAt: State.SQLite.text(),
  },
})

export const comments = State.SQLite.table({
  name: 'comments',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    kind: State.SQLite.text(),
    body: State.SQLite.text(),
    authorKind: State.SQLite.text({ default: 'run' }),
    authorRunId: State.SQLite.text({ nullable: true }),
    stage: State.SQLite.text({ nullable: true }),
    title: State.SQLite.text({ nullable: true }),
    choices: State.SQLite.text({ nullable: true }),
    round: State.SQLite.text({ nullable: true }),
    proposal: State.SQLite.text({ nullable: true }),
    sizeCheck: State.SQLite.text({ nullable: true }),
    gate: State.SQLite.text({ nullable: true }),
    permission: State.SQLite.text({ nullable: true }),
    simulator: State.SQLite.text({ nullable: true }),
    answer: State.SQLite.text({ nullable: true }),
    deliveredRunId: State.SQLite.text({ nullable: true }),
    deliveredAt: State.SQLite.text({ nullable: true }),
    readAt: State.SQLite.text({ nullable: true }),
    answerHeld: State.SQLite.boolean({ default: false }),
    failedRunId: State.SQLite.text({ nullable: true }),
    talkRunId: State.SQLite.text({ nullable: true }),
    talkStartedAt: State.SQLite.text({ nullable: true }),
    talkDoneAt: State.SQLite.text({ nullable: true }),
    design: State.SQLite.text({ nullable: true }),
    tutorial: State.SQLite.boolean({ default: false }),
    linearTeam: State.SQLite.text({ nullable: true }),
    createdAt: State.SQLite.text(),
  },
})

export const lineComments = State.SQLite.table({
  name: 'lineComments',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    repo: State.SQLite.text(),
    path: State.SQLite.text(),
    side: State.SQLite.text(),
    start: State.SQLite.integer(),
    end: State.SQLite.integer(),
    commit: State.SQLite.text(),
    quoted: State.SQLite.text(),
    body: State.SQLite.text(),
    createdAt: State.SQLite.text(),
    editedAt: State.SQLite.text({ nullable: true }),
    commentId: State.SQLite.text({ nullable: true }),
    sentAt: State.SQLite.text({ nullable: true }),
    deleted: State.SQLite.boolean({ default: false }),
  },
})

export const taskLog = State.SQLite.table({
  name: 'taskLog',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    name: State.SQLite.text(),
    data: State.SQLite.text(),
    at: State.SQLite.text(),
  },
})

export const peerMessages = State.SQLite.table({
  name: 'peerMessages',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    factoryId: State.SQLite.text(),
    senderTaskId: State.SQLite.text(),
    senderRunId: State.SQLite.text(),
    recipientTaskId: State.SQLite.text(),
    operation: State.SQLite.text(),
    text: State.SQLite.text(),
    createdAt: State.SQLite.text(),
  },
})

export const taskBriefs = State.SQLite.table({
  name: 'taskBriefs',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    version: State.SQLite.integer(),
    text: State.SQLite.text(),
    stage: State.SQLite.text(),
    runId: State.SQLite.text({ nullable: true }),
    createdAt: State.SQLite.text(),
  },
})

export const taskDescriptions = State.SQLite.table({
  name: 'taskDescriptions',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    version: State.SQLite.integer(),
    text: State.SQLite.text(),
    at: State.SQLite.text(),
  },
})

export const sendBacks = State.SQLite.table({
  name: 'sendBacks',
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
    at: State.SQLite.text(),
  },
})

export const failureCases = State.SQLite.table({
  name: 'failureCases',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    data: State.SQLite.text(),
    at: State.SQLite.text(),
  },
})
export const validationProgress = State.SQLite.table({
  name: 'validationProgress',
  columns: {
    taskId: State.SQLite.text({ primaryKey: true }),
    data: State.SQLite.text(),
  },
})
export const failureContexts = State.SQLite.table({
  name: 'failureContexts',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    data: State.SQLite.text(),
    at: State.SQLite.text(),
  },
})

export const checkRuns = State.SQLite.table({
  name: 'checkRuns',
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

export const checkResults = State.SQLite.table({
  name: 'checkResults',
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
  },
})

export const sendBackResets = State.SQLite.table({
  name: 'sendBackResets',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    stage: State.SQLite.text(),
    at: State.SQLite.text(),
  },
})

export const machineSettings = State.SQLite.table({
  name: 'machineSettings',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    appearance: State.SQLite.text(),
  },
})

export const machineSettingValues = State.SQLite.table({
  name: 'machineSettingValues',
  columns: {
    name: State.SQLite.text({ primaryKey: true }),
    value: State.SQLite.text(),
  },
})

export const stageEntries = State.SQLite.table({
  name: 'stageEntries',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    taskId: State.SQLite.text(),
    stage: State.SQLite.text(),
    stageFileLayer: State.SQLite.text({ nullable: true }),
    stageFilePath: State.SQLite.text({ nullable: true }),
    layers: State.SQLite.text(),
    order: State.SQLite.text({ nullable: true }),
    at: State.SQLite.text(),
  },
})

export const workflowLayers = State.SQLite.table({
  name: 'workflowLayers',
  columns: {
    layer: State.SQLite.text({ primaryKey: true }),
    files: State.SQLite.text(),
    version: State.SQLite.text(),
    acceptedAt: State.SQLite.text(),
  },
})

export const stageFileTexts = State.SQLite.table({
  name: 'stageFileTexts',
  columns: {
    hash: State.SQLite.text({ primaryKey: true }),
    layer: State.SQLite.text(),
    stage: State.SQLite.text(),
    text: State.SQLite.text(),
    tedVersion: State.SQLite.text(),
    seenAt: State.SQLite.text(),
  },
})

export const banners = State.SQLite.table({
  name: 'banners',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    problem: State.SQLite.text(),
    severity: State.SQLite.text(),
    factoryId: State.SQLite.text({ nullable: true }),
    text: State.SQLite.text(),
    action: State.SQLite.text({ nullable: true }),
    raisedAt: State.SQLite.text(),
    dismissedUntil: State.SQLite.text({ nullable: true }),
  },
})

export const taskRepos = State.SQLite.table({
  name: 'taskRepos',
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

export const localFolders = State.SQLite.table({
  name: 'localFolders',
  columns: {
    repo: State.SQLite.text({ primaryKey: true }),
    path: State.SQLite.text(),
    setAt: State.SQLite.text(),
  },
})

export const agentPauses = State.SQLite.table({
  name: 'agentPauses',
  columns: {
    agent: State.SQLite.text({ primaryKey: true }),
    reason: State.SQLite.text(),
    since: State.SQLite.text(),
  },
})

export const heldRuns = State.SQLite.table({
  name: 'heldRuns',
  columns: {
    taskId: State.SQLite.text({ primaryKey: true }),
    agent: State.SQLite.text(),
    sessionId: State.SQLite.text({ nullable: true }),
    at: State.SQLite.text(),
  },
})

export const automations = State.SQLite.table({
  name: 'automations',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    factoryId: State.SQLite.text(),
    name: State.SQLite.text(),
    prompt: State.SQLite.text(),
    schedule: State.SQLite.text(),
    timeZone: State.SQLite.text(),
    agent: State.SQLite.text(),
    model: State.SQLite.text({ nullable: true }),
    effort: State.SQLite.text({ nullable: true }),
    on: State.SQLite.boolean(),
    template: State.SQLite.text({ nullable: true }),
    handledUntil: State.SQLite.text(),
    createdAt: State.SQLite.text(),
  },
})

export const automationPromptDrafts = State.SQLite.table({
  name: 'automationPromptDrafts',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    factoryId: State.SQLite.text(),
    input: State.SQLite.text(),
    state: State.SQLite.text(),
    prompt: State.SQLite.text({ nullable: true }),
    error: State.SQLite.text({ nullable: true }),
    createdAt: State.SQLite.text(),
    updatedAt: State.SQLite.text(),
  },
})

export const automationFirings = State.SQLite.table({
  name: 'automationFirings',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    automationId: State.SQLite.text(),
    trigger: State.SQLite.text(),
    slotAt: State.SQLite.text({ nullable: true }),
    retryOf: State.SQLite.text({ nullable: true }),
    retriedAt: State.SQLite.text({ nullable: true }),
    state: State.SQLite.text(),
    at: State.SQLite.text(),
    startedAt: State.SQLite.text({ nullable: true }),
    resume: State.SQLite.text({ nullable: true }),
    outcome: State.SQLite.text({ nullable: true }),
    error: State.SQLite.text({ nullable: true }),
    message: State.SQLite.text({ nullable: true }),
    finishedAt: State.SQLite.text({ nullable: true }),
  },
})

export const automationTasks = State.SQLite.table({
  name: 'automationTasks',
  columns: {
    taskId: State.SQLite.text({ primaryKey: true }),
    automationId: State.SQLite.text(),
    firingId: State.SQLite.text(),
    at: State.SQLite.text(),
  },
})

export const automationComments = State.SQLite.table({
  name: 'automationComments',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    automationId: State.SQLite.text(),
    firingId: State.SQLite.text(),
    kind: State.SQLite.text(),
    body: State.SQLite.text(),
    choices: State.SQLite.text({ nullable: true }),
    answer: State.SQLite.text({ nullable: true }),
    answeredAt: State.SQLite.text({ nullable: true }),
    createdAt: State.SQLite.text(),
  },
})

export const sideChats = State.SQLite.table({
  name: 'sideChats',
  columns: { sourceRunId: State.SQLite.text({ primaryKey: true }), data: State.SQLite.text() },
})

export const coordinators = State.SQLite.table({
  name: 'coordinators',
  columns: {
    factoryId: State.SQLite.text({ primaryKey: true }),
    data: State.SQLite.text(),
  },
})

export const plans = State.SQLite.table({
  name: 'plans',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    factoryId: State.SQLite.text(),
    title: State.SQLite.text(),
    message: State.SQLite.text(),
    agent: State.SQLite.text(),
    model: State.SQLite.text({ nullable: true }),
    effort: State.SQLite.text({ nullable: true }),
    state: State.SQLite.text(),
    resume: State.SQLite.text({ nullable: true }),
    outcome: State.SQLite.text({ nullable: true }),
    error: State.SQLite.text({ nullable: true }),
    checkout: State.SQLite.text({ nullable: true }),
    createdAt: State.SQLite.text(),
    startedAt: State.SQLite.text({ nullable: true }),
    finishedAt: State.SQLite.text({ nullable: true }),
    fromPlanId: State.SQLite.text({ nullable: true }),
    fromPlanTitle: State.SQLite.text({ nullable: true }),
    context: State.SQLite.text({ nullable: true }),
    fromTaskId: State.SQLite.text({ nullable: true }),
    fromTaskDisplayId: State.SQLite.text({ nullable: true }),
    fromTaskTitle: State.SQLite.text({ nullable: true }),
    sizeCheckId: State.SQLite.text({ nullable: true }),
    fromTaskGone: State.SQLite.text({ nullable: true }),
  },
})

export const planRequests = State.SQLite.table({
  name: 'planRequests',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    planId: State.SQLite.text(),
    runId: State.SQLite.text(),
    kind: State.SQLite.text(),
    author: State.SQLite.text(),
    title: State.SQLite.text({ nullable: true }),
    body: State.SQLite.text(),
    round: State.SQLite.text({ nullable: true }),
    proposal: State.SQLite.text({ nullable: true }),
    answer: State.SQLite.text({ nullable: true }),
    createdAt: State.SQLite.text(),
  },
})

export const planTasks = State.SQLite.table({
  name: 'planTasks',
  columns: {
    taskId: State.SQLite.text({ primaryKey: true }),
    planId: State.SQLite.text(),
    row: State.SQLite.integer(),
    at: State.SQLite.text(),
  },
})

const stageEnteredFields = {
  id: Schema.String,
  taskId: Schema.String,
  stage: Schema.String,
  stageFileLayer: Schema.NullOr(Schema.String),
  stageFilePath: Schema.NullOr(Schema.String),
  layers: Schema.String,
  at: Schema.String,
}

const runStartedFields = {
  id: Schema.String,
  agent: Schema.String,
  sessionId: Schema.String,
  prompt: Schema.String,
  cwd: Schema.String,
  startedAt: Schema.String,
}

const gitHubNotice = Schema.Struct({
  key: Schema.String,
  sig: Schema.String,
  kind: Schema.String,
  where: Schema.String,
})

export const events = {
  sideChatChanged: Events.synced({
    name: 'v1.SideChatChanged',
    schema: Schema.Struct({ sourceRunId: Schema.String, data: Schema.String }),
  }),
  sideChatRemoved: Events.synced({
    name: 'v1.SideChatRemoved',
    schema: Schema.Struct({ sourceRunId: Schema.String, runId: Schema.String }),
  }),
  coordinatorChanged: Events.synced({
    name: 'v1.CoordinatorChanged',
    schema: Schema.Struct({ factoryId: Schema.String, data: Schema.String }),
  }),
  coordinatorRemoved: Events.synced({
    name: 'v1.CoordinatorRemoved',
    schema: Schema.Struct({ factoryId: Schema.String, runIds: Schema.Array(Schema.String) }),
  }),
  validationProgressed: Events.synced({
    name: 'v1.ValidationProgressed',
    schema: Schema.Struct({ taskId: Schema.String, data: Schema.String }),
  }),
  failureVerified: Events.synced({
    name: 'v1.FailureVerified',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      data: Schema.String,
      at: Schema.String,
    }),
  }),
  failureContextCaptured: Events.synced({
    name: 'v1.FailureContextCaptured',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      data: Schema.String,
      at: Schema.String,
    }),
  }),
  failureCaseRecorded: Events.synced({
    name: 'v1.FailureCaseRecorded',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      data: Schema.String,
      at: Schema.String,
    }),
  }),
  failureAssessed: Events.synced({
    name: 'v1.FailureAssessed',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      data: Schema.String,
      at: Schema.String,
    }),
  }),
  failureEvidenceAdded: Events.synced({
    name: 'v1.FailureEvidenceAdded',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      data: Schema.String,
      at: Schema.String,
    }),
  }),
  failureDecisionRequested: Events.synced({
    name: 'v1.FailureDecisionRequested',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      data: Schema.String,
      at: Schema.String,
    }),
  }),
  failureResolved: Events.synced({
    name: 'v1.FailureResolved',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      data: Schema.String,
      at: Schema.String,
    }),
  }),
  failureAcceptanceInvalidated: Events.synced({
    name: 'v1.FailureAcceptanceInvalidated',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      data: Schema.String,
      at: Schema.String,
    }),
  }),

  factoryAdded: Events.synced({
    name: 'v1.FactoryAdded',
    schema: Schema.Struct({
      id: Schema.String,
      key: Schema.String,
      name: Schema.String,
      repo: Schema.String,
      cloneUrl: Schema.String,
      defaultBranch: Schema.String,
      createdAt: Schema.String,
    }),
  }),
  factoryAddedV2: Events.synced({
    name: 'v2.FactoryAdded',
    schema: Schema.Struct({
      id: Schema.String,
      key: Schema.String,
      name: Schema.String,
      repos: Schema.Array(
        Schema.Struct({ repo: Schema.String, name: Schema.String, cloneUrl: Schema.String }),
      ),
      defaultBranch: Schema.String,
      showTutorial: Schema.Boolean,
      createdAt: Schema.String,
    }),
  }),
  factoryCloned: Events.synced({
    name: 'v1.FactoryCloned',
    schema: Schema.Struct({ factoryId: Schema.String, at: Schema.String }),
  }),
  taskCreated: Events.synced({
    name: 'v1.TaskCreated',
    schema: Schema.Struct({
      id: Schema.String,
      factoryId: Schema.String,
      number: Schema.Number,
      title: Schema.String,
      createdAt: Schema.String,
    }),
  }),
  taskCreatedV2: Events.synced({
    name: 'v2.TaskCreated',
    schema: Schema.Struct({
      id: Schema.String,
      factoryId: Schema.String,
      number: Schema.Number,
      title: Schema.String,
      description: Schema.String,
      priority: Schema.String,
      clarifyDepth: Schema.String,
      leadAgent: Schema.NullOr(Schema.String),
      leadModel: Schema.NullOr(Schema.String),
      leadEffort: Schema.NullOr(Schema.String),
      startRequested: Schema.Boolean,
      createdAt: Schema.String,
    }),
  }),
  taskBlockerAdded: Events.synced({
    name: 'v1.TaskBlockerAdded',
    schema: Schema.Struct({ taskId: Schema.String, blockerId: Schema.String, at: Schema.String }),
  }),
  taskBlockerAddedV2: Events.synced({
    name: 'v2.TaskBlockerAdded',
    schema: Schema.Struct({
      taskId: Schema.String,
      blockerId: Schema.String,
      runId: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  taskBlockerRemoved: Events.synced({
    name: 'v1.TaskBlockerRemoved',
    schema: Schema.Struct({
      taskId: Schema.String,
      blockerId: Schema.String,
      runId: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  taskSnoozed: Events.synced({
    name: 'v1.TaskSnoozed',
    schema: Schema.Struct({ taskId: Schema.String, until: Schema.String, at: Schema.String }),
  }),
  taskSnoozeCleared: Events.synced({
    name: 'v1.TaskSnoozeCleared',
    schema: Schema.Struct({ taskId: Schema.String, at: Schema.String }),
  }),
  taskStartRequestChanged: Events.synced({
    name: 'v1.TaskStartRequestChanged',
    schema: Schema.Struct({
      taskId: Schema.String,
      startRequested: Schema.Boolean,
      at: Schema.String,
    }),
  }),
  taskWaitingForBlockers: Events.synced({
    name: 'v1.TaskWaitingForBlockers',
    schema: Schema.Struct({ taskId: Schema.String, at: Schema.String }),
  }),
  taskRequeuedAfterBlockers: Events.synced({
    name: 'v1.TaskRequeuedAfterBlockers',
    schema: Schema.Struct({ taskId: Schema.String, rank: Schema.Number, at: Schema.String }),
  }),
  taskStopped: Events.synced({
    name: 'v1.TaskStopped',
    schema: Schema.Struct({
      taskId: Schema.String,
      runs: Schema.Number,
      why: Schema.String,
      at: Schema.String,
    }),
  }),
  taskResumed: Events.synced({
    name: 'v1.TaskResumed',
    schema: Schema.Struct({ taskId: Schema.String, rank: Schema.Number, at: Schema.String }),
  }),
  taskLeadNudged: Events.synced({
    name: 'v1.TaskLeadNudged',
    schema: Schema.Struct({ taskId: Schema.String, runId: Schema.String, at: Schema.String }),
  }),
  appStarted: Events.synced({
    name: 'v1.AppStarted',
    schema: Schema.Struct({
      taskId: Schema.String,
      repo: Schema.String,
      name: Schema.String,
      port: Schema.NullOr(Schema.Number),
      url: Schema.NullOr(Schema.String),
      by: Schema.String,
      runId: Schema.NullOr(Schema.String),
      restart: Schema.Boolean,
      at: Schema.String,
    }),
  }),
  appStopped: Events.synced({
    name: 'v1.AppStopped',
    schema: Schema.Struct({
      taskId: Schema.String,
      repo: Schema.String,
      name: Schema.String,
      at: Schema.String,
    }),
  }),
  appExited: Events.synced({
    name: 'v1.AppExited',
    schema: Schema.Struct({
      taskId: Schema.String,
      repo: Schema.String,
      name: Schema.String,
      code: Schema.NullOr(Schema.Number),
      signal: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  simulatorRequested: Events.synced({
    name: 'v1.SimulatorRequested',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      runId: Schema.String,
      stage: Schema.NullOr(Schema.String),
      title: Schema.String,
      body: Schema.String,
      simulator: Schema.String,
      createdAt: Schema.String,
    }),
  }),
  simulatorShutDown: Events.synced({
    name: 'v1.SimulatorShutDown',
    schema: Schema.Struct({
      taskId: Schema.String,
      repo: Schema.String,
      name: Schema.String,
      forTask: Schema.NullOr(Schema.String),
      idle: Schema.Boolean,
      at: Schema.String,
    }),
  }),
  appStartFailed: Events.synced({
    name: 'v1.AppStartFailed',
    schema: Schema.Struct({
      taskId: Schema.String,
      repo: Schema.String,
      name: Schema.String,
      problem: Schema.String,
      at: Schema.String,
    }),
  }),
  taskAttachmentAdded: Events.synced({
    name: 'v1.TaskAttachmentAdded',
    schema: Schema.Struct({
      taskId: Schema.String,
      hash: Schema.String,
      name: Schema.String,
      size: Schema.Number,
      mediaType: Schema.String,
      at: Schema.String,
    }),
  }),
  commentAttachmentAdded: Events.synced({
    name: 'v1.CommentAttachmentAdded',
    schema: Schema.Struct({
      commentId: Schema.String,
      taskId: Schema.String,
      hash: Schema.String,
      name: Schema.String,
      size: Schema.Number,
      mediaType: Schema.String,
      position: Schema.Number,
    }),
  }),
  commentDesignAttached: Events.synced({
    name: 'v1.CommentDesignAttached',
    schema: Schema.Struct({ commentId: Schema.String, design: Schema.String }),
  }),
  taskFollowsUp: Events.synced({
    name: 'v1.TaskFollowsUp',
    schema: Schema.Struct({ taskId: Schema.String, originalId: Schema.String, at: Schema.String }),
  }),
  taskGatesChanged: Events.synced({
    name: 'v1.TaskGatesChanged',
    schema: Schema.Struct({ taskId: Schema.String, overrides: Schema.String, at: Schema.String }),
  }),
  taskGatesForced: Events.synced({
    name: 'v1.TaskGatesForced',
    schema: Schema.Struct({
      taskId: Schema.String,
      stages: Schema.Array(Schema.String),
      at: Schema.String,
    }),
  }),
  taskChangesSettings: Events.synced({
    name: 'v1.TaskChangesSettings',
    schema: Schema.Struct({ taskId: Schema.String, at: Schema.String }),
  }),
  stageFileTextSeen: Events.synced({
    name: 'v1.StageFileTextSeen',
    schema: Schema.Struct({
      hash: Schema.String,
      layer: Schema.String,
      stage: Schema.String,
      text: Schema.String,
      tedVersion: Schema.String,
      at: Schema.String,
    }),
  }),
  taskFollowedUp: Events.synced({
    name: 'v1.TaskFollowedUp',
    schema: Schema.Struct({ taskId: Schema.String, followUpId: Schema.String, at: Schema.String }),
  }),
  taskSourceSet: Events.synced({
    name: 'v1.TaskSourceSet',
    schema: Schema.Struct({
      taskId: Schema.String,
      url: Schema.String,
      linearIdentifier: Schema.NullOr(Schema.String),
      linearTitle: Schema.NullOr(Schema.String),
      linearBranchName: Schema.NullOr(Schema.String),
      linearDescription: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  taskSourceSentrySet: Events.synced({
    name: 'v1.TaskSourceSentrySet',
    schema: Schema.Struct({ taskId: Schema.String, shortId: Schema.String, at: Schema.String }),
  }),
  taskStarted: Events.synced({
    name: 'v1.TaskStarted',
    schema: Schema.Struct({
      taskId: Schema.String,
      stage: Schema.String,
      branch: Schema.String,
      worktree: Schema.String,
      at: Schema.String,
    }),
  }),
  taskQueued: Events.synced({
    name: 'v1.TaskQueued',
    schema: Schema.Struct({
      taskId: Schema.String,
      stage: Schema.String,
      rank: Schema.Number,
      at: Schema.String,
    }),
  }),
  taskDequeued: Events.synced({
    name: 'v1.TaskDequeued',
    schema: Schema.Struct({ taskId: Schema.String, at: Schema.String }),
  }),
  taskMovedToBacklog: Events.synced({
    name: 'v1.TaskMovedToBacklog',
    schema: Schema.Struct({ taskId: Schema.String, at: Schema.String }),
  }),
  taskRanked: Events.synced({
    name: 'v1.TaskRanked',
    schema: Schema.Struct({ taskId: Schema.String, rank: Schema.Number, at: Schema.String }),
  }),
  taskPriorityChanged: Events.synced({
    name: 'v1.TaskPriorityChanged',
    schema: Schema.Struct({ taskId: Schema.String, priority: Schema.String, at: Schema.String }),
  }),
  taskArchived: Events.synced({
    name: 'v1.TaskArchived',
    schema: Schema.Struct({ taskId: Schema.String, at: Schema.String }),
  }),
  taskArchivedV2: Events.synced({
    name: 'v2.TaskArchived',
    schema: Schema.Struct({
      taskId: Schema.String,
      closing: Schema.Array(Schema.String),
      branches: Schema.Number,
      at: Schema.String,
    }),
  }),
  taskArchivedV3: Events.synced({
    name: 'v3.TaskArchived',
    schema: Schema.Struct({
      taskId: Schema.String,
      closing: Schema.Array(Schema.String),
      branches: Schema.Number,
      why: Schema.String,
      at: Schema.String,
    }),
  }),
  linearIssueSeen: Events.synced({
    name: 'v1.LinearIssueSeen',
    schema: Schema.Struct({
      taskId: Schema.String,
      identifier: Schema.String,
      stateType: Schema.String,
      state: Schema.String,
      team: Schema.String,
      at: Schema.String,
    }),
  }),
  linearIssueMoved: Events.synced({
    name: 'v1.LinearIssueMoved',
    schema: Schema.Struct({
      taskId: Schema.String,
      identifier: Schema.String,
      step: Schema.String,
      state: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  linearSyncAllowed: Events.synced({
    name: 'v1.LinearSyncAllowed',
    schema: Schema.Struct({
      taskId: Schema.String,
      identifier: Schema.String,
      by: Schema.String,
      at: Schema.String,
    }),
  }),
  linearTeamSyncAllowed: Events.synced({
    name: 'v1.LinearTeamSyncAllowed',
    schema: Schema.Struct({
      taskId: Schema.String,
      identifier: Schema.String,
      team: Schema.String,
      at: Schema.String,
    }),
  }),
  linearPullRequestsLinked: Events.synced({
    name: 'v1.LinearPullRequestsLinked',
    schema: Schema.Struct({
      taskId: Schema.String,
      identifier: Schema.String,
      urls: Schema.Array(Schema.String),
      at: Schema.String,
    }),
  }),
  taskUnarchived: Events.synced({
    name: 'v1.TaskUnarchived',
    schema: Schema.Struct({
      taskId: Schema.String,
      rank: Schema.NullOr(Schema.Number),
      at: Schema.String,
    }),
  }),
  taskDeleted: Events.synced({
    name: 'v1.TaskDeleted',
    schema: Schema.Struct({
      taskId: Schema.String,
      factoryId: Schema.String,
      number: Schema.Number,
      runIds: Schema.Array(Schema.String),
      checkRunIds: Schema.Array(Schema.String),
      at: Schema.String,
    }),
  }),
  taskEdited: Events.synced({
    name: 'v1.TaskEdited',
    schema: Schema.Struct({
      taskId: Schema.String,
      title: Schema.NullOr(Schema.String),
      description: Schema.NullOr(Schema.String),
      version: Schema.NullOr(Schema.Number),
      previous: Schema.NullOr(Schema.String),
      previousAt: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  taskStageChanged: Events.synced({
    name: 'v1.TaskStageChanged',
    schema: Schema.Struct({ taskId: Schema.String, stage: Schema.String, at: Schema.String }),
  }),
  commentPosted: Events.synced({
    name: 'v1.CommentPosted',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      kind: Schema.String,
      body: Schema.String,
      authorRunId: Schema.String,
      createdAt: Schema.String,
    }),
  }),
  commentPostedV2: Events.synced({
    name: 'v2.CommentPosted',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      kind: Schema.String,
      body: Schema.String,
      authorKind: Schema.String,
      authorRunId: Schema.NullOr(Schema.String),
      stage: Schema.NullOr(Schema.String),
      title: Schema.NullOr(Schema.String),
      choices: Schema.NullOr(Schema.Array(Schema.String)),
      gate: Schema.NullOr(Schema.String),
      createdAt: Schema.String,
    }),
  }),
  commentPostedV3: Events.synced({
    name: 'v3.CommentPosted',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      kind: Schema.String,
      body: Schema.String,
      authorKind: Schema.String,
      authorRunId: Schema.NullOr(Schema.String),
      stage: Schema.NullOr(Schema.String),
      title: Schema.NullOr(Schema.String),
      choices: Schema.NullOr(Schema.Array(Schema.String)),
      round: Schema.NullOr(Schema.String),
      gate: Schema.NullOr(Schema.String),
      createdAt: Schema.String,
    }),
  }),
  commentPostedV4: Events.synced({
    name: 'v4.CommentPosted',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      kind: Schema.String,
      body: Schema.String,
      authorKind: Schema.String,
      authorRunId: Schema.NullOr(Schema.String),
      stage: Schema.NullOr(Schema.String),
      title: Schema.NullOr(Schema.String),
      choices: Schema.NullOr(Schema.Array(Schema.String)),
      round: Schema.NullOr(Schema.String),
      proposal: Schema.NullOr(Schema.String),
      sizeCheck: Schema.NullOr(Schema.String),
      gate: Schema.NullOr(Schema.String),
      createdAt: Schema.String,
    }),
  }),
  peerMessageSent: Events.synced({
    name: 'v1.PeerMessageSent',
    schema: Schema.Struct({
      id: Schema.String,
      factoryId: Schema.String,
      senderTaskId: Schema.String,
      senderRunId: Schema.String,
      recipientTaskId: Schema.String,
      operation: Schema.String,
      text: Schema.String,
      createdAt: Schema.String,
    }),
  }),
  taskSplitFrom: Events.synced({
    name: 'v1.TaskSplitFrom',
    schema: Schema.Struct({ taskId: Schema.String, originalId: Schema.String, at: Schema.String }),
  }),
  taskSplit: Events.synced({
    name: 'v1.TaskSplit',
    schema: Schema.Struct({
      taskId: Schema.String,
      pieceIds: Schema.Array(Schema.String),
      narrowedTo: Schema.String,
      at: Schema.String,
    }),
  }),
  taskNeedsPlanning: Events.synced({
    name: 'v1.TaskNeedsPlanning',
    schema: Schema.Struct({ taskId: Schema.String, runId: Schema.String, at: Schema.String }),
  }),
  taskStartedAfterPlanning: Events.synced({
    name: 'v1.TaskStartedAfterPlanning',
    schema: Schema.Struct({
      taskId: Schema.String,
      stage: Schema.String,
      rank: Schema.Number,
      at: Schema.String,
    }),
  }),
  clarifyDepthSet: Events.synced({
    name: 'v1.ClarifyDepthSet',
    schema: Schema.Struct({
      taskId: Schema.String,
      depth: Schema.String,
      by: Schema.String,
      runId: Schema.NullOr(Schema.String),
      why: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
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
  commentAnswered: Events.synced({
    name: 'v1.CommentAnswered',
    schema: Schema.Struct({ id: Schema.String, answer: Schema.String, at: Schema.String }),
  }),
  roundTalkStarted: Events.synced({
    name: 'v1.RoundTalkStarted',
    schema: Schema.Struct({ id: Schema.String, runId: Schema.String, at: Schema.String }),
  }),
  roundTalkDone: Events.synced({
    name: 'v1.RoundTalkDone',
    schema: Schema.Struct({ id: Schema.String, at: Schema.String }),
  }),
  taskBriefWritten: Events.synced({
    name: 'v1.TaskBriefWritten',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      version: Schema.Number,
      text: Schema.String,
      stage: Schema.String,
      runId: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
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
  gitHubActivitySent: Events.synced({
    name: 'v1.GitHubActivitySent',
    schema: Schema.Struct({
      taskId: Schema.String,
      runId: Schema.String,
      notices: Schema.Array(gitHubNotice),
      at: Schema.String,
    }),
  }),
  gitHubActivityHeld: Events.synced({
    name: 'v1.GitHubActivityHeld',
    schema: Schema.Struct({
      taskId: Schema.String,
      notices: Schema.Array(gitHubNotice),
      at: Schema.String,
    }),
  }),
  gitHubActivityQueued: Events.synced({
    name: 'v1.GitHubActivityQueued',
    schema: Schema.Struct({
      taskId: Schema.String,
      rank: Schema.Number,
      notices: Schema.Array(gitHubNotice),
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
  runStarted: Events.synced({
    name: 'v1.RunStarted',
    schema: Schema.Struct(runStartedFields),
  }),
  runStartedV2: Events.synced({
    name: 'v2.RunStarted',
    schema: Schema.Struct({ ...runStartedFields, taskId: Schema.NullOr(Schema.String) }),
  }),
  runOutputRead: Events.synced({
    name: 'v1.RunOutputRead',
    schema: Schema.Struct({
      runId: Schema.String,
      toOffset: Schema.Number,
      entries: Schema.Array(Schema.Struct({ offset: Schema.Number, line: Schema.String })),
    }),
  }),
  taskStageEntered: Events.synced({
    name: 'v1.TaskStageEntered',
    schema: Schema.Struct(stageEnteredFields),
  }),
  taskStageEnteredV3: Events.synced({
    name: 'v3.TaskStageEntered',
    schema: Schema.Struct({
      ...stageEnteredFields,
      order: Schema.String,
      effort: Schema.NullOr(Schema.String),
    }),
  }),
  taskLeadEffortModeSet: Events.synced({
    name: 'v1.TaskLeadEffortModeSet',
    schema: Schema.Struct({
      taskId: Schema.String,
      mode: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  taskLeadRestartPendingSet: Events.synced({
    name: 'v1.TaskLeadRestartPendingSet',
    schema: Schema.Struct({ taskId: Schema.String, pending: Schema.Boolean, at: Schema.String }),
  }),
  taskLeadMessageHeld: Events.synced({
    name: 'v1.TaskLeadMessageHeld',
    schema: Schema.Struct({
      taskId: Schema.String,
      text: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  taskLeadMessagesHeld: Events.synced({
    name: 'v1.TaskLeadMessagesHeld',
    schema: Schema.Struct({ taskId: Schema.String, messages: Schema.String, at: Schema.String }),
  }),
  taskStageEnteredV2: Events.synced({
    name: 'v2.TaskStageEntered',
    schema: Schema.Struct({ ...stageEnteredFields, order: Schema.String }),
  }),
  taskActivitySet: Events.synced({
    name: 'v1.TaskActivitySet',
    schema: Schema.Struct({
      taskId: Schema.String,
      text: Schema.String,
      runId: Schema.NullOr(Schema.String),
      stageEntries: Schema.Number,
      at: Schema.String,
    }),
  }),
  workflowLayerAccepted: Events.synced({
    name: 'v1.WorkflowLayerAccepted',
    schema: Schema.Struct({
      layer: Schema.String,
      files: Schema.String,
      version: Schema.String,
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
  localFolderSet: Events.synced({
    name: 'v1.LocalFolderSet',
    schema: Schema.Struct({ repo: Schema.String, path: Schema.String, at: Schema.String }),
  }),
  localFolderCleared: Events.synced({
    name: 'v1.LocalFolderCleared',
    schema: Schema.Struct({ repo: Schema.String, at: Schema.String }),
  }),
  factoryAutoStartBacklogChanged: Events.synced({
    name: 'v1.FactoryAutoStartBacklogChanged',
    schema: Schema.Struct({ factoryId: Schema.String, enabled: Schema.Boolean, at: Schema.String }),
  }),
  factoryRenamed: Events.synced({
    name: 'v1.FactoryRenamed',
    schema: Schema.Struct({ factoryId: Schema.String, name: Schema.String, at: Schema.String }),
  }),
  factoryReposChanged: Events.synced({
    name: 'v1.FactoryReposChanged',
    schema: Schema.Struct({
      factoryId: Schema.String,
      repos: Schema.Array(
        Schema.Struct({ repo: Schema.String, name: Schema.String, cloneUrl: Schema.String }),
      ),
      at: Schema.String,
    }),
  }),
  factoriesReordered: Events.synced({
    name: 'v1.FactoriesReordered',
    schema: Schema.Struct({ factoryIds: Schema.Array(Schema.String), at: Schema.String }),
  }),
  taskDraftSaved: Events.synced({
    name: 'v1.TaskDraftSaved',
    schema: Schema.Struct({ factoryId: Schema.String, draft: Schema.String, at: Schema.String }),
  }),
  taskDraftCleared: Events.synced({
    name: 'v1.TaskDraftCleared',
    schema: Schema.Struct({ factoryId: Schema.String, revision: Schema.String, at: Schema.String }),
  }),
  taskDraftSavedV2: Events.synced({
    name: 'v2.TaskDraftSaved',
    schema: Schema.Struct({
      factoryId: Schema.String,
      draft: Schema.String,
      clearedRevision: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  taskDraftConsumed: Events.synced({
    name: 'v1.TaskDraftConsumed',
    schema: Schema.Struct({
      factoryId: Schema.String,
      revision: Schema.String,
      draft: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  taskDraftRemoved: Events.synced({
    name: 'v1.TaskDraftRemoved',
    schema: Schema.Struct({ factoryId: Schema.String, at: Schema.String }),
  }),
  factoryRemoved: Events.synced({
    name: 'v1.FactoryRemoved',
    schema: Schema.Struct({ factoryId: Schema.String, at: Schema.String }),
  }),
  runStateChanged: Events.synced({
    name: 'v1.RunStateChanged',
    schema: Schema.Struct({ runId: Schema.String, state: Schema.String, at: Schema.String }),
  }),
  appearanceChanged: Events.synced({
    name: 'v1.AppearanceChanged',
    schema: Schema.Struct({ appearance: Schema.String, at: Schema.String }),
  }),
  machineSettingsChanged: Events.synced({
    name: 'v1.MachineSettingsChanged',
    schema: Schema.Struct({ changes: Schema.String, at: Schema.String }),
  }),
  bannerRaised: Events.synced({
    name: 'v1.BannerRaised',
    schema: Schema.Struct({
      id: Schema.String,
      problem: Schema.String,
      severity: Schema.String,
      factoryId: Schema.NullOr(Schema.String),
      text: Schema.String,
      action: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  bannerDismissed: Events.synced({
    name: 'v1.BannerDismissed',
    schema: Schema.Struct({ id: Schema.String, until: Schema.String, at: Schema.String }),
  }),
  bannerCleared: Events.synced({
    name: 'v1.BannerCleared',
    schema: Schema.Struct({ id: Schema.String, at: Schema.String }),
  }),
  agentPaused: Events.synced({
    name: 'v1.AgentPaused',
    schema: Schema.Struct({ agent: Schema.String, reason: Schema.String, at: Schema.String }),
  }),
  agentResumed: Events.synced({
    name: 'v1.AgentResumed',
    schema: Schema.Struct({ agent: Schema.String, at: Schema.String }),
  }),
  taskRunHeld: Events.synced({
    name: 'v1.TaskRunHeld',
    schema: Schema.Struct({
      taskId: Schema.String,
      agent: Schema.String,
      sessionId: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  taskRunReleased: Events.synced({
    name: 'v1.TaskRunReleased',
    schema: Schema.Struct({ taskId: Schema.String, at: Schema.String }),
  }),
  runSessionIdentified: Events.synced({
    name: 'v1.RunSessionIdentified',
    schema: Schema.Struct({ runId: Schema.String, sessionId: Schema.String }),
  }),
  taskLeadSet: Events.synced({
    name: 'v1.TaskLeadSet',
    schema: Schema.Struct({
      taskId: Schema.String,
      agent: Schema.String,
      model: Schema.NullOr(Schema.String),
      effort: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  runStartedV3: Events.synced({
    name: 'v3.RunStarted',
    schema: Schema.Struct({
      ...runStartedFields,
      taskId: Schema.NullOr(Schema.String),
      model: Schema.NullOr(Schema.String),
      effort: Schema.NullOr(Schema.String),
    }),
  }),
  runRestarted: Events.synced({
    name: 'v1.RunRestarted',
    schema: Schema.Struct({
      runId: Schema.String,
      model: Schema.NullOr(Schema.String),
      effort: Schema.NullOr(Schema.String),
      usesDefaultModel: Schema.Boolean,
      at: Schema.String,
    }),
  }),
  runRetryingChanged: Events.synced({
    name: 'v1.RunRetryingChanged',
    schema: Schema.Struct({ runId: Schema.String, retrying: Schema.Boolean, at: Schema.String }),
  }),
  runProblemFound: Events.synced({
    name: 'v1.RunProblemFound',
    schema: Schema.Struct({ runId: Schema.String, problem: Schema.String, at: Schema.String }),
  }),
  commentsDelivered: Events.synced({
    name: 'v1.CommentsDelivered',
    schema: Schema.Struct({
      ids: Schema.Array(Schema.String),
      runId: Schema.String,
      at: Schema.String,
    }),
  }),
  commentsRead: Events.synced({
    name: 'v1.CommentsRead',
    schema: Schema.Struct({ ids: Schema.Array(Schema.String), at: Schema.String }),
  }),
  lineCommentDrafted: Events.synced({
    name: 'v1.LineCommentDrafted',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      repo: Schema.String,
      path: Schema.String,
      side: Schema.String,
      start: Schema.Number,
      end: Schema.Number,
      commit: Schema.String,
      quoted: Schema.String,
      body: Schema.String,
      at: Schema.String,
    }),
  }),
  lineCommentEdited: Events.synced({
    name: 'v1.LineCommentEdited',
    schema: Schema.Struct({ id: Schema.String, body: Schema.String, at: Schema.String }),
  }),
  lineCommentsDeleted: Events.synced({
    name: 'v1.LineCommentsDeleted',
    schema: Schema.Struct({ ids: Schema.Array(Schema.String), at: Schema.String }),
  }),
  lineCommentsSent: Events.synced({
    name: 'v1.LineCommentsSent',
    schema: Schema.Struct({
      ids: Schema.Array(Schema.String),
      commentId: Schema.String,
      at: Schema.String,
    }),
  }),
  commentAnswerHeld: Events.synced({
    name: 'v1.CommentAnswerHeld',
    schema: Schema.Struct({ id: Schema.String, at: Schema.String }),
  }),
  commentAnswersDelivered: Events.synced({
    name: 'v1.CommentAnswersDelivered',
    schema: Schema.Struct({
      ids: Schema.Array(Schema.String),
      runId: Schema.String,
      at: Schema.String,
    }),
  }),
  runPermissionsSet: Events.synced({
    name: 'v1.RunPermissionsSet',
    schema: Schema.Struct({ runId: Schema.String, permissions: Schema.String, at: Schema.String }),
  }),
  runAutoModeUnavailable: Events.synced({
    name: 'v1.RunAutoModeUnavailable',
    schema: Schema.Struct({
      runId: Schema.String,
      taskId: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  permissionRequested: Events.synced({
    name: 'v1.PermissionRequested',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      runId: Schema.String,
      requestId: Schema.String,
      stage: Schema.NullOr(Schema.String),
      title: Schema.String,
      body: Schema.String,
      command: Schema.String,
      details: Schema.NullOr(Schema.String),
      generation: Schema.Number,
      repo: Schema.NullOr(Schema.String),
      input: Schema.NullOr(Schema.String),
      createdAt: Schema.String,
    }),
  }),
  runOutputReadV2: Events.synced({
    name: 'v2.RunOutputRead',
    schema: Schema.Struct({
      runId: Schema.String,
      toOffset: Schema.Number,
      entries: Schema.Array(
        Schema.Struct({ offset: Schema.Number, line: Schema.String, at: Schema.String }),
      ),
    }),
  }),
  runOutputReadV3: Events.synced({
    name: 'v3.RunOutputRead',
    schema: Schema.Struct({
      runId: Schema.String,
      toOffset: Schema.Number,
      lastOutputAt: Schema.NullOr(Schema.String),
    }),
  }),
  runMessageSent: Events.synced({
    name: 'v1.RunMessageSent',
    schema: Schema.Struct({
      id: Schema.String,
      runId: Schema.String,
      taskId: Schema.NullOr(Schema.String),
      lead: Schema.Boolean,
      text: Schema.String,
      at: Schema.String,
    }),
  }),
  runMessageQueued: Events.synced({
    name: 'v1.RunMessageQueued',
    schema: Schema.Struct({
      id: Schema.String,
      runId: Schema.String,
      taskId: Schema.NullOr(Schema.String),
      text: Schema.String,
      at: Schema.String,
    }),
  }),
  runMessageQueuedV2: Events.synced({
    name: 'v2.RunMessageQueued',
    schema: Schema.Struct({
      id: Schema.String,
      runId: Schema.String,
      taskId: Schema.NullOr(Schema.String),
      text: Schema.String,
      at: Schema.String,
      from: Schema.String,
    }),
  }),
  runMessageDelivered: Events.synced({
    name: 'v1.RunMessageDelivered',
    schema: Schema.Struct({
      id: Schema.String,
      runId: Schema.String,
      taskId: Schema.NullOr(Schema.String),
      lead: Schema.Boolean,
      at: Schema.String,
    }),
  }),
  runMessageDeleted: Events.synced({
    name: 'v1.RunMessageDeleted',
    schema: Schema.Struct({ id: Schema.String, runId: Schema.String, at: Schema.String }),
  }),
  runSteeringReleased: Events.synced({
    name: 'v1.RunSteeringReleased',
    schema: Schema.Struct({ runId: Schema.String, release: Schema.String }),
  }),
  runTurnInterrupted: Events.synced({
    name: 'v1.RunTurnInterrupted',
    schema: Schema.Struct({
      id: Schema.String,
      runId: Schema.String,
      taskId: Schema.NullOr(Schema.String),
      hold: Schema.Boolean,
      at: Schema.String,
    }),
  }),
  conversationTabOpened: Events.synced({
    name: 'v1.ConversationTabOpened',
    schema: Schema.Struct({ taskId: Schema.String, runId: Schema.String, at: Schema.String }),
  }),
  conversationTabClosed: Events.synced({
    name: 'v1.ConversationTabClosed',
    schema: Schema.Struct({ taskId: Schema.String, runId: Schema.String, at: Schema.String }),
  }),
  runStartedV4: Events.synced({
    name: 'v4.RunStarted',
    schema: Schema.Struct({
      ...runStartedFields,
      taskId: Schema.NullOr(Schema.String),
      model: Schema.NullOr(Schema.String),
      effort: Schema.NullOr(Schema.String),
      parentRunId: Schema.NullOr(Schema.String),
      name: Schema.NullOr(Schema.String),
    }),
  }),
  subAgentRequested: Events.synced({
    name: 'v1.SubAgentRequested',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      parentRunId: Schema.String,
      name: Schema.String,
      agent: Schema.String,
      model: Schema.NullOr(Schema.String),
      effort: Schema.NullOr(Schema.String),
      prompt: Schema.String,
      ownWorktree: Schema.Boolean,
      at: Schema.String,
    }),
  }),
  subAgentRequestDropped: Events.synced({
    name: 'v1.SubAgentRequestDropped',
    schema: Schema.Struct({ id: Schema.String, at: Schema.String }),
  }),
  runFailed: Events.synced({
    name: 'v1.RunFailed',
    schema: Schema.Struct({ runId: Schema.String, error: Schema.String, at: Schema.String }),
  }),
  runEnded: Events.synced({
    name: 'v1.RunEnded',
    schema: Schema.Struct({ runId: Schema.String, ending: Schema.String, at: Schema.String }),
  }),
  runRevived: Events.synced({
    name: 'v1.RunRevived',
    schema: Schema.Struct({
      runId: Schema.String,
      taskId: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  taskLeadFailed: Events.synced({
    name: 'v1.TaskLeadFailed',
    schema: Schema.Struct({
      taskId: Schema.String,
      runId: Schema.String,
      reason: Schema.String,
      recovery: Schema.String,
      resumeFailed: Schema.Boolean,
      rank: Schema.NullOr(Schema.Number),
      ask: Schema.NullOr(
        Schema.Struct({ id: Schema.String, title: Schema.String, body: Schema.String }),
      ),
      at: Schema.String,
    }),
  }),
  taskRetried: Events.synced({
    name: 'v1.TaskRetried',
    schema: Schema.Struct({ taskId: Schema.String, rank: Schema.Number, at: Schema.String }),
  }),
  tedCommentPosted: Events.synced({
    name: 'v1.TedCommentPosted',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      kind: Schema.String,
      body: Schema.String,
      createdAt: Schema.String,
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
  automationCreated: Events.synced({
    name: 'v1.AutomationCreated',
    schema: Schema.Struct({
      id: Schema.String,
      factoryId: Schema.String,
      name: Schema.String,
      prompt: Schema.String,
      schedule: Schema.String,
      timeZone: Schema.String,
      agent: Schema.String,
      model: Schema.NullOr(Schema.String),
      effort: Schema.NullOr(Schema.String),
      on: Schema.Boolean,
      template: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  automationEdited: Events.synced({
    name: 'v1.AutomationEdited',
    schema: Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      prompt: Schema.String,
      schedule: Schema.String,
      timeZone: Schema.String,
      agent: Schema.String,
      model: Schema.NullOr(Schema.String),
      effort: Schema.NullOr(Schema.String),
      rescheduled: Schema.Boolean,
      at: Schema.String,
    }),
  }),
  automationSwitched: Events.synced({
    name: 'v1.AutomationSwitched',
    schema: Schema.Struct({ id: Schema.String, on: Schema.Boolean, at: Schema.String }),
  }),
  automationDeleted: Events.synced({
    name: 'v1.AutomationDeleted',
    schema: Schema.Struct({ id: Schema.String, at: Schema.String }),
  }),
  automationFired: Events.synced({
    name: 'v1.AutomationFired',
    schema: Schema.Struct({
      id: Schema.String,
      automationId: Schema.String,
      trigger: Schema.String,
      slotAt: Schema.NullOr(Schema.String),
      retryOf: Schema.NullOr(Schema.String),
      skipped: Schema.Boolean,
      at: Schema.String,
    }),
  }),
  automationFiringDropped: Events.synced({
    name: 'v1.AutomationFiringDropped',
    schema: Schema.Struct({ id: Schema.String, at: Schema.String }),
  }),
  automationRunBegan: Events.synced({
    name: 'v1.AutomationRunBegan',
    schema: Schema.Struct({ id: Schema.String, at: Schema.String }),
  }),
  automationRunResumeQueued: Events.synced({
    name: 'v1.AutomationRunResumeQueued',
    schema: Schema.Struct({ id: Schema.String, error: Schema.String, at: Schema.String }),
  }),
  automationRunRevived: Events.synced({
    name: 'v1.AutomationRunRevived',
    schema: Schema.Struct({ id: Schema.String, at: Schema.String }),
  }),
  automationRunEnded: Events.synced({
    name: 'v1.AutomationRunEnded',
    schema: Schema.Struct({
      id: Schema.String,
      outcome: Schema.String,
      error: Schema.NullOr(Schema.String),
      message: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  setupTaskCreated: Events.synced({
    name: 'v1.SetupTaskCreated',
    schema: Schema.Struct({ taskId: Schema.String, factoryId: Schema.String, at: Schema.String }),
  }),
  commentMarkedTutorial: Events.synced({
    name: 'v1.CommentMarkedTutorial',
    schema: Schema.Struct({ commentId: Schema.String }),
  }),
  commentLinearTeamAsked: Events.synced({
    name: 'v1.CommentLinearTeamAsked',
    schema: Schema.Struct({ commentId: Schema.String, key: Schema.String, name: Schema.String }),
  }),
  automationTaskCreated: Events.synced({
    name: 'v1.AutomationTaskCreated',
    schema: Schema.Struct({
      taskId: Schema.String,
      automationId: Schema.String,
      firingId: Schema.String,
      at: Schema.String,
    }),
  }),
  automationCommentPosted: Events.synced({
    name: 'v1.AutomationCommentPosted',
    schema: Schema.Struct({
      id: Schema.String,
      automationId: Schema.String,
      firingId: Schema.String,
      kind: Schema.String,
      body: Schema.String,
      choices: Schema.NullOr(Schema.Array(Schema.String)),
      at: Schema.String,
    }),
  }),
  automationCommentAnswered: Events.synced({
    name: 'v1.AutomationCommentAnswered',
    schema: Schema.Struct({ id: Schema.String, text: Schema.String, at: Schema.String }),
  }),
  automationPromptDraftRequested: Events.synced({
    name: 'v1.AutomationPromptDraftRequested',
    schema: Schema.Struct({
      id: Schema.String,
      factoryId: Schema.String,
      input: Schema.String,
      at: Schema.String,
    }),
  }),
  automationPromptDraftChanged: Events.synced({
    name: 'v1.AutomationPromptDraftChanged',
    schema: Schema.Struct({
      id: Schema.String,
      state: Schema.String,
      prompt: Schema.NullOr(Schema.String),
      error: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  automationPromptDraftRemoved: Events.synced({
    name: 'v1.AutomationPromptDraftRemoved',
    schema: Schema.Struct({ id: Schema.String, at: Schema.String }),
  }),
  planStarted: Events.synced({
    name: 'v1.PlanStarted',
    schema: Schema.Struct({
      id: Schema.String,
      factoryId: Schema.String,
      title: Schema.String,
      message: Schema.String,
      agent: Schema.String,
      model: Schema.NullOr(Schema.String),
      effort: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  planRenamed: Events.synced({
    name: 'v1.PlanRenamed',
    schema: Schema.Struct({ id: Schema.String, title: Schema.String, at: Schema.String }),
  }),
  planDeleted: Events.synced({
    name: 'v1.PlanDeleted',
    schema: Schema.Struct({ id: Schema.String, at: Schema.String }),
  }),
  planRunBegan: Events.synced({
    name: 'v1.PlanRunBegan',
    schema: Schema.Struct({ id: Schema.String, checkout: Schema.String, at: Schema.String }),
  }),
  planRunResumeQueued: Events.synced({
    name: 'v1.PlanRunResumeQueued',
    schema: Schema.Struct({ id: Schema.String, error: Schema.String, at: Schema.String }),
  }),
  planRunRevived: Events.synced({
    name: 'v1.PlanRunRevived',
    schema: Schema.Struct({ id: Schema.String, at: Schema.String }),
  }),
  planEnded: Events.synced({
    name: 'v1.PlanEnded',
    schema: Schema.Struct({
      id: Schema.String,
      outcome: Schema.String,
      error: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  planRequestPosted: Events.synced({
    name: 'v1.PlanRequestPosted',
    schema: Schema.Struct({
      id: Schema.String,
      planId: Schema.String,
      runId: Schema.String,
      kind: Schema.String,
      author: Schema.String,
      title: Schema.NullOr(Schema.String),
      body: Schema.String,
      round: Schema.NullOr(Schema.String),
      proposal: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  planRequestAnswered: Events.synced({
    name: 'v1.PlanRequestAnswered',
    schema: Schema.Struct({ id: Schema.String, answer: Schema.String, at: Schema.String }),
  }),
  planContinued: Events.synced({
    name: 'v1.PlanContinued',
    schema: Schema.Struct({
      id: Schema.String,
      fromPlanId: Schema.String,
      fromTitle: Schema.String,
      context: Schema.String,
      at: Schema.String,
    }),
  }),
  planRetried: Events.synced({
    name: 'v1.PlanRetried',
    schema: Schema.Struct({
      id: Schema.String,
      fresh: Schema.Boolean,
      checkout: Schema.NullOr(Schema.String),
      at: Schema.String,
    }),
  }),
  planStartedFromTask: Events.synced({
    name: 'v1.PlanStartedFromTask',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      displayId: Schema.String,
      taskTitle: Schema.String,
      sizeCheckId: Schema.String,
      at: Schema.String,
    }),
  }),
  planTaskDetached: Events.synced({
    name: 'v1.PlanTaskDetached',
    schema: Schema.Struct({
      id: Schema.String,
      taskId: Schema.String,
      reason: Schema.String,
      at: Schema.String,
    }),
  }),
  taskPlanEnded: Events.synced({
    name: 'v1.TaskPlanEnded',
    schema: Schema.Struct({
      taskId: Schema.String,
      planId: Schema.String,
      outcome: Schema.String,
      at: Schema.String,
    }),
  }),
  planTaskCreated: Events.synced({
    name: 'v1.PlanTaskCreated',
    schema: Schema.Struct({
      taskId: Schema.String,
      planId: Schema.String,
      row: Schema.Number,
      at: Schema.String,
    }),
  }),
}

type Logged = { taskId: string | null; at: string; data?: Record<string, unknown> }
type Args = Record<string, unknown>

const str = (value: unknown) => (typeof value === 'string' ? value : null)

const task = (args: Args, data?: Record<string, unknown>): Logged => ({
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
  'v1.TaskGatesChanged': (args) => task(args, { overrides: args.overrides }),
  'v1.TaskEdited': (args) => task(args, { title: args.title, version: args.version }),
  'v1.TaskBlockerAdded': (args) => task(args, { blockerId: args.blockerId, runId: null }),
  'v2.TaskBlockerAdded': (args) => task(args, { blockerId: args.blockerId, runId: args.runId }),
  'v1.TaskBlockerRemoved': (args) => task(args, { blockerId: args.blockerId, runId: args.runId }),
  'v1.TaskWaitingForBlockers': (args) => task(args),
  'v1.TaskRequeuedAfterBlockers': (args) => task(args),
  'v1.TaskStopped': (args) => task(args, { runs: args.runs, why: args.why }),
  'v1.TaskResumed': (args) => task(args),
  'v1.TaskLeadNudged': (args) => task(args, { runId: args.runId }),
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
  'v1.TaskUnarchived': (args) => task(args, { queued: args.rank !== null }),
  'v1.TaskFollowsUp': (args) => task(args, { originalId: args.originalId }),
  'v1.TaskFollowedUp': (args) => task(args, { followUpId: args.followUpId }),
  'v1.TaskSplitFrom': (args) => task(args, { originalId: args.originalId }),
  'v1.TaskSplit': (args) => task(args, { pieceIds: args.pieceIds, narrowedTo: args.narrowedTo }),
  'v1.TaskNeedsPlanning': (args) => task(args, { runId: args.runId }),
  'v1.TaskStartedAfterPlanning': (args) => task(args, { stage: args.stage }),
  'v1.PlanStartedFromTask': (args) => task(args, { planId: args.id }),
  'v1.TaskPlanEnded': (args) => task(args, { planId: args.planId, outcome: args.outcome }),
  'v1.TaskStageEntered': (args) => task(args, { stage: args.stage }),
  'v2.TaskStageEntered': (args) => task(args, { stage: args.stage }),
  'v3.TaskStageEntered': (args) => task(args, { stage: args.stage }),
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
  'v2.RunStarted': runStarted,
  'v3.RunStarted': runStarted,
  'v4.RunStarted': (args) => {
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
  'v1.MergeStoppedPartway': (args) => task(args, { merged: args.merged, open: args.open }),
  'v1.PullRequestSignedOff': (args) => task(args, { name: args.name, commit: args.commit }),
  'v1.PullRequestClosedOnGitHub': (args) => task(args, { name: args.name }),
  'v1.GitHubActivitySent': (args) => task(args, { runId: args.runId, notices: args.notices }),
  'v1.GitHubActivityQueued': (args) => task(args, { notices: args.notices }),
  'v1.GitHubActivityHeld': (args) => task(args, { notices: args.notices }),
  'v1.MergeStarted': (args) => task(args),
  'v1.GateSkippedOvernight': (args) => task(args, { stage: args.stage }),
  'v1.GateKeptOvernight': (args) => task(args, { stage: args.stage, reason: args.reason }),
  'v1.GateRequestedFor': (args) =>
    task(args, { commentId: args.commentId, name: args.name, commit: args.commit }),
  'v1.GateApprovalBound': (args) =>
    task(args, { commentId: args.commentId, name: args.name, commit: args.commit }),
  'v1.MergeCanceled': (args) => task(args, { commentId: args.commentId }),
  'v1.TaskWorktreeSetupFinished': (args) =>
    task(args, { name: args.name, outcome: args.outcome, exitCode: args.exitCode }),
  'v1.TaskWorktreeRemoved': (args) =>
    task(args, {
      name: args.name,
      teardownCommand: args.teardownCommand,
      teardownOutcome: args.teardownOutcome,
    }),
  'v1.TaskRunHeld': (args) => task(args, { agent: args.agent }),
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
  'v1.AppExited': (args) =>
    task(args, { repo: args.repo, name: args.name, code: args.code, signal: args.signal }),
  'v1.AppStartFailed': (args) =>
    task(args, { repo: args.repo, name: args.name, problem: args.problem }),
  'v1.SimulatorShutDown': (args) =>
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
  'v1.LoopCheckStarted': (args) => task(args, { runId: args.runId, round: args.round }),
  'v1.SendBackAsked': (args) =>
    task(args, {
      from: args.from,
      to: args.to,
      findings: args.findings,
      checkRunId: args.checkRunId,
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

function withTaskLog<T extends Record<string, (...args: never[]) => unknown>>(handlers: T): T {
  return Object.fromEntries(
    Object.entries(handlers).map(([name, handler]) => {
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

const materializers = counted(
  withTaskLog(
    State.SQLite.materializers(events, {
      'v1.FactoryAdded': (factory) => [
        factories.insert({ ...factory, clonedAt: factory.createdAt }),
        factoryRepos.insert({
          id: `${factory.id}:0`,
          factoryId: factory.id,
          position: 0,
          repo: factory.repo,
          name: factory.repo.split('/').at(-1) ?? factory.repo,
          cloneUrl: factory.cloneUrl,
        }),
      ],
      'v2.FactoryAdded': ({ repos, ...factory }) => [
        factories.insert({
          ...factory,
          repo: repos[0]?.repo ?? '',
          cloneUrl: repos[0]?.cloneUrl ?? '',
          clonedAt: null,
        }),
        ...repos.map((repo, position) =>
          factoryRepos.insert({
            ...repo,
            id: `${factory.id}:${position}`,
            factoryId: factory.id,
            position,
          }),
        ),
      ],
      'v1.FactoryCloned': ({ factoryId, at }) =>
        factories.update({ clonedAt: at }).where({ id: factoryId }),
      'v1.TaskCreated': (task) => tasks.insert({ ...task, stage: 'backlog' }),
      'v2.TaskCreated': (task) => tasks.insert({ ...task, stage: 'backlog' }),
      'v1.TaskBlockerAdded': ({ taskId, blockerId, at }) =>
        taskBlockers
          .insert({ id: `${taskId}:${blockerId}`, taskId, blockerId, at })
          .onConflict('id', 'ignore'),
      'v2.TaskBlockerAdded': ({ taskId, blockerId, runId, at }) =>
        taskBlockers
          .insert({ id: `${taskId}:${blockerId}`, taskId, blockerId, setByRunId: runId, at })
          .onConflict('id', 'replace'),
      'v1.TaskBlockerRemoved': ({ taskId, blockerId }) =>
        taskBlockers.delete().where({ id: `${taskId}:${blockerId}` }),
      'v1.TaskSnoozed': ({ taskId, until }) =>
        tasks.update({ snoozedUntil: until, startRequested: false }).where({ id: taskId }),
      'v1.TaskSnoozeCleared': ({ taskId }) =>
        tasks.update({ snoozedUntil: null }).where({ id: taskId }),
      'v1.TaskStartRequestChanged': ({ taskId, startRequested }) =>
        tasks.update({ startRequested }).where({ id: taskId }),
      'v1.TaskWaitingForBlockers': ({ taskId }) => [
        taskQueue.delete().where({ taskId }),
        tasks.update({ waitsForBlockers: true }).where({ id: taskId }),
      ],
      'v1.GitHubActivitySent': () => [],
      'v1.LinearIssueSeen': () => [],
      'v1.LinearSyncAllowed': () => [],
      'v1.LinearTeamSyncAllowed': () => [],
      'v1.LinearIssueMoved': () => [],
      'v1.LinearPullRequestsLinked': () => [],
      'v1.GitHubActivityHeld': () => [],
      'v1.AppStarted': () => [],
      'v1.AppStopped': () => [],
      'v1.AppExited': () => [],
      'v1.AppStartFailed': () => [],
      'v1.SimulatorShutDown': () => [],
      'v1.SimulatorRequested': ({ runId, simulator, ...comment }) =>
        comments.insert({
          ...comment,
          kind: 'permission',
          authorKind: 'run',
          authorRunId: runId,
          simulator,
        }),
      'v1.GitHubActivityQueued': ({ taskId, rank, at }) =>
        taskQueue.insert({ taskId, rank, queuedAt: at }).onConflict('taskId', 'replace'),
      'v1.TaskRequeuedAfterBlockers': ({ taskId, rank, at }) => [
        taskQueue.insert({ taskId, rank, queuedAt: at }).onConflict('taskId', 'replace'),
        tasks.update({ waitsForBlockers: false }).where({ id: taskId }),
      ],
      'v1.TaskStopped': ({ taskId, runs, why, at }) => [
        taskQueue.delete().where({ taskId }),
        tasks
          .update({
            stoppedAt: at,
            stoppedRuns: runs,
            stoppedWhy: why,
            waitsForBlockers: false,
            changedAt: at,
          })
          .where({ id: taskId }),
      ],
      'v1.TaskResumed': ({ taskId, rank, at }) => [
        taskQueue.insert({ taskId, rank, queuedAt: at }).onConflict('taskId', 'replace'),
        tasks
          .update({ stoppedAt: null, stoppedRuns: null, stoppedWhy: null, changedAt: at })
          .where({ id: taskId }),
      ],
      'v1.TaskLeadNudged': ({ taskId, at }) =>
        tasks.update({ changedAt: at }).where({ id: taskId }),
      'v1.MergeStarted': ({ taskId, at }) => tasks.update({ changedAt: at }).where({ id: taskId }),
      'v1.GateRequestedFor': ({ taskId, at }) =>
        tasks.update({ changedAt: at }).where({ id: taskId }),
      'v1.GateApprovalBound': ({ taskId, at }) =>
        tasks.update({ changedAt: at }).where({ id: taskId }),
      'v1.GateKeptOvernight': ({ taskId, at }) =>
        tasks.update({ changedAt: at }).where({ id: taskId }),
      'v1.GateSkippedOvernight': ({ taskId, at }) =>
        tasks.update({ changedAt: at }).where({ id: taskId }),
      'v1.MergeCanceled': ({ taskId, at }) => tasks.update({ changedAt: at }).where({ id: taskId }),
      'v1.TaskAttachmentAdded': ({ taskId, hash, name, ...rest }) =>
        taskAttachments
          .insert({ id: `${taskId}:${hash}:${name}`, taskId, hash, name, ...rest })
          .onConflict('id', 'ignore'),
      'v1.CommentAttachmentAdded': ({ commentId, hash, name, ...rest }) =>
        commentAttachments
          .insert({ id: `${commentId}:${hash}:${name}`, commentId, hash, name, ...rest })
          .onConflict('id', 'ignore'),
      'v1.SetupTaskCreated': ({ taskId }) => tasks.update({ setup: true }).where({ id: taskId }),
      'v1.CommentMarkedTutorial': ({ commentId }) =>
        comments.update({ tutorial: true }).where({ id: commentId }),
      'v1.CommentLinearTeamAsked': ({ commentId, key, name }) =>
        comments.update({ linearTeam: JSON.stringify({ key, name }) }).where({ id: commentId }),
      'v1.CommentDesignAttached': ({ commentId, design }) =>
        comments.update({ design }).where({ id: commentId }),
      'v1.TaskFollowsUp': ({ taskId, originalId }) =>
        tasks.update({ followUpOf: originalId }).where({ id: taskId }),
      'v1.TaskGatesChanged': ({ taskId, overrides, at }) =>
        tasks.update({ gateOverrides: overrides, changedAt: at }).where({ id: taskId }),
      'v1.TaskGatesForced': ({ taskId, stages }) =>
        tasks.update({ forcedGates: JSON.stringify(stages) }).where({ id: taskId }),
      'v1.TaskChangesSettings': ({ taskId }) =>
        tasks.update({ changesSettings: true }).where({ id: taskId }),
      'v1.StageFileTextSeen': ({ at, ...seen }) =>
        stageFileTexts.insert({ ...seen, seenAt: at }).onConflict('hash', 'ignore'),
      'v1.TaskFollowedUp': ({ taskId, at }) =>
        tasks.update({ changedAt: at }).where({ id: taskId }),
      'v1.TaskSplitFrom': ({ taskId, originalId }) =>
        tasks.update({ splitFrom: originalId }).where({ id: taskId }),
      'v1.TaskSplit': ({ taskId, at }) => tasks.update({ changedAt: at }).where({ id: taskId }),
      'v1.TaskNeedsPlanning': ({ taskId, at }) => [
        taskQueue.delete().where({ taskId }),
        tasks
          .update({ stage: 'backlog', needsPlanningAt: at, activity: null, changedAt: at })
          .where({ id: taskId }),
      ],
      'v1.TaskStartedAfterPlanning': ({ taskId, stage, rank, at }) => [
        taskQueue.insert({ taskId, rank, queuedAt: at }).onConflict('taskId', 'replace'),
        tasks.update({ stage, needsPlanningAt: null, changedAt: at }).where({ id: taskId }),
      ],
      'v1.TaskSourceSet': (source) => taskSources.insert(source).onConflict('taskId', 'replace'),
      'v1.TaskSourceSentrySet': ({ taskId, shortId }) =>
        taskSources.update({ sentryShortId: shortId }).where({ taskId }),
      'v1.TaskStarted': ({ taskId, stage, branch, worktree }) =>
        tasks.update({ stage, branch, worktree }).where({ id: taskId }),
      'v1.TaskStageChanged': ({ taskId, stage }) => tasks.update({ stage }).where({ id: taskId }),
      'v1.TaskQueued': ({ taskId, stage, rank, at }) => [
        taskQueue.insert({ taskId, rank, queuedAt: at }).onConflict('taskId', 'replace'),
        tasks.update({ stage }).where({ id: taskId }),
      ],
      'v1.TaskDequeued': ({ taskId }) => taskQueue.delete().where({ taskId }),
      'v1.TaskMovedToBacklog': ({ taskId }) => [
        taskQueue.delete().where({ taskId }),
        tasks.update({ stage: 'backlog' }).where({ id: taskId }),
      ],
      'v1.TaskRanked': ({ taskId, rank }) => [
        tasks.update({ rank }).where({ id: taskId }),
        taskQueue.update({ rank }).where({ taskId }),
      ],
      'v1.TaskEdited': ({ taskId, title, description, version, previous, previousAt, at }) => [
        tasks
          .update({
            ...(title !== null && { title }),
            ...(description !== null && { description }),
            changedAt: at,
          })
          .where({ id: taskId }),
        ...(description === null || version === null
          ? []
          : [
              ...(previous === null || previousAt === null
                ? []
                : [
                    taskDescriptions
                      .insert({
                        id: `${taskId}:${version - 1}`,
                        taskId,
                        version: version - 1,
                        text: previous,
                        at: previousAt,
                      })
                      .onConflict('id', 'ignore'),
                  ]),
              taskDescriptions
                .insert({ id: `${taskId}:${version}`, taskId, version, text: description, at })
                .onConflict('id', 'replace'),
            ]),
      ],
      'v1.TaskPriorityChanged': ({ taskId, priority, at }) =>
        tasks.update({ priority, changedAt: at }).where({ id: taskId }),
      'v1.TaskArchived': ({ taskId, at }) => [
        taskQueue.delete().where({ taskId }),
        tasks.update({ archivedAt: at, changedAt: at }).where({ id: taskId }),
      ],
      'v2.TaskArchived': ({ taskId, at }) => [
        taskQueue.delete().where({ taskId }),
        tasks.update({ archivedAt: at, changedAt: at }).where({ id: taskId }),
      ],
      'v3.TaskArchived': ({ taskId, at }) => [
        taskQueue.delete().where({ taskId }),
        tasks.update({ archivedAt: at, changedAt: at }).where({ id: taskId }),
      ],
      'v1.TaskUnarchived': ({ taskId, rank, at }) => [
        ...(rank === null
          ? []
          : [taskQueue.insert({ taskId, rank, queuedAt: at }).onConflict('taskId', 'replace')]),
        tasks
          .update({
            archivedAt: null,
            failedAt: null,
            stoppedAt: null,
            stoppedRuns: null,
            stoppedWhy: null,
            waitsForBlockers: false,
            changedAt: at,
          })
          .where({ id: taskId }),
      ],
      'v1.TaskDeleted': ({ taskId, factoryId, number, runIds, checkRunIds, at }) => [
        deletedTasks.insert({ id: taskId, factoryId, number, at }).onConflict('id', 'ignore'),
        tasks.delete().where({ id: taskId }),
        taskQueue.delete().where({ taskId }),
        taskBlockers.delete().where({ taskId }),
        taskAttachments.delete().where({ taskId }),
        commentAttachments.delete().where({ taskId }),
        lineComments.delete().where({ taskId }),
        taskSources.delete().where({ taskId }),
        runs.delete().where({ taskId }),
        subAgentRequests.delete().where({ taskId }),
        conversationTabs.delete().where({ taskId }),
        comments.delete().where({ taskId }),
        taskLog.delete().where({ taskId }),
        taskBriefs.delete().where({ taskId }),
        peerMessages.delete().where({ recipientTaskId: taskId }),
        taskDescriptions.delete().where({ taskId }),
        sendBacks.delete().where({ taskId }),
        sendBackResets.delete().where({ taskId }),
        checkRuns.delete().where({ taskId }),
        failureCases.delete().where({ taskId }),
        validationProgress.delete().where({ taskId }),
        failureContexts.delete().where({ taskId }),
        stageEntries.delete().where({ taskId }),
        taskRepos.delete().where({ taskId }),
        pullRequests.delete().where({ taskId }),
        heldRuns.delete().where({ taskId }),
        ...(runIds.length === 0
          ? []
          : [
              runs.delete().where({ id: { op: 'IN', value: runIds } }),
              runMessages.delete().where({ runId: { op: 'IN', value: runIds } }),
              runInterrupts.delete().where({ runId: { op: 'IN', value: runIds } }),
            ]),
        ...(checkRunIds.length === 0
          ? []
          : [checkResults.delete().where({ checkRunId: { op: 'IN', value: checkRunIds } })]),
      ],
      'v1.CommentPosted': (comment) => comments.insert({ ...comment, authorKind: 'run' }),
      'v2.CommentPosted': ({ choices, ...comment }) =>
        comments.insert({ ...comment, choices: choices === null ? null : JSON.stringify(choices) }),
      'v3.CommentPosted': ({ choices, ...comment }) =>
        comments.insert({ ...comment, choices: choices === null ? null : JSON.stringify(choices) }),
      'v4.CommentPosted': ({ choices, ...comment }) =>
        comments.insert({ ...comment, choices: choices === null ? null : JSON.stringify(choices) }),
      'v1.ClarifyDepthSet': ({ taskId, depth, by, at }) =>
        tasks
          .update({ clarifyDepth: depth, clarifyDepthBy: by, changedAt: at })
          .where({ id: taskId }),
      'v1.TaskReposSet': ({ taskId, repos, at }) =>
        tasks.update({ chosenRepos: JSON.stringify(repos), changedAt: at }).where({ id: taskId }),
      'v1.ValidationProgressed': (row) =>
        validationProgress.insert(row).onConflict('taskId', 'replace'),
      'v1.FailureVerified': (row) => failureCases.insert(row).onConflict('id', 'replace'),
      'v1.FailureContextCaptured': (row) => failureContexts.insert(row).onConflict('id', 'replace'),
      'v1.FailureCaseRecorded': (row) => failureCases.insert(row).onConflict('id', 'replace'),
      'v1.FailureAssessed': (row) => failureCases.insert(row).onConflict('id', 'replace'),
      'v1.FailureEvidenceAdded': (row) => failureCases.insert(row).onConflict('id', 'replace'),
      'v1.FailureDecisionRequested': (row) => failureCases.insert(row).onConflict('id', 'replace'),
      'v1.FailureResolved': (row) => failureCases.insert(row).onConflict('id', 'replace'),
      'v1.FailureAcceptanceInvalidated': (row) =>
        failureCases.insert(row).onConflict('id', 'replace'),
      'v1.CommentAnswered': ({ id, answer }) => comments.update({ answer }).where({ id }),
      'v1.RoundTalkStarted': ({ id, runId, at }) =>
        comments.update({ talkRunId: runId, talkStartedAt: at, talkDoneAt: null }).where({ id }),
      'v1.RoundTalkDone': ({ id, at }) => comments.update({ talkDoneAt: at }).where({ id }),
      'v1.PeerMessageSent': (row) => peerMessages.insert(row),
      'v1.TaskBriefWritten': ({ at, ...brief }) => taskBriefs.insert({ ...brief, createdAt: at }),
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
      'v1.CheckStarted': ({ checkRunId, position }) =>
        checkResults.update({ state: 'running' }).where({ id: `${checkRunId}:${position}` }),
      'v1.CheckFinished': ({ checkRunId, position, state, exitCode, durationMs }) =>
        checkResults
          .update({ state, exitCode, durationMs })
          .where({ id: `${checkRunId}:${position}` }),
      'v1.ChecksFinished': ({ checkRunId, outcome, at }) => [
        checkRuns.update({ outcome, finishedAt: at }).where({ id: checkRunId }),
        checkResults.update({ state: 'not-run' }).where({ checkRunId, state: 'waiting' }),
        checkResults.update({ state: 'not-run' }).where({ checkRunId, state: 'running' }),
      ],
      'v1.SendBackCountReset': (reset) => sendBackResets.insert(reset),
      'v1.RunStarted': (run) =>
        runs.insert({ ...run, taskId: null, state: 'working', readOffset: 0 }),
      'v2.RunStarted': (run) => runs.insert({ ...run, state: 'working', readOffset: 0 }),
      'v3.RunStarted': (run) => runs.insert({ ...run, state: 'working', readOffset: 0 }),
      'v4.RunStarted': (run) => [
        runs.insert({ ...run, state: 'working', readOffset: 0 }),
        subAgentRequests.delete().where({ id: run.id }),
      ],
      'v1.SubAgentRequested': (request) => subAgentRequests.insert(request),
      'v1.SubAgentRequestDropped': ({ id }) => subAgentRequests.delete().where({ id }),
      'v1.ReviewerChosen': (row) => reviewers.insert(row),
      'v1.ValidateJudged': ({ taskId, at }) =>
        tasks.update({ changedAt: at }).where({ id: taskId }),
      'v1.LoopCheckStarted': ({ to, ...row }) =>
        loopChecks.insert({ ...row, toStage: to, verdict: null }),
      'v1.LoopCheckFinished': ({ runId, verdict }) =>
        loopChecks.update({ verdict }).where({ runId }),
      'v1.SendBackAsked': ({ from, to, ...row }) =>
        sendBackAsks.insert({ ...row, fromStage: from, toStage: to }),
      'v1.RunFailed': ({ runId, error }) => runs.update({ failure: error }).where({ id: runId }),
      'v1.RunRestarted': ({ runId, model, effort, usesDefaultModel }) =>
        runs
          .update({ model, effort, usesDefaultModel, problem: null, state: 'idle' })
          .where({ id: runId }),
      'v1.RunRetryingChanged': ({ runId, retrying }) =>
        runs.update({ retrying }).where({ id: runId }),
      'v1.RunProblemFound': ({ runId, problem }) =>
        runs.update({ problem, state: 'waiting' }).where({ id: runId }),
      'v1.TaskLeadSet': ({ taskId, agent, model, effort }) =>
        tasks
          .update({ leadAgent: agent, leadModel: model, leadEffort: effort })
          .where({ id: taskId }),
      'v1.RunEnded': ({ runId, ending }) => runs.update({ ended: ending }).where({ id: runId }),
      'v1.RunRevived': ({ runId, at }) =>
        runs
          .update({ state: 'working', ended: null, problem: null, revivedAt: at })
          .where({ id: runId }),
      'v1.TaskLeadFailed': ({ taskId, runId, recovery, rank, ask, at }) => [
        ...(recovery === 'fresh' && rank !== null
          ? [taskQueue.insert({ taskId, rank, queuedAt: at }).onConflict('taskId', 'replace')]
          : []),
        tasks
          .update({ changedAt: at, ...(recovery === 'failed' && { failedAt: at }) })
          .where({ id: taskId }),
        ...(ask === null
          ? []
          : [
              comments.insert({
                id: ask.id,
                taskId,
                kind: 'question',
                body: ask.body,
                title: ask.title,
                choices: JSON.stringify(['Retry']),
                authorKind: 'ted',
                authorRunId: null,
                failedRunId: runId,
                createdAt: at,
              }),
            ]),
      ],
      'v1.TaskRetried': ({ taskId, rank, at }) => [
        taskQueue.insert({ taskId, rank, queuedAt: at }).onConflict('taskId', 'replace'),
        tasks
          .update({
            failedAt: null,
            stoppedAt: null,
            stoppedRuns: null,
            stoppedWhy: null,
            changedAt: at,
          })
          .where({ id: taskId }),
      ],
      'v1.TedCommentPosted': (comment) =>
        comments.insert({ ...comment, authorKind: 'ted', authorRunId: null }),
      'v1.RunOutputRead': ({ runId, toOffset }) =>
        runs.update({ readOffset: toOffset }).where({ id: runId }),
      'v2.RunOutputRead': ({ runId, toOffset, entries }) => {
        const last = entries.at(-1)
        return runs
          .update({ readOffset: toOffset, ...(last && { lastOutputAt: last.at }) })
          .where({ id: runId })
      },
      'v3.RunOutputRead': ({ runId, toOffset, lastOutputAt }) =>
        runs
          .update({ readOffset: toOffset, ...(lastOutputAt !== null && { lastOutputAt }) })
          .where({ id: runId }),
      'v1.RunMessageSent': ({ id, runId, text, at }) => runMessages.insert({ id, runId, text, at }),
      'v1.RunMessageQueued': ({ id, runId, text, at }) =>
        runMessages.insert({ id, runId, text, at, queued: true }),
      'v2.RunMessageQueued': ({ id, runId, text, at, from }) =>
        runMessages.insert({ id, runId, text, at, queued: true, fromTed: from === 'ted' }),
      'v1.RunMessageDelivered': ({ id }) => runMessages.update({ queued: false }).where({ id }),
      'v1.RunMessageDeleted': ({ id, at }) =>
        runMessages.update({ deletedAt: at, queued: false }).where({ id }),
      'v1.RunSteeringReleased': ({ runId, release }) =>
        runs.update({ steeringRelease: release }).where({ id: runId }),
      'v1.RunTurnInterrupted': ({ id, runId, hold, at }) =>
        runInterrupts.insert({ id, runId, hold, at }),
      'v1.ConversationTabOpened': ({ taskId, runId, at }) =>
        conversationTabs
          .insert({ id: `${taskId}:${runId}`, taskId, runId, openedAt: at })
          .onConflict('id', 'ignore'),
      'v1.ConversationTabClosed': ({ taskId, runId }) =>
        conversationTabs.delete().where({ id: `${taskId}:${runId}` }),
      'v1.RunStateChanged': ({ runId, state }) => runs.update({ state }).where({ id: runId }),
      'v1.RunPermissionsSet': ({ runId, permissions }) =>
        runs.update({ permissions }).where({ id: runId }),
      'v1.RunAutoModeUnavailable': ({ runId }) =>
        runs.update({ manualPermissions: true }).where({ id: runId }),
      'v1.PermissionRequested': ({
        runId,
        requestId,
        generation,
        command,
        details,
        repo,
        input,
        ...comment
      }) =>
        comments.insert({
          ...comment,
          kind: 'permission',
          authorKind: 'run',
          authorRunId: runId,
          permission: JSON.stringify({
            requestId,
            generation,
            command,
            ...(details !== null && { details }),
            ...(repo !== null && { repo }),
            ...(input !== null && { input }),
          }),
        }),
      'v1.RunSessionIdentified': ({ runId, sessionId }) =>
        runs.update({ sessionId }).where({ id: runId }),
      'v1.TaskStageEntered': (entry) => stageEntries.insert(entry),
      'v2.TaskStageEntered': (entry) => stageEntries.insert(entry),
      'v3.TaskStageEntered': ({ effort, ...entry }) => [
        stageEntries.insert(entry),
        tasks.update({ stageEffort: effort }).where({ id: entry.taskId }),
      ],
      'v1.TaskLeadEffortModeSet': ({ taskId, mode }) =>
        tasks.update({ leadEffortMode: mode }).where({ id: taskId }),
      'v1.TaskLeadRestartPendingSet': ({ taskId, pending }) =>
        tasks.update({ leadRestartPending: pending }).where({ id: taskId }),
      'v1.TaskLeadMessageHeld': ({ taskId, text }) =>
        tasks.update({ pendingLeadMessage: text }).where({ id: taskId }),
      'v1.TaskLeadMessagesHeld': ({ taskId, messages }) =>
        tasks
          .update({ pendingLeadDeliveries: messages, pendingLeadMessage: null })
          .where({ id: taskId }),
      'v1.TaskActivitySet': ({ taskId, text, stageEntries: count }) =>
        tasks.update({ activity: text, activityEntries: count }).where({ id: taskId }),
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
      'v1.LocalFolderSet': ({ repo, path, at }) =>
        localFolders.insert({ repo, path, setAt: at }).onConflict('repo', 'replace'),
      'v1.LocalFolderCleared': ({ repo }) => localFolders.delete().where({ repo }),
      'v1.FactoryAutoStartBacklogChanged': ({ factoryId, enabled }) =>
        factories.update({ autoStartBacklog: enabled }).where({ id: factoryId }),
      'v1.FactoryRenamed': ({ factoryId, name }) =>
        factories.update({ name }).where({ id: factoryId }),
      'v1.FactoryReposChanged': ({ factoryId, repos }) => [
        factoryRepos.delete().where({ factoryId }),
        ...repos.map((repo, position) =>
          factoryRepos.insert({ ...repo, id: `${factoryId}:${position}`, factoryId, position }),
        ),
      ],
      'v1.FactoriesReordered': ({ factoryIds }) => [
        factoryOrder.delete(),
        ...factoryIds.map((factoryId, position) => factoryOrder.insert({ factoryId, position })),
      ],
      'v1.TaskDraftSaved': ({ factoryId, draft }) =>
        taskDrafts.insert({ factoryId, draft }).onConflict('factoryId', 'replace'),
      'v1.TaskDraftCleared': ({ factoryId, revision }) => [
        taskDrafts
          .insert({ factoryId, draft: null, clearedRevision: revision })
          .onConflict('factoryId', 'replace'),
        taskDraftConsumptions
          .insert({ id: `${factoryId}:${revision}`, factoryId, revision })
          .onConflict('id', 'ignore'),
      ],
      'v2.TaskDraftSaved': ({ factoryId, draft, clearedRevision }) =>
        taskDrafts.insert({ factoryId, draft, clearedRevision }).onConflict('factoryId', 'replace'),
      'v1.TaskDraftConsumed': ({ factoryId, revision, draft }) => [
        taskDrafts
          .insert({ factoryId, draft, clearedRevision: revision })
          .onConflict('factoryId', 'replace'),
        taskDraftConsumptions
          .insert({ id: `${factoryId}:${revision}`, factoryId, revision })
          .onConflict('id', 'ignore'),
      ],
      'v1.TaskDraftRemoved': ({ factoryId }) => [
        taskDrafts.delete().where({ factoryId }),
        taskDraftConsumptions.delete().where({ factoryId }),
      ],
      'v1.FactoryRemoved': ({ factoryId }) => [
        peerMessages.delete().where({ factoryId }),
        factories.delete().where({ id: factoryId }),
        factoryRepos.delete().where({ factoryId }),
        factoryOrder.delete().where({ factoryId }),
        deletedTasks.delete().where({ factoryId }),
        banners.delete().where({ factoryId }),
        workflowLayers.delete().where({ layer: `factory:${factoryId}` }),
      ],
      'v1.WorkflowLayerAccepted': ({ layer, files, version, at }) =>
        workflowLayers
          .insert({ layer, files, version, acceptedAt: at })
          .onConflict('layer', 'replace'),
      'v1.AppearanceChanged': ({ appearance }) =>
        machineSettings.insert({ id: 'machine', appearance }).onConflict('id', 'replace'),
      'v1.MachineSettingsChanged': ({ changes }) =>
        Object.entries(JSON.parse(changes) as Record<string, unknown>).map(([name, value]) =>
          machineSettingValues
            .insert({ name, value: JSON.stringify(value) })
            .onConflict('name', 'replace'),
        ),
      'v1.BannerRaised': ({ at, ...banner }) => [
        banners
          .insert({ ...banner, raisedAt: at, dismissedUntil: null })
          .onConflict('id', 'ignore'),
        banners
          .update({ severity: banner.severity, text: banner.text, action: banner.action })
          .where({ id: banner.id }),
      ],
      'v1.BannerDismissed': ({ id, until }) =>
        banners.update({ dismissedUntil: until }).where({ id }),
      'v1.BannerCleared': ({ id }) => banners.delete().where({ id }),
      'v1.AgentPaused': ({ agent, reason, at }) =>
        agentPauses.insert({ agent, reason, since: at }).onConflict('agent', 'replace'),
      'v1.AgentResumed': ({ agent }) => agentPauses.delete().where({ agent }),
      'v1.TaskRunHeld': (held) => heldRuns.insert(held).onConflict('taskId', 'replace'),
      'v1.TaskRunReleased': ({ taskId }) => heldRuns.delete().where({ taskId }),
      'v1.CommentsDelivered': ({ ids, runId, at }) =>
        ids.map((id) => comments.update({ deliveredRunId: runId, deliveredAt: at }).where({ id })),
      'v1.CommentsRead': ({ ids, at }) =>
        ids.map((id) => comments.update({ readAt: at }).where({ id })),
      'v1.LineCommentDrafted': ({ at, ...draft }) =>
        lineComments.insert({ ...draft, createdAt: at }).onConflict('id', 'ignore'),
      'v1.LineCommentEdited': ({ id, body, at }) =>
        lineComments.update({ body, editedAt: at }).where({ id, commentId: null }),
      'v1.LineCommentsDeleted': ({ ids }) =>
        ids.map((id) => lineComments.update({ deleted: true }).where({ id, commentId: null })),
      'v1.LineCommentsSent': ({ ids, commentId, at }) =>
        ids.map((id) =>
          lineComments.update({ commentId, sentAt: at }).where({ id, commentId: null }),
        ),
      'v1.CommentAnswerHeld': ({ id }) => comments.update({ answerHeld: true }).where({ id }),
      'v1.CommentAnswersDelivered': ({ ids }) =>
        ids.map((id) => comments.update({ answerHeld: false }).where({ id })),
      'v1.AutomationCreated': ({ at, ...automation }) =>
        automations.insert({ ...automation, handledUntil: at, createdAt: at }),
      'v1.AutomationEdited': ({ id, rescheduled, at, ...fields }) =>
        automations.update({ ...fields, ...(rescheduled && { handledUntil: at }) }).where({ id }),
      'v1.AutomationSwitched': ({ id, on, at }) =>
        automations.update({ on, ...(on && { handledUntil: at }) }).where({ id }),
      'v1.AutomationDeleted': ({ id }) => [
        automations.delete().where({ id }),
        automationFirings.delete().where({ automationId: id }),
        automationComments.delete().where({ automationId: id }),
      ],
      'v1.AutomationFired': ({ skipped, retryOf, slotAt, ...firing }) => [
        automationFirings.insert({
          ...firing,
          slotAt,
          retryOf,
          state: skipped ? 'skipped' : 'queued',
        }),
        ...(slotAt !== null
          ? [automations.update({ handledUntil: slotAt }).where({ id: firing.automationId })]
          : []),
        ...(retryOf !== null
          ? [automationFirings.update({ retriedAt: firing.at }).where({ id: retryOf })]
          : []),
      ],
      'v1.AutomationFiringDropped': ({ id, at }) =>
        automationFirings.update({ state: 'dropped', finishedAt: at }).where({ id }),
      'v1.AutomationRunBegan': ({ id, at }) =>
        automationFirings.update({ state: 'started', startedAt: at }).where({ id }),
      'v1.AutomationRunResumeQueued': ({ id, error }) =>
        automationFirings.update({ resume: 'queued', error }).where({ id }),
      'v1.AutomationRunRevived': ({ id }) =>
        automationFirings.update({ resume: 'done' }).where({ id }),
      'v1.AutomationRunEnded': ({ id, outcome, error, message, at }) =>
        automationFirings
          .update({ state: 'ended', outcome, error, message, finishedAt: at })
          .where({ id }),
      'v1.AutomationTaskCreated': (link) =>
        automationTasks.insert(link).onConflict('taskId', 'ignore'),
      'v1.AutomationCommentPosted': ({ choices, at, ...comment }) =>
        automationComments.insert({
          ...comment,
          choices: choices === null ? null : JSON.stringify(choices),
          createdAt: at,
        }),
      'v1.AutomationCommentAnswered': ({ id, text, at }) =>
        automationComments.update({ answer: text, answeredAt: at }).where({ id }),
      'v1.AutomationPromptDraftRequested': ({ at, ...draft }) =>
        automationPromptDrafts.insert({ ...draft, state: 'queued', createdAt: at, updatedAt: at }),
      'v1.AutomationPromptDraftChanged': ({ id, at, ...fields }) =>
        automationPromptDrafts.update({ ...fields, updatedAt: at }).where({ id }),
      'v1.AutomationPromptDraftRemoved': ({ id }) => [
        automationPromptDrafts.delete().where({ id }),
        runs.delete().where({ id }),
        runMessages.delete().where({ runId: id }),
        runInterrupts.delete().where({ runId: id }),
      ],
      'v1.SideChatChanged': (row) => sideChats.insert(row).onConflict('sourceRunId', 'replace'),
      'v1.SideChatRemoved': ({ sourceRunId, runId }) => [
        sideChats.delete().where({ sourceRunId }),
        runs.delete().where({ id: runId }),
        runMessages.delete().where({ runId }),
        runInterrupts.delete().where({ runId }),
      ],
      'v1.CoordinatorChanged': (row) => coordinators.insert(row).onConflict('factoryId', 'replace'),
      'v1.CoordinatorRemoved': ({ factoryId, runIds }) => [
        coordinators.delete().where({ factoryId }),
        ...runIds.flatMap((id) => [
          runs.delete().where({ id }),
          runMessages.delete().where({ runId: id }),
          runInterrupts.delete().where({ runId: id }),
        ]),
      ],
      'v1.PlanStarted': ({ at, ...plan }) =>
        plans.insert({ ...plan, state: 'queued', createdAt: at }),
      'v1.PlanRenamed': ({ id, title }) => plans.update({ title }).where({ id }),
      'v1.PlanDeleted': ({ id }) => [
        plans.delete().where({ id }),
        planRequests.delete().where({ planId: id }),
        runs.delete().where({ id }),
        runMessages.delete().where({ runId: id }),
        runInterrupts.delete().where({ runId: id }),
      ],
      'v1.PlanRunBegan': ({ id, checkout, at }) =>
        plans.update({ state: 'started', checkout, startedAt: at }).where({ id }),
      'v1.PlanRunResumeQueued': ({ id, error }) =>
        plans.update({ resume: 'queued', error }).where({ id }),
      'v1.PlanRunRevived': ({ id }) => plans.update({ resume: 'done' }).where({ id }),
      'v1.PlanEnded': ({ id, outcome, error, at }) =>
        plans.update({ state: 'ended', outcome, error, finishedAt: at }).where({ id }),
      'v1.PlanRequestPosted': ({ at, ...request }) =>
        planRequests.insert({ ...request, createdAt: at }),
      'v1.PlanRequestAnswered': ({ id, answer }) => planRequests.update({ answer }).where({ id }),
      'v1.PlanTaskCreated': (link) => planTasks.insert(link).onConflict('taskId', 'ignore'),
      'v1.PlanContinued': ({ id, fromPlanId, fromTitle, context }) =>
        plans.update({ fromPlanId, fromPlanTitle: fromTitle, context }).where({ id }),
      'v1.PlanRetried': ({ id, fresh, checkout }) =>
        plans
          .update({
            state: fresh ? 'queued' : 'started',
            resume: fresh ? null : 'queued',
            outcome: null,
            error: null,
            finishedAt: null,
            checkout,
          })
          .where({ id }),
      'v1.PlanStartedFromTask': ({ id, taskId, displayId, taskTitle, sizeCheckId }) =>
        plans
          .update({
            fromTaskId: taskId,
            fromTaskDisplayId: displayId,
            fromTaskTitle: taskTitle,
            sizeCheckId,
          })
          .where({ id }),
      'v1.PlanTaskDetached': ({ id, reason }) =>
        plans.update({ fromTaskGone: reason }).where({ id }),
      'v1.TaskPlanEnded': ({ taskId, at }) => tasks.update({ changedAt: at }).where({ id: taskId }),
    }),
  ),
)

const state = State.SQLite.makeState({
  tables: {
    taskDrafts,
    taskDraftConsumptions,
    factories,
    factoryRepos,
    factoryOrder,
    tasks,
    taskQueue,
    taskBlockers,
    deletedTasks,
    taskAttachments,
    commentAttachments,
    taskSources,
    runs,
    subAgentRequests,
    reviewers,
    loopChecks,
    sendBackAsks,
    runMessages,
    runInterrupts,
    conversationTabs,
    comments,
    lineComments,
    taskLog,
    peerMessages,
    taskBriefs,
    taskDescriptions,
    sendBacks,
    sendBackResets,
    checkRuns,
    checkResults,
    failureCases,
    failureContexts,
    validationProgress,
    stageEntries,
    workflowLayers,
    stageFileTexts,
    taskRepos,
    pullRequests,
    localFolders,
    machineSettings,
    machineSettingValues,
    banners,
    agentPauses,
    heldRuns,
    automations,
    automationFirings,
    automationPromptDrafts,
    automationTasks,
    automationComments,
    plans,
    planRequests,
    planTasks,
    coordinators,
    sideChats,
  },
  materializers,
})

export const schema = makeSchema({ events, state })
