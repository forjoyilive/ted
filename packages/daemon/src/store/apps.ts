import { randomUUID } from 'node:crypto'
import { queryDb } from '@livestore/livestore'
import type { AppStarter, Attachment, Comment, SimulatorAsk } from '@ted/protocol'
import { type AutomationDraftStore, createAutomationDraftStore } from './automation-drafts.ts'
import { type AutomationStore, createAutomationStore } from './automations.ts'
import type { StoreContext } from './context.ts'
import { automationTasks, events } from './schema.ts'
import type { NewComment } from './types.ts'

export interface AppsArea {
  createdByAutomation(taskId: string): boolean
  appStarted(input: {
    taskId: string
    repo: string
    name: string
    port?: number
    url?: string
    by: AppStarter
    runId?: string
    restart: boolean
  }): void
  appStopped(input: { taskId: string; repo: string; name: string }): void
  appExited(input: {
    taskId: string
    repo: string
    name: string
    code?: number
    signal?: string
  }): void
  appStartFailed(input: { taskId: string; repo: string; name: string; problem: string }): void
  noteAppStarting(taskId: string, app: string | undefined): void
  simulatorShutDown(input: {
    taskId: string
    repo: string
    name: string
    forTask?: string
    idle: boolean
  }): void
  emulatorShutDown(input: {
    taskId: string
    repo: string
    name: string
    forTask?: string
    idle: boolean
  }): void
  requestSimulator(input: {
    taskId: string
    runId: string
    title: string
    body: string
    simulator: SimulatorAsk
  }): Comment
  postAutomationNote(input: NewComment, link: { automationId: string; firingId: string }): Comment
  recordBrowserCapture(taskId: string, attachment: Attachment): void
  browserCaptures(taskId: string): Attachment[]
  automationDrafts: AutomationDraftStore
  automations: AutomationStore
}

export function appsArea(ctx: StoreContext): AppsArea {
  const {
    store,
    commit,
    factoryKey,
    browserCapturesOf,
    toRun,
    taskRow,
    requireTaskRow,
    runRow,
    emit,
    requireComment,
    commentPosted,
    updatedTask,
    noteActivity,
    appsStarting,
  } = ctx
  const automationStore = createAutomationStore({
    store,
    commit,
    emit,
    changed: () => noteActivity(),
    factoryKey,
  })

  return {
    automationDrafts: createAutomationDraftStore({ store, commit }),
    automations: automationStore,
    appStarted({ taskId, repo, name, port, url, by, runId, restart }) {
      commit(
        events.appStarted({
          taskId,
          repo,
          name,
          port: port ?? null,
          url: url ?? null,
          by,
          runId: runId ?? null,
          restart,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    appStopped({ taskId, repo, name }) {
      commit(events.appStopped({ taskId, repo, name, at: new Date().toISOString() }))
      updatedTask(taskId)
    },
    appExited({ taskId, repo, name, code, signal }) {
      commit(
        events.appExited({
          taskId,
          repo,
          name,
          code: code ?? null,
          signal: signal ?? null,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    noteAppStarting(taskId, app) {
      if (appsStarting.get(taskId) === app) return
      if (app === undefined) appsStarting.delete(taskId)
      else appsStarting.set(taskId, app)
      if (taskRow(taskId)) updatedTask(taskId)
    },
    appStartFailed({ taskId, repo, name, problem }) {
      commit(events.appStartFailed({ taskId, repo, name, problem, at: new Date().toISOString() }))
      updatedTask(taskId)
    },
    simulatorShutDown({ taskId, repo, name, forTask, idle }) {
      commit(
        events.simulatorShutDown({
          taskId,
          repo,
          name,
          forTask: forTask ?? null,
          idle,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    emulatorShutDown({ taskId, repo, name, forTask, idle }) {
      commit(
        events.emulatorShutDown({
          taskId,
          repo,
          name,
          forTask: forTask ?? null,
          idle,
          at: new Date().toISOString(),
        }),
      )
      updatedTask(taskId)
    },
    requestSimulator({ taskId, runId, title, body, simulator }) {
      const id = randomUUID()
      const at = new Date().toISOString()
      const run = runRow(runId)
      const pause = run !== undefined && run.state === 'working'
      commit(
        events.simulatorRequested({
          id,
          taskId,
          runId,
          stage: taskRow(taskId)?.stage ?? null,
          title,
          body,
          simulator: JSON.stringify(simulator),
          createdAt: at,
        }),
        events.commentPurposeRecorded({
          commentId: id,
          purpose: JSON.stringify({ kind: 'simulator' }),
        }),
        ...(pause ? [events.runStateChanged({ runId, state: 'waiting', at })] : []),
      )
      const comment = requireComment(id)
      emit({ type: 'comment-posted', comment })
      if (pause) {
        const updated = runRow(runId)
        if (updated) emit({ type: 'run-updated', run: toRun(updated) })
        noteActivity()
      }
      updatedTask(taskId)
      return comment
    },
    createdByAutomation(taskId) {
      return store.query(queryDb(automationTasks.where({ taskId }))).length > 0
    },
    recordBrowserCapture(taskId, attachment) {
      requireTaskRow(taskId)
      commit(
        events.taskBrowserCaptureAdded({ taskId, ...attachment, at: new Date().toISOString() }),
      )
    },
    browserCaptures: browserCapturesOf,
    postAutomationNote(input, link) {
      const at = new Date().toISOString()
      const { id, event } = commentPosted(input, at)
      commit(event, events.automationTaskNoted({ ...link, taskId: input.taskId, at }))
      const comment = requireComment(id)
      emit({ type: 'comment-posted', comment })
      emit({ type: 'automation-updated', automationId: link.automationId })
      return comment
    },
  }
}
