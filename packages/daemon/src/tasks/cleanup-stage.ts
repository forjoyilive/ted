import { randomUUID } from 'node:crypto'
import path from 'node:path'
import {
  type CleanupStepReport,
  type Comment,
  cleanupFinishChoice,
  cleanupRetryChoice,
  type OutcomeResult,
  type ReportCleanupStepRequest,
  type Task,
} from '@ted/protocol'
import { isCleanup } from '@ted/protocol/stage'
import { loginShell } from '../command-env.ts'
import { RequestError } from '../errors.ts'
import { redactSecrets } from '../redact.ts'
import type { CleanupCommandResult, StoredFactory, StoredTask, TedStore } from '../store/index.ts'
import { isCommandStep } from '../workflow/check.ts'
import type { ResolvedWorkflow } from '../workflow/resolve.ts'
import { cleanupStepsText } from '../workflow/workflow.ts'
import type { WorkflowResolution } from '../workflow/workflows.ts'
import type { CheckSlots } from './check-slots.ts'
import { checkEnv, defaultCheckTimeout } from './checks.ts'
import {
  type CleanupStatus,
  cleanupCommandReportRefusal,
  cleanupFailureBody,
  cleanupProgress,
  cleanupRestartNote,
  cleanupStatus,
  cleanupSteps,
} from './cleanup.ts'
import { cleanupCommandsText, runCleanupCommands } from './cleanup-commands.ts'
import type { CommandLaunch } from './command.ts'
import { factoryRepos, repoEntry, sameRepo } from './repos.ts'
import { answerTaskRequest } from './request-answers.ts'

interface CleanupOptions {
  store: TedStore
  checkSlots: Pick<CheckSlots, 'take'>
  checkWaits: Map<string, AbortController>
  signal: AbortSignal
  env(): NodeJS.ProcessEnv
  find(taskId: string): StoredTask
  factoryOf(task: Task): StoredFactory
  taskWorkflow(task: StoredTask, options: { fetch: boolean }): Promise<WorkflowResolution>
  moveToDone(task: StoredTask, resolution: WorkflowResolution): Promise<Task>
  deliver(task: StoredTask, text: string): Promise<boolean>
  inBackground(what: string, work: () => Promise<void>): void
  recoverTask(taskId: string, what: string, work: () => Promise<void>): void
  holding<T>(task: Task, work: () => Promise<T>): Promise<T>
  untilFree(taskId: string): Promise<void>
  openRequests(taskId: string): Comment[]
  drafts(taskId: string): string[]
  publicTask(id: string): Task
  pump(): Promise<void>
  prepareLaunch(task: StoredTask): Promise<CommandLaunch>
  checkDir(task: Task, name: string): string
  setChecking(taskId: string, on: boolean): void
  isChecking(taskId: string): boolean
}

