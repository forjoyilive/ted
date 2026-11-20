import { makeSchema, State } from '@livestore/livestore'
import { intervalBoundaries } from './interval-schema.ts'
import { counted } from './progress.ts'
import {
  appsEvents,
  appsMaterializers,
  runBrowserCaptures,
  taskBrowserCaptures,
} from './schema/apps.ts'
import {
  automationCheckResults,
  automationCheckTasks,
  automationComments,
  automationFirings,
  automationPromptDrafts,
  automations,
  automationsEvents,
  automationsMaterializers,
  automationTaskActions,
  automationTasks,
} from './schema/automations.ts'
import {
  chatAgents,
  chatCommands,
  chatRequests,
  chatsEvents,
  chatsMaterializers,
  coordinatorChats,
  outsideCommandAllowances,
  sideChats,
} from './schema/chats.ts'
import {
  checkBoundaries,
  checkResults,
  checkRuns,
  checksEvents,
  checksMaterializers,
  loopChecks,
  p1OnlyReviews,
  reviewers,
  reviewScopes,
  sendBackAsks,
  sendBackResets,
  sendBacks,
  severityDeclarations,
  testInvocations,
} from './schema/checks.ts'
import {
  executionAssignments,
  executionEvents,
  executionMachine,
  executionMaterializers,
  executionOperations,
  executionPairing,
} from './schema/execution.ts'
import {
  factories,
  factoriesEvents,
  factoriesMaterializers,
  factoryLayout,
  factoryOrder,
  factoryRepos,
  localFolders,
} from './schema/factories.ts'
import {
  failureCases,
  failureContexts,
  failuresEvents,
  failuresMaterializers,
  validationProgress,
} from './schema/failures.ts'
import {
  banners,
  machineEvents,
  machineMaterializers,
  machineSettings,
  machineSettingValues,
} from './schema/machine.ts'
import {
  baseConflicts,
  cleanupReports,
  mergeEvents,
  mergeMaterializers,
  pullRequests,
  taskRepos,
} from './schema/merge.ts'
import { peerMessages, peersEvents, peersMaterializers } from './schema/peers.ts'
import { phoneNotifications, phones, phonesEvents, phonesMaterializers } from './schema/phones.ts'
import { planRequests, plans, plansEvents, plansMaterializers, planTasks } from './schema/plans.ts'
import {
  commentAttachments,
  comments,
  lineComments,
  messageDrafts,
  requestReturns,
  requestSnoozes,
  requestsEvents,
  requestsMaterializers,
  taskAttachments,
  taskBriefs,
  taskDraftConsumptions,
  taskDrafts,
} from './schema/requests.ts'
import {
  agentPauses,
  conversationTabs,
  heldRuns,
  promptTexts,
  runInterrupts,
  runMessages,
  runs,
  runsEvents,
  runsMaterializers,
  runUsage,
  subAgentInstructions,
  subAgentRequests,
} from './schema/runs.ts'
import { withTaskLog } from './schema/task-log.ts'
import {
  archiveUnblocks,
  taskBlockers,
  taskParents,
  taskTreeArchives,
  taskTreeEvents,
  taskTreeMaterializers,
} from './schema/task-tree.ts'
import {
  deletedTasks,
  stageEntries,
  stageFileTexts,
  taskDescriptions,
  taskLog,
  taskMoves,
  taskQueue,
  tasks,
  tasksEvents,
  tasksMaterializers,
  workflowLayers,
} from './schema/tasks.ts'
import { taskSources, trackersEvents, trackersMaterializers } from './schema/trackers.ts'

export * from './schema/apps.ts'
export * from './schema/automations.ts'
export * from './schema/chats.ts'
export * from './schema/checks.ts'
export * from './schema/execution.ts'
export * from './schema/factories.ts'
export * from './schema/failures.ts'
export * from './schema/machine.ts'
export * from './schema/merge.ts'
export * from './schema/peers.ts'
export * from './schema/phones.ts'
export * from './schema/plans.ts'
export * from './schema/requests.ts'
export * from './schema/runs.ts'
export * from './schema/task-log.ts'
export * from './schema/task-tree.ts'
export * from './schema/tasks.ts'
export * from './schema/trackers.ts'

export const events = {
  ...appsEvents,
  ...automationsEvents,
  ...chatsEvents,
  ...checksEvents,
  ...executionEvents,
  ...factoriesEvents,
  ...failuresEvents,
  ...machineEvents,
  ...mergeEvents,
  ...peersEvents,
  ...phonesEvents,
  ...plansEvents,
  ...requestsEvents,
  ...runsEvents,
  ...taskTreeEvents,
  ...tasksEvents,
  ...trackersEvents,
}

const materializers = counted(
  withTaskLog({
    ...appsMaterializers,
    ...automationsMaterializers,
    ...chatsMaterializers,
    ...checksMaterializers,
    ...executionMaterializers,
    ...factoriesMaterializers,
    ...failuresMaterializers,
    ...machineMaterializers,
    ...mergeMaterializers,
    ...peersMaterializers,
    ...phonesMaterializers,
    ...plansMaterializers,
    ...requestsMaterializers,
    ...runsMaterializers,
    ...taskTreeMaterializers,
    ...tasksMaterializers,
    ...trackersMaterializers,
  }),
)

const state = State.SQLite.makeState({
  tables: {
    intervalBoundaries,
    taskDrafts,
    taskDraftConsumptions,
    messageDrafts,
    factories,
    factoryRepos,
    factoryOrder,
    factoryLayout,
    tasks,
    taskQueue,
    executionPairing,
    executionMachine,
    executionAssignments,
    executionOperations,
    taskBlockers,
    taskParents,
    taskTreeArchives,
    archiveUnblocks,
    deletedTasks,
    taskMoves,
    taskAttachments,
    taskBrowserCaptures,
    runBrowserCaptures,
    commentAttachments,
    taskSources,
    runs,
    subAgentRequests,
    subAgentInstructions,
    promptTexts,
    reviewers,
    reviewScopes,
    baseConflicts,
    cleanupReports,
    p1OnlyReviews,
    severityDeclarations,
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
    runUsage,
    checkRuns,
    testInvocations,
    checkResults,
    checkBoundaries,
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
    automationCheckResults,
    automationCheckTasks,
    automationTaskActions,
    plans,
    planRequests,
    planTasks,
    coordinatorChats,
    chatAgents,
    chatCommands,
    outsideCommandAllowances,
    chatRequests,
    sideChats,
    requestSnoozes,
    phones,
    phoneNotifications,
    requestReturns,
  },
  materializers,
})

export const schema = makeSchema({ events, state })