export function createCleanup(options: CleanupOptions) {
  const { store, find, setChecking, inBackground, taskWorkflow } = options

  function openFailure(taskId: string): Comment | undefined {
    return options.openRequests(taskId).find((c) => c.cleanupFailure !== undefined)
  }

  function status(taskId: string, workflow: ResolvedWorkflow): CleanupStatus {
    return cleanupStatus(
      cleanupSteps(workflow),
      store.cleanupReports(taskId),
      openFailure(taskId) !== undefined,
    )
  }

  async function enter(taskId: string, workflow: ResolvedWorkflow, message: string): Promise<void> {
    if (status(taskId, workflow).pendingCommands.length === 0) {
      await afterCommands(taskId, workflow, message, [])
      return
    }
    setChecking(taskId, true)
    inBackground(`run ${find(taskId).displayId}’s Cleanup commands`, () =>
      runCommands(taskId, workflow, message),
    )
  }

  async function runCommands(
    taskId: string,
    workflow: ResolvedWorkflow,
    message: string,
  ): Promise<void> {
    const wait = new AbortController()
    options.checkWaits.set(taskId, wait)
    let ran: CleanupCommandResult[] = []
    let interrupted = false
    try {
      const task = find(taskId)
      const steps = status(taskId, workflow).pendingCommands
      const factory = options.factoryOf(task)
      const primary = task.repos.find((r) => !r.removed && sameRepo(r.repo, factory.repo))
      if (!primary) {
        ran = steps.map((step) => ({
          step: step.name,
          state: 'failed' as const,
          timeout: step.timeout ?? defaultCheckTimeout,
          durationMs: 0,
          output: 'Ted didn’t run the command: the Task has no worktree of the primary repo',
        }))
        for (const result of ran) store.recordCleanupCommand(taskId, result)
      } else {
        const signal = AbortSignal.any([options.signal, wait.signal])
        const release = await options.checkSlots.take({ taskId, signal })
        if (release === undefined) {
          interrupted = true
          return
        }
        const batch = randomUUID()
        try {
          const entry = repoEntry(factoryRepos(workflow, factory), primary)
          const env = options.env()
          const result = await runCleanupCommands({
            steps,
            cwd: primary.worktree,
            env: checkEnv(task.displayId, entry?.env ?? {}, env),
            shell: [loginShell(env), '-lc'],
            logFor: (position) =>
              path.join(options.checkDir(task, `cleanup-${batch}`), `${position + 1}.log`),
            prepareLaunch: () => options.prepareLaunch(find(taskId)),
            lowPriority: store.settings().lowPriorityWork,
            signal,
            record: (r) => store.recordCleanupCommand(taskId, r),
          })
          if (result.outcome === 'interrupted') {
            interrupted = true
            return
          }
          ran = result.results
        } finally {
          release()
        }
      }
    } finally {
      if (options.checkWaits.get(taskId) === wait) options.checkWaits.delete(taskId)
      setChecking(taskId, false)
      if (interrupted && !options.signal.aborted) runAgain(taskId, workflow, message)
    }
    await store.persisted()
    await afterCommands(taskId, workflow, message, ran)
  }

  function runAgain(taskId: string, workflow: ResolvedWorkflow, message: string) {
    const task = store.getTask(taskId)
    if (!task || !isCleanup(task.stage) || task.archived || find(taskId).stopped) return
    if (status(taskId, workflow).pendingCommands.length === 0) return
    inBackground(`run ${task.displayId}’s Cleanup commands again`, async () => {
      if (store.queue().some((q) => q.id === taskId)) store.dequeue(taskId)
      await enter(taskId, workflow, message)
    })
  }

  async function afterCommands(
    taskId: string,
    workflow: ResolvedWorkflow,
    message: string,
    ran: readonly CleanupCommandResult[],
  ): Promise<void> {
    const task = store.getTask(taskId)
    if (!task || !isCleanup(task.stage) || task.archived || task.stopped) return
    const now = status(taskId, workflow)
    if (now.left === 'nothing') {
      inBackground(`finish ${task.displayId}’s Cleanup`, async () => {
        await options.untilFree(taskId)
        await options.holding(find(taskId), async () => {
          const current = find(taskId)
          if (!isCleanup(current.stage) || current.stopped || current.archived) return
          await finish(current, await taskWorkflow(current, { fetch: false }))
        })
      })
      return
    }
    const text =
      ran.length > 0 ? `${message}\n\n${cleanupCommandsText(ran, now.unreported.length)}` : message
    if (!(await options.deliver(task, text))) {
      store.resumeTask(taskId, { waitForBlockers: false })
      await store.persisted()
      void options.pump()
    }
  }

  async function finish(task: StoredTask, resolution: WorkflowResolution): Promise<OutcomeResult> {
    const asked = openFailure(task.id)
    if (asked)
      throw new RequestError(
        409,
        `Ted asked the user what to do about the failed Cleanup steps (request ${asked.id}); wait for their answer`,
      )
    const now = status(task.id, resolution.workflow)
    if (now.pendingCommands.length > 0) {
      await enter(
        task.id,
        resolution.workflow,
        'Ted ran the Cleanup commands that had no result yet.',
      )
      return {
        task: options.publicTask(task.id),
        message:
          'Ted is running the Cleanup commands that have no result yet and sends you their results. End your turn.',
      }
    }
    if (now.missing.length > 0)
      throw new RequestError(
        409,
        `report every Cleanup step first with \`ted cleanup report "<step name>" done|skipped|failed "<what happened>"\`; still to report: ${now.missing.map((step) => `“${step.name}”`).join(', ')}`,
      )
    if (now.failed.length === 0) {
      await options.moveToDone(task, resolution)
      return { task: options.publicTask(task.id), message: `${task.displayId} moved to Done` }
    }
    const names = now.failed.map((step) => step.name)
    const request = store.postComment({
      taskId: task.id,
      kind: 'question',
      author: { kind: 'ted' },
      title:
        names.length === 1
          ? `A Cleanup step failed: ${names[0]}`
          : `${names.length} Cleanup steps failed`,
      body: cleanupFailureBody(
        now.failed.map((step) => ({ step, report: now.reports.get(step.name) })),
      ),
      choices: [cleanupRetryChoice, cleanupFinishChoice],
      cleanupFailure: { steps: names },
    })
    return {
      task: options.publicTask(task.id),
      message: `Ted asked the user whether to try the failed Cleanup steps again or finish anyway (request ${request.id}). End your turn; Ted sends you their answer.`,
      request,
    }
  }

  async function answerFailure(
    task: StoredTask,
    comment: Comment,
    choice: string | undefined,
    text: string,
  ): Promise<Comment> {
    if (choice !== cleanupRetryChoice && choice !== cleanupFinishChoice)
      throw new RequestError(400, `answer with ${cleanupRetryChoice} or ${cleanupFinishChoice}`)
    const picked: string = choice
    return options.holding(task, async () => {
      const current = find(task.id)
      const open = store.getComment(comment.id)
      if (open?.answer) throw new RequestError(409, 'this request has already been answered')
      if (!isCleanup(current.stage))
        throw new RequestError(409, `${current.displayId} isn’t in Cleanup any more`)
      const steps = comment.cleanupFailure?.steps ?? []
      const resolution = await taskWorkflow(current, { fetch: true })
      const at = new Date().toISOString()
      const answered = answerTaskRequest(
        store,
        current,
        comment,
        { kind: 'answered', at, choice: picked, ...(text !== '' && { text }) },
        options.drafts(current.id),
      )
      if (picked === cleanupFinishChoice) {
        store.finishCleanupAnyway(current.id, steps)
        store.postComment({
          taskId: current.id,
          author: { kind: 'ted' },
          body: `The user chose Finish anyway. These Cleanup steps didn’t happen: ${steps.map((name) => `“${name}”`).join(', ')}.`,
        })
        await options.moveToDone(current, resolution)
        return store.getComment(answered.id) ?? answered
      }
      store.retryCleanup(current.id, steps)
      const retry = cleanupSteps(resolution.workflow).filter((step) => steps.includes(step.name))
      const message = [
        `The user chose ${cleanupRetryChoice}${text === '' ? '.' : `, and wrote:\n\n${text}`}`,
        retry.length > 0
          ? cleanupStepsText(retry, '# Cleanup steps to redo')
          : 'The failed steps are no longer in the Factory’s Cleanup steps, so there is nothing to redo.',
        retry.some((step) => !isCommandStep(step))
          ? 'Report each instruction step again, post a note, then run `ted outcome advance`.'
          : '',
      ]
        .filter((part) => part !== '')
        .join('\n\n')
      await store.persisted()
      await enter(current.id, resolution.workflow, message)
      return store.getComment(answered.id) ?? answered
    })
  }

  async function report(
    task: StoredTask,
    runId: string,
    input: ReportCleanupStepRequest,
  ): Promise<CleanupStepReport[]> {
    if (!isCleanup(task.stage)) throw new RequestError(409, `${task.displayId} isn’t in Cleanup`)
    if (openFailure(task.id))
      throw new RequestError(
        409,
        'Ted asked the user what to do about the failed Cleanup steps; wait for their answer',
      )
    const { workflow } = await taskWorkflow(task, { fetch: false })
    const steps = cleanupSteps(workflow)
    const step = steps.find((s) => s.name === input.step)
    if (!step)
      throw new RequestError(
        400,
        `“${input.step}” isn’t one of the Cleanup steps: ${steps.map((s) => `“${s.name}”`).join(', ')}`,
      )
    if (isCommandStep(step)) throw new RequestError(409, cleanupCommandReportRefusal(step.name))
    store.reportCleanupStep(task.id, runId, { ...input, text: redactSecrets(input.text) })
    await store.persisted()
    return store.cleanupReports(task.id)
  }

  async function queued(task: StoredTask): Promise<boolean> {
    const { workflow } = await taskWorkflow(task, { fetch: false })
    if (status(task.id, workflow).pendingCommands.length === 0) return false
    store.dequeue(task.id)
    if (!options.isChecking(task.id)) await enter(task.id, workflow, cleanupRestartNote)
    return true
  }

  function recover(): void {
    for (const task of store.listTasks()) {
      if (!isCleanup(task.stage) || find(task.id).stopped || task.archived) continue
      if (openFailure(task.id)) continue
      setChecking(task.id, true)
      options.recoverTask(task.id, `run ${task.displayId}’s Cleanup commands again`, async () => {
        let workflow: ResolvedWorkflow
        try {
          workflow = (await taskWorkflow(find(task.id), { fetch: false })).workflow
        } finally {
          setChecking(task.id, false)
        }
        const now = status(task.id, workflow)
        if (now.pendingCommands.length > 0) {
          await enter(task.id, workflow, cleanupRestartNote)
        } else if (cleanupSteps(workflow).every(isCommandStep) && now.left === 'nothing') {
          await afterCommands(task.id, workflow, cleanupRestartNote, [])
        }
      })
    }
  }

  function progress(taskId: string, workflow: ResolvedWorkflow): string | undefined {
    return cleanupProgress(cleanupSteps(workflow), store.cleanupReports(taskId))
  }

  return { enter, finish, answerFailure, report, queued, recover, progress }
}
