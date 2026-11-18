import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  AgentStageId,
  CheckRun,
  CheckRunTrigger,
  CheckState,
  FailureCase,
  FailureContext,
  QueuedAfter,
  ResolveFailureRequest,
  Task,
  ValidationProgress,
} from '@ted/protocol'
import { failureChoices, validationExecution } from '@ted/protocol'
import { shortReference } from '@ted/protocol/reference'
import { handsOff, mergesHere, stageWith, validates } from '@ted/protocol/stage'
import { RequestError } from '../errors.ts'
import type { MemoryWatch } from '../memory-kills.ts'
import { redactSecrets } from '../redact.ts'
import type { StoredTask, TedStore } from '../store/index.ts'
import type { WorkflowResolution } from '../workflow/workflows.ts'
import { type CheckRunnerResult, type RunnableCheck, runChecks, summary } from './checks.ts'
import type { CommandLaunch } from './command.ts'
import { type createFailureCases, generatedFailureText, sameTested } from './failure-cases.ts'
import { sameCheckPlan, validationReport } from './validation-report.ts'
import { type WorktreeReads, worktreeReads } from './worktree-reads.ts'

interface ValidationOptions {
  store: TedStore
  failures: ReturnType<typeof createFailureCases>
  find(id: string): StoredTask
  context(task: Task, reads?: WorktreeReads): Promise<Pick<FailureContext, 'repos' | 'checks'>>
  workflow(task: StoredTask): Promise<WorkflowResolution>
  plan(
    task: StoredTask,
    resolution: WorkflowResolution,
    only?: string,
    reads?: WorktreeReads,
  ): Promise<RunnableCheck[]>
  checkSandbox(task: StoredTask): Promise<void>
  prepareLaunch(task: StoredTask): Promise<CommandLaunch>
  reportingEnv?: (
    task: Task,
    checkRunId: string,
    position: number,
    supported: boolean,
  ) => Promise<Record<string, string>>
  env(): NodeJS.ProcessEnv
  libraryDir: string
  signal: AbortSignal
  lowPriority(): boolean
  memory?: MemoryWatch
  memoryKilled(
    taskId: string,
    checkRunId: string,
    killed: NonNullable<CheckRunnerResult['killed']>,
  ): Promise<'retry' | 'failed' | 'interrupted'>
  takeCheckSlot(taskId: string, checkRunId: string): Promise<(() => void) | undefined>
  checkCpus(): number
  checkLog(task: Task, id: string, position: number): string
  checkDir(task: Task, id: string): string
  findings(task: Task, run: CheckRun): Promise<string | undefined>
  reportNotFound(task: Task, result: CheckRunnerResult): void
  setChecking(id: string, on: boolean): void
  isChecking(id: string): boolean
  deliver(task: StoredTask, message: string, after: QueuedAfter): Promise<unknown>
  notify(task: StoredTask): Promise<void>
  instructions(task: StoredTask, resolution: WorkflowResolution, message?: string): Promise<string>
  returnToWork(taskId: string, findings: string, checkRunId: string): Promise<void>
  diagnosing(task: Task): boolean
  leaveWork(
    task: StoredTask,
  ): Promise<(message: string, carried: ValidationProgress) => Promise<Task>>
  apps(task: StoredTask): Promise<string | undefined>
  fix(task: StoredTask, value: FailureCase): Promise<void>
  checkFix(resolution: WorkflowResolution, task: StoredTask): void
  holding<T>(task: Task, work: () => Promise<T>): Promise<T>
  background(what: string, work: () => Promise<void>): void
}

export class StaleCoverageError extends RequestError {
  constructor() {
    super(
      409,
      'The checks haven’t run on the Task’s current code, so Ted can’t move it on yet. Ted runs them first when the Task is moved on.',
    )
  }
}

interface MergeHold {
  why?: string
}

const mergeChecksRunning =
  'Ted is running the checks on the code it will merge, because they haven’t run on it yet.'
const mergeCodeChanged = 'The Task’s code changed while the checks ran, so Ted runs them again.'

export function createValidation(options: ValidationOptions) {
  const { store, failures, find, reportingEnv } = options
  const visitStart = (task: Task) => {
    const entries = store.listStageEntries(task.id)
    const merge = entries.findLast((e) => mergesHere(e.stage))?.at ?? ''
    return (
      (mergesHere(task.stage) ? store.latestRebase(task.id, merge) : undefined) ??
      entries.findLast((e) => validates(e.stage))?.at ??
      ''
    )
  }
  const coverageOf = (context: Pick<FailureContext, 'repos' | 'checks'>) =>
    JSON.stringify({
      repos: context.repos.map(({ repo, head, tree }) => ({ repo, head, tree })),
      checks: context.checks,
    })
  const coverage = async (task: Task, reads?: WorktreeReads) =>
    options
      .context(task, reads)
      .then(coverageOf)
      .catch(() => undefined)
  const codeOf = (covered: string) => JSON.stringify(JSON.parse(covered).repos)
  const merged = (task: Task) => {
    const opened = task.repos.filter((r) => !r.removed && r.pullRequest !== undefined)
    return (
      mergesHere(task.stage) &&
      opened.length > 0 &&
      opened.every((r) => r.pullRequest?.state === 'merged')
    )
  }

  async function failureEvidence(task: Task, run: CheckRun, position: number) {
    const evidence = generatedFailureText(
      (await options.findings(task, run)) ?? summary(run.checks),
    )
    const reference = `\n\nFull output: ${options.checkLog(task, run.id, position)}`
    return evidence.slice(0, Math.max(0, 16_000 - reference.length)) + reference
  }

  function verifyPassed(task: Task, run: CheckRun) {
    for (const prior of store.failures.list(task.id)) {
      const original = failures.sourceCheck(prior)
      if (
        (!prior.validation &&
          !(
            prior.source.kind === 'post-rebase-check' &&
            prior.resolutions.at(-1)?.resolution === 'repair'
          )) ||
        prior.verifications?.length ||
        (prior.source.kind !== 'factory-check' && prior.source.kind !== 'post-rebase-check') ||
        prior.source.checkRunId === run.id ||
        !original ||
        run.startedAt < prior.createdAt
      )
        continue
      const decision = prior.resolutions.at(-1)
      if (
        decision?.resolution === 'repair' &&
        !failures.abandonedRepair(prior) &&
        !prior.repairProgress?.some(
          (p) => p.requestId === decision.requestId && run.startedAt >= p.at,
        )
      )
        continue
      if (
        decision?.resolution === 'accepted' &&
        !prior.invalidations.some((i) => i.requestId === decision.requestId)
      )
        continue
      if (
        run.checks.some(
          (c) =>
            c.state === 'passed' &&
            c.name === original.name &&
            c.repo === original.repo &&
            c.command === original.command,
        )
      )
        failures.verifyResult(task, prior.id, `Verification passed in check run ${run.id}.`, run.id)
    }
  }

  function mergeChecksStarted(task: Task): boolean {
    const since = store.listStageEntries(task.id).findLast((e) => mergesHere(e.stage))?.at ?? ''
    return store
      .listCheckRuns(task.id)
      .some((run) => run.trigger === 'merge' && mergesHere(run.stage) && run.startedAt >= since)
  }

  async function beginChecks(
    task: StoredTask,
    resolution: WorkflowResolution,
    trigger: CheckRunTrigger,
    only?: string,
    reads: WorktreeReads = worktreeReads(),
  ): Promise<{ checkRun: CheckRun; done: Promise<CheckRunnerResult> } | undefined> {
    const hold = store.newWorkHold()
    if (hold) throw new RequestError(409, hold)
    const requested = trigger === 'agent'
    const mergeVisit =
      store.listStageEntries(task.id).findLast((e) => mergesHere(e.stage))?.at ?? ''
    const merging =
      mergesHere(task.stage) &&
      (trigger === 'merge' ||
        store.latestRebase(task.id, mergeVisit) !== undefined ||
        mergeChecksStarted(task))
    if (merging) trigger = 'merge'
    const validating = validates(task.stage) && trigger !== 'merge' && trigger !== 'hand-off'
    const diagnosing = validating || merging
    const existing = store.failures.progress(task.id)
    const order = resolution.workflow.order
    const tracking =
      diagnosing ||
      (visitStart(task) !== '' &&
        only === undefined &&
        order.indexOf(task.stage as AgentStageId) > order.indexOf(stageWith('validates')))
    let plan = await options.plan(task, resolution, merging ? undefined : only, reads)
    if (plan.length === 0) {
      if (tracking) {
        store.failures.saveProgress({
          taskId: task.id,
          visit: visitStart(task),
          checks: [],
          executions: [],
          next: 0,
          pending: false,
        })
        await store.persisted()
      }
      return undefined
    }
    let progress = tracking ? existing : undefined
    let start = 0
    let contextId: string | undefined
    if (tracking) {
      const local = await coverage(task, reads)
      const context = diagnosing ? await failures.snapshot(task).catch(() => undefined) : undefined
      if (context) contextId = store.failures.capture(context).id
      if (context) await failures.obligations(task, context)
      const prior = progress?.contextId ? store.failures.context(progress.contextId) : undefined
      const incorporation = store.failures
        .list(task.id)
        .flatMap((value) => {
          const decision = value.resolutions.at(-1)
          return decision?.resolution === 'repair' && !value.verifications?.length
            ? (value.repairProgress ?? []).filter((p) => p.requestId === decision.requestId)
            : []
        })
        .sort((a, b) => a.at.localeCompare(b.at))
        .at(-1)
      const repairNeedsExecution =
        incorporation !== undefined &&
        !progress?.executions.some((execution) => {
          const run = store.getCheckRun(execution.runId)
          return (
            execution.start === 0 &&
            run?.stage === task.stage &&
            run.trigger === trigger &&
            run.startedAt >= incorporation.at
          )
        })
      if (
        !progress ||
        repairNeedsExecution ||
        progress.visit !== visitStart(task) ||
        !local ||
        (progress.coverage ?? (prior && coverageOf(prior))) !== local ||
        sameCheckPlan(progress.checks) !== sameCheckPlan(plan.map((p) => p.check)) ||
        progress.checks.some((c, i) => c.state === 'skipped' && plan[i]?.check.state !== 'skipped')
      ) {
        progress = {
          taskId: task.id,
          visit: visitStart(task),
          ...(contextId && { contextId }),
          ...(local && { coverage: local }),
          checks: plan.map((p) => p.check),
          executions: [],
          next: 0,
          pending: true,
        }
      }
      if ((!diagnosing || requested) && progress.next >= plan.length) {
        const next = only === undefined ? 0 : plan.findIndex((p) => p.check.name === only)
        if (next < 0) throw new RequestError(404, 'no matching check')
        progress = {
          ...progress,
          next,
          checks: [...progress.checks.slice(0, next), ...plan.slice(next).map((p) => p.check)],
          pending: true,
        }
      }
      if (!diagnosing) progress = { ...progress, next: 0, pending: true }
      start = progress.next
      if (only !== undefined && progress.checks[start]?.name !== only)
        throw new RequestError(
          409,
          'run the outstanding Validate checks in order; the requested check is not next',
        )
      if (start >= plan.length) {
        store.failures.saveProgress({ ...progress, pending: false })
        await store.persisted()
        return undefined
      }
      plan = plan.slice(start)
    }
    await options.checkSandbox(task)
    const checkRun = store.startChecks({
      taskId: task.id,
      trigger,
      stage: task.stage,
      checks: plan.map((p) => p.check),
    })
    if (progress)
      store.failures.saveProgress({
        ...progress,
        pending: true,
        executions: [
          ...progress.executions,
          { runId: checkRun.id, start, ...(contextId && { contextId }) },
        ],
      })
    await store.persisted()
    const done = (async () => {
      const release = await options.takeCheckSlot(task.id, checkRun.id).catch((error: unknown) => {
        console.error(
          redactSecrets(`couldn’t record ${task.displayId}’s check slot: ${String(error)}`),
        )
        return undefined
      })
      if (release === undefined) {
        if (!options.signal.aborted) store.finishChecks(checkRun.id, 'interrupted')
        return { outcome: 'interrupted' as const, notFound: [] }
      }
      const finishedCheck = (
        position: number,
        finished: { state: CheckState; exitCode?: number; durationMs: number },
      ) => {
        store.checkFinished(checkRun.id, position, finished)
        if (tracking) {
          const executed = store.getCheckRun(checkRun.id)
          if (executed) verifyPassed(find(task.id), executed)
          const current = store.failures.progress(task.id)
          if (current?.executions.at(-1)?.runId === checkRun.id) {
            const checks = [...current.checks]
            const original = checks[start + position]
            if (!original) throw new Error('missing planned check')
            checks[start + position] = { ...original, ...finished }
            store.failures.saveProgress({
              ...current,
              checks,
              next: finished.state === 'passed' ? start + position + 1 : start + position,
            })
          }
        }
      }
      const runFrom = (from: number) =>
        runChecks({
          checks: plan,
          from,
          taskDisplayId: task.displayId,
          libraryDir: options.libraryDir,
          env: options.env(),
          logFor: (position) => options.checkLog(task, checkRun.id, position),
          prepareLaunch: () => options.prepareLaunch(find(task.id)),
          signal: options.signal,
          lowPriority: options.lowPriority(),
          cpus: options.checkCpus,
          ...(options.memory && { memory: options.memory }),
          onInterrupted: (position) => store.checkInterrupted(checkRun.id, position),
          ...(reportingEnv && {
            reportingEnv: (position: number, supported: boolean) =>
              reportingEnv(task, checkRun.id, position, supported),
          }),
          onStart: (position) => store.checkStarted(checkRun.id, position),
          onFinish: finishedCheck,
        })
      const result = await (async (): Promise<
        Omit<CheckRunnerResult, 'outcome'> & { outcome: 'passed' | 'failed' | 'interrupted' }
      > => {
        await store.persisted()
        const notFound: string[] = []
        let from = 0
        for (;;) {
          const ran = await runFrom(from)
          notFound.push(...ran.notFound)
          if (ran.outcome !== 'memory') return { ...ran, outcome: ran.outcome, notFound }
          const killed = ran.killed
          if (!killed) return { outcome: 'interrupted', notFound }
          const next = await options.memoryKilled(task.id, checkRun.id, killed)
          if (next === 'interrupted') return { outcome: 'interrupted', notFound }
          if (next === 'failed') {
            const finished = { state: 'failed' as const, durationMs: killed.durationMs }
            finishedCheck(killed.position, finished)
            return {
              outcome: 'failed',
              failed: { position: killed.position, check: killed.check, ...finished },
              notFound,
            }
          }
          from = killed.position
        }
      })()
        .catch((error: unknown) => {
          console.error(`couldn’t run ${task.displayId}’s checks:`, error)
          return { outcome: 'interrupted' as const, notFound: [] }
        })
        .finally(release)
      if (result.outcome === 'interrupted' && options.signal.aborted) return result
      store.finishChecks(checkRun.id, result.outcome)
      options.reportNotFound(task, result)
      if (tracking && result.outcome !== 'interrupted') {
        const current = store.failures.progress(task.id)
        if (current?.executions.at(-1)?.runId === checkRun.id) {
          const executed = store.getCheckRun(checkRun.id) ?? checkRun
          verifyPassed(find(task.id), executed)
          let failureId: string | undefined
          if (diagnosing && result.failed) {
            const stored = store.getCheckRun(checkRun.id) ?? checkRun
            const evidence = await failureEvidence(task, stored, result.failed.position)
            const value = await failures.recordCheck(find(task.id), task.leadRunId ?? 'ted', {
              source: {
                kind: trigger === 'merge' ? 'post-rebase-check' : 'factory-check',
                checkRunId: checkRun.id,
                position: result.failed.position,
              },
              evidence,
              ...(contextId && { contextId }),
            })
            failureId = value.id
            failures.replaceOlder(task, value, checkRun.id)
          }
          store.failures.saveProgress({
            ...current,
            checks: [...current.checks.slice(0, start), ...executed.checks],
            next: result.outcome === 'passed' ? current.checks.length : current.next,
            pending: false,
            ...(failureId ? { failureId } : { failureId: undefined }),
          })
          await store.persisted()
        }
      }
      return result
    })()
    return { checkRun, done }
  }

  function validationFixes(task: Task): FailureCase[] {
    return store.failures.list(task.id).filter((value) => {
      const decision = value.resolutions.at(-1)
      return (
        value.validation &&
        decision?.resolution === 'fix' &&
        decision.at >= visitStart(task) &&
        !value.verifications?.length
      )
    })
  }

  async function resumeValidation(taskId: string): Promise<void> {
    const task = find(taskId)
    const progress = store.failures.progress(taskId)
    if (!validates(task.stage) || task.archived || task.stopped) {
      options.setChecking(taskId, false)
      return
    }
    for (const execution of progress?.executions ?? []) {
      const run = store.getCheckRun(execution.runId)
      if (run) verifyPassed(task, run)
    }
    const fixes = validationFixes(task)
    if (fixes.length) {
      options.setChecking(taskId, false)
      await options.holding(task, async () => {
        for (const value of fixes) {
          if (!validates(find(taskId).stage)) break
          await options.fix(find(taskId), value)
        }
      })
      return
    }
    if (!progress || progress.visit !== visitStart(task)) {
      await validateChecks(taskId)
      return
    }
    if (await resumeFailedCheck(task)) await validateChecks(taskId)
  }

  async function resumeFailedCheck(task: StoredTask): Promise<boolean> {
    const taskId = task.id
    const progress = store.failures.progress(taskId)
    if (!progress) return true
    const kind = mergesHere(task.stage) ? 'post-rebase-check' : 'factory-check'
    const execution = progress.executions.at(-1)
    const run = execution && store.getCheckRun(execution.runId)
    const position =
      run?.checks.findIndex((c) => c.state === 'failed' || c.state === 'timed-out') ?? -1
    if (run && execution && position >= 0) {
      const existing = store.failures
        .list(taskId)
        .find(
          (f) =>
            f.source.kind === kind &&
            f.source.checkRunId === run.id &&
            f.source.position === position,
        )
      const value =
        existing ??
        (await failures.recordCheck(task, task.leadRunId ?? 'ted', {
          source: { kind, checkRunId: run.id, position },
          evidence: await failureEvidence(task, run, position),
          ...(execution.contextId && { contextId: execution.contextId }),
        }))
      const decision = value.resolutions.at(-1)
      if (
        decision?.resolution === 'accepted' &&
        !value.invalidations.some((i) => i.requestId === decision.requestId)
      ) {
        store.failures.saveProgress({
          ...progress,
          failureId: value.id,
          next: Math.max(progress.next, execution.start + position + 1),
          pending: true,
        })
      } else if (decision?.resolution === 'retry') {
        store.failures.saveProgress({
          ...progress,
          failureId: value.id,
          next: execution.start + position,
          pending: true,
        })
      } else {
        if (
          mergesHere(task.stage) &&
          progress.failureId === value.id &&
          !progress.pending &&
          progress.next === execution.start + position
        ) {
          await options.notify(task)
          return false
        }
        store.failures.saveProgress({
          ...progress,
          failureId: value.id,
          next: execution.start + position,
          pending: false,
        })
        options.setChecking(taskId, false)
        await store.persisted()
        const unreturned = unreturnedEntryFailure(find(taskId))
        if (unreturned) {
          const resolution = await options.workflow(find(taskId))
          await returnFailedChecks(taskId, unreturned, instructionsWith(taskId, resolution))
          return false
        }
        if (validates(task.stage))
          await options.deliver(
            task,
            `Validate failure ${shortReference(value.id)} still needs diagnosis or a human decision. Original evidence:\n\n${value.evidence}`,
            'checks-done',
          )
        if (mergesHere(task.stage)) await options.notify(task)
        return false
      }
    }
    return true
  }

  function carryOver(task: StoredTask, carried: ValidationProgress): void {
    const saved = store.failures.progress(task.id)
    if (
      !validates(task.stage) ||
      saved?.visit !== carried.visit ||
      saved.executions.at(-1)?.runId !== carried.executions.at(-1)?.runId
    )
      return
    store.failures.saveProgress({ ...saved, visit: visitStart(task) })
  }

  const instructionsWith =
    (taskId: string, resolution: WorkflowResolution, message?: string) => async (text: string) => {
      const current = find(taskId)
      const instructions = await options.instructions(current, resolution, message)
      const apps = current.setup ? await options.apps(current) : undefined
      return [
        instructions,
        ...(text === '' ? [] : [text]),
        ...(apps === undefined ? [] : [apps]),
      ].join('\n\n')
    }

  function unreturnedEntryFailure(task: Task): CheckRun | undefined {
    const progress = store.failures.progress(task.id)
    const runId = progress?.executions.at(-1)?.runId
    const run = runId === undefined ? undefined : store.getCheckRun(runId)
    if (
      !validates(task.stage) ||
      progress?.visit !== visitStart(task) ||
      run?.trigger !== 'validate' ||
      run.outcome !== 'failed'
    )
      return undefined
    const diagnosed = store.failures
      .list(task.id)
      .some(
        (value) =>
          value.source.kind === 'factory-check' &&
          value.source.checkRunId === run.id &&
          (value.assessments.length > 0 || value.resolutions.length > 0),
      )
    const held =
      store.sendBackAsks(task.id).some((ask) => ask.checkRunId === run.id) ||
      store.loopChecks(task.id).some((check) => check.checkRunId === run.id)
    return diagnosed || held || options.diagnosing(task) ? undefined : run
  }

  async function returnFailedChecks(
    taskId: string,
    checkRun: CheckRun,
    withInstructions: (text: string) => Promise<string>,
  ): Promise<void> {
    const current = find(taskId)
    const findings = generatedFailureText(
      (await options.findings(current, checkRun)) ?? summary(checkRun.checks),
    )
    const dir = options.checkDir(current, checkRun.id)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFile(path.join(dir, 'findings.md'), findings, { mode: 0o600 })
    options.setChecking(taskId, false)
    if (options.diagnosing(current)) {
      const failureId = store.failures.progress(taskId)?.failureId
      await options.deliver(
        find(taskId),
        await withInstructions(
          `# A check failed\n\nThe Task stays in Validate. Investigate failure case ${failureId ? shortReference(failureId) : '(see ted failure list)'}, add evidence and assess regression, unrelated or uncertain. A supported regression goes back through \`ted outcome back\`; unrelated or uncertain causes require a human decision. Investigation and retry do not count as send-backs.\n\n${findings}`,
        ),
        'checks-done',
      )
      return
    }
    let problem: string | undefined
    try {
      await options.returnToWork(taskId, findings, checkRun.id)
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error)
    }
    if (problem === undefined) return
    console.error(redactSecrets(`couldn’t send ${current.displayId} back to Work: ${problem}`))
    const failureId = store.failures.progress(taskId)?.failureId
    const reference = failureId ? shortReference(failureId) : '<id>'
    await options.deliver(
      find(taskId),
      await withInstructions(
        `# A check failed\n\nTED couldn’t send the Task back to Work: ${redactSecrets(problem)}. If this change caused failure case ${reference}, send the Task back with \`ted outcome back\`. If the cause is outside the Task, add evidence, assess it and run \`ted failure ask ${reference}\` so the human can decide.\n\n${findings}`,
      ),
      'checks-done',
    )
  }

  async function validateChecks(taskId: string, message?: string): Promise<void> {
    options.setChecking(taskId, true)
    try {
      const task = find(taskId)
      const resolution = await options.workflow(find(task.id))
      const withInstructions = instructionsWith(taskId, resolution, message)
      const started = await beginChecks(task, resolution, 'validate', undefined, worktreeReads())
      if (!started) {
        const progress = store.failures.progress(taskId)
        const report = progress
          ? `# Validation results\n\n${validationReport(progress, store.failures.list(taskId))}`
          : ''
        await options.deliver(task, await withInstructions(report), 'checks-done')
        return
      }
      const result = await started.done
      const checkRun = store.getCheckRun(started.checkRun.id) ?? started.checkRun
      const current = find(taskId)
      if (result.outcome === 'interrupted' || !validates(current.stage)) return
      if (result.outcome === 'passed') {
        const progress = store.failures.progress(taskId)
        const previousFailures = progress?.checks.some(
          (c) => c.state === 'failed' || c.state === 'timed-out',
        )
        const checksReport =
          previousFailures && progress
            ? `Outstanding checks finished. Earlier failures remain factual:\n\n${validationReport(progress, store.failures.list(taskId))}`
            : `Ted ran the Factory’s checks before handing you this Stage. None failed:\n\n${summary(checkRun.checks)}`
        await options.deliver(
          current,
          await withInstructions(`# Checks\n\n${checksReport}`),
          previousFailures ? 'checks-done' : 'checks-passed',
        )
        return
      }
      await returnFailedChecks(taskId, checkRun, withInstructions)
    } finally {
      options.setChecking(taskId, false)
    }
  }

  const mergeHolds = new Map<string, string>()
  function holdMerge(taskId: string, why: string | undefined): void {
    const shown = mergeHolds.get(taskId)
    if (why !== undefined) {
      mergeHolds.set(taskId, why)
      store.setMergeHeld(taskId, why)
      return
    }
    mergeHolds.delete(taskId)
    if (shown !== undefined && store.mergeHeld(taskId) === shown)
      store.setMergeHeld(taskId, undefined)
  }
  const unresolvedHold = (ids: readonly string[]) =>
    `Unresolved failure cases hold this merge: ${ids.map(shortReference).join(', ')}.`
  const failedHold = (taskId: string) => {
    const failureId = store.failures.progress(taskId)?.failureId
    return failureId === undefined
      ? 'A check failed on the code Ted will merge.'
      : `A check failed on the code Ted will merge, so failure case ${shortReference(failureId)} holds the merge until it’s resolved.`
  }

  const coveredFor = new Map<string, string>()
  async function stillCovered(task: StoredTask): Promise<boolean> {
    const resolution = await options.workflow(task)
    const inputs = JSON.stringify([
      resolution.workflow.settings.stages.validate?.checks ?? [],
      store.failures.progress(task.id) ?? null,
    ])
    if (coveredFor.get(task.id) === inputs) return true
    coveredFor.delete(task.id)
    if (!(await currentCoverage(task))) return false
    coveredFor.set(task.id, inputs)
    return true
  }

  async function mergeChecks(taskId: string): Promise<boolean> {
    const held: MergeHold = {}
    let ready = false
    try {
      ready = await mergeCheckSteps(taskId, held)
    } finally {
      holdMerge(taskId, ready ? undefined : held.why)
    }
    return ready
  }

  async function mergeCheckSteps(taskId: string, held: MergeHold): Promise<boolean> {
    const task = find(taskId)
    const since = store.listStageEntries(taskId).findLast((e) => mergesHere(e.stage))?.at ?? ''
    if (
      store.latestRebase(taskId, since) === undefined &&
      !pendingRepair(task) &&
      !mergeChecksStarted(task) &&
      (options.isChecking(taskId) || (await stillCovered(task)))
    )
      return true
    if (options.isChecking(taskId)) {
      held.why = mergeChecksRunning
      return false
    }
    if (task.waitsForBlockers) {
      held.why = 'The merge waits for the repair Task to merge first.'
      return false
    }
    if (task.stopped || task.archived) return false
    let reserved = false
    let started: Awaited<ReturnType<typeof beginChecks>>
    let fix: FailureCase | undefined
    try {
      const ready = await options.holding(task, async () => {
        if (options.isChecking(taskId)) {
          held.why = mergeChecksRunning
          return false
        }
        const obligations = await failures.obligations(task)
        const covered = await currentCoverage(task, true)
        const progress = store.failures.progress(taskId)
        for (const execution of progress?.executions ?? []) {
          const run = store.getCheckRun(execution.runId)
          if (run) verifyPassed(task, run)
        }
        if (
          covered &&
          obligations.satisfied &&
          progress?.checks.every((check, position) => {
            if (check.state === 'passed' || check.state === 'skipped') return true
            if (check.state !== 'failed' && check.state !== 'timed-out') return false
            const execution = validationExecution(progress, position)
            return store.failures
              .list(taskId)
              .some(
                (value) =>
                  value.source.kind === 'post-rebase-check' &&
                  value.source.checkRunId === execution?.runId &&
                  value.source.position === position - execution.start &&
                  obligations.cases.some(
                    (entry) =>
                      entry.id === value.id &&
                      entry.disposition === 'accepted' &&
                      entry.context === 'current',
                  ),
              )
          })
        )
          return true
        const failure =
          validationFixes(task)[0] ??
          (progress?.failureId ? store.failures.get(progress.failureId) : undefined)
        const assessment = failure?.assessments.at(-1)
        if (
          failure &&
          !failure.verifications?.length &&
          (failure.resolutions.at(-1)?.resolution === 'fix' ||
            (assessment?.assessment === 'regression' &&
              assessment.evidenceCount === failure.additions.length))
        ) {
          fix = failure
          return false
        }
        if (covered && !obligations.satisfied && !pendingRepair(find(taskId))) {
          held.why = unresolvedHold(obligations.blockers)
          return false
        }
        if (!pendingRepair(find(taskId)) && !(await resumeFailedCheck(find(taskId)))) {
          held.why = failedHold(taskId)
          return false
        }
        options.setChecking(taskId, true)
        reserved = true
        started = await beginChecks(find(taskId), await options.workflow(find(taskId)), 'merge')
        return false
      })
      if (fix) {
        await options.fix(find(taskId), fix)
        return false
      }
      if (ready) return true
      if (!reserved) return false
      if (started) {
        holdMerge(taskId, mergeChecksRunning)
        const result = await started.done
        if (result.outcome !== 'passed') {
          held.why = failedHold(taskId)
          await options.notify(find(taskId))
          return false
        }
      }
      if (!(await currentCoverage(find(taskId)))) {
        if (started) held.why = mergeCodeChanged
        return false
      }
      const after = await failures.obligations(find(taskId))
      if (!after.satisfied) held.why = unresolvedHold(after.blockers)
      return after.satisfied
    } finally {
      if (reserved) options.setChecking(taskId, false)
    }
  }

  async function acceptFromWork(
    task: StoredTask,
    value: FailureCase,
    input: ResolveFailureRequest,
    sendDrafts: boolean,
  ) {
    if (input.resolution !== 'accepted')
      throw new RequestError(
        409,
        'The Task is already in Work, so Accept this failure is the only decision Ted takes here',
      )
    if (!failures.latestCheckReturn(task, value))
      throw new RequestError(
        409,
        'Only the failure of the check that last sent the Task back to Work can be accepted from Work',
      )
    if (options.isChecking(task.id))
      throw new RequestError(
        409,
        'Checks are still running; wait for their results before deciding this failure',
      )
    const enter = await options.leaveWork(task)
    const tested = value.contextId ? store.failures.context(value.contextId) : undefined
    const current = tested && (await failures.snapshot(find(task.id)).catch(() => undefined))
    const progress = store.failures.progress(task.id)
    if (!tested || !current || !sameTested(tested, current) || progress?.failureId !== value.id)
      throw new RequestError(
        409,
        'The Task’s code changed since this check ran, so Ted can’t accept the failure. Ask the Task Lead to report the outcome again: Ted runs the checks on the new code when the Task enters Validate.',
      )
    options.setChecking(task.id, true)
    let entered = false
    try {
      const result = await failures.resolve(task, value.id, input, sendDrafts)
      const carried = { ...progress, next: progress.next + 1, pending: true }
      store.failures.saveProgress(carried)
      await store.persisted()
      await enter(
        `The human accepted failure case ${shortReference(value.id)} from Work, so Ted moved the Task to Validate on the same code. The checks go on after the accepted one; the ones that passed on this code don’t run again.`,
        carried,
      )
      entered = true
      return result
    } finally {
      if (!entered) options.setChecking(task.id, false)
    }
  }

  async function resolveValidationFailure(
    task: StoredTask,
    id: string,
    input: ResolveFailureRequest,
    sendDrafts = true,
  ) {
    const value = failures.get(task, id)
    id = value.id
    if (!value.validation) {
      if (input.resolution === 'retry' || input.resolution === 'fix')
        throw new RequestError(400, 'this failure does not support Validate actions')
      return failures.resolve(task, id, input, sendDrafts)
    }
    if (handsOff(task.stage)) return acceptFromWork(task, value, input, sendDrafts)
    const merging =
      mergesHere(task.stage) &&
      (value.source.kind === 'post-rebase-check' || value.source.kind === 'github-ci')
    if (!validates(task.stage) && !merging)
      throw new RequestError(409, 'this check decision is no longer current')
    const closingChoice =
      input.resolution === 'fixed' || input.resolution === 'no-longer-applicable'
        ? failureChoices[input.resolution]
        : undefined
    const closing = closingChoice !== undefined
    if (closing && !store.getComment(input.requestId)?.choices?.includes(closingChoice))
      throw new RequestError(
        409,
        'use Retry, Fix in this Task or Accept this failure for a check diagnosis',
      )
    if (options.isChecking(task.id))
      throw new RequestError(
        409,
        'Checks are still running; wait for their results before deciding this failure',
      )
    options.setChecking(task.id, true)
    let continuing = false
    try {
      failures.pendingDecision(task, id, input.requestId)
      const resolution = await options.workflow(find(task.id))
      if (input.resolution === 'fix') options.checkFix(resolution, task)
      if (
        (value.source.kind === 'factory-check' || value.source.kind === 'post-rebase-check') &&
        input.resolution === 'retry' &&
        store.failures.progress(task.id)?.failureId !== id
      )
        throw new RequestError(409, 'this failure is not the outstanding check')
      const result = await failures.resolve(task, id, input, sendDrafts)
      if (input.resolution === 'fix' && !merging) {
        await options.fix(find(task.id), result)
      } else if (
        (value.source.kind === 'factory-check' || value.source.kind === 'post-rebase-check') &&
        (input.resolution === 'retry' || input.resolution === 'accepted' || closing) &&
        store.failures.progress(task.id)?.failureId === id
      ) {
        const progress = store.failures.progress(task.id)
        if (progress?.failureId !== id)
          throw new RequestError(409, 'this failure is not the outstanding check')
        store.failures.saveProgress({
          ...progress,
          next: input.resolution === 'retry' ? progress.next : progress.next + 1,
          pending: true,
        })
        await store.persisted()
        if (!merging) {
          continuing = true
          options.background(`continue ${task.displayId}’s checks`, () => validateChecks(task.id))
        }
      }
      return result
    } finally {
      if (!continuing) options.setChecking(task.id, false)
    }
  }

  async function currentCoverage(
    task: StoredTask,
    refreshPending = false,
    mergedOnGitHub = false,
    reads: WorktreeReads = worktreeReads(),
  ): Promise<boolean> {
    const progress = store.failures.progress(task.id)
    if (task.stage === 'done') return true
    if (!progress) return !validates(task.stage) && visitStart(task) === ''
    if (
      (progress.pending || progress.next < progress.checks.length) &&
      (!refreshPending || options.isChecking(task.id))
    )
      return false
    const previous = progress.contextId ? store.failures.context(progress.contextId) : undefined
    const tested = progress.coverage ?? (previous && coverageOf(previous))
    // The Check plan is read from the default branch, which holds this Task’s own changes
    // once its pull requests have merged, so only the code is compared from then on.
    if (merged(task) || (mergedOnGitHub && mergesHere(task.stage))) {
      if (
        progress.visit !== visitStart(task) ||
        progress.pending ||
        progress.next < progress.checks.length
      )
        return false
      if (progress.checks.every((c) => c.state === 'skipped')) return true
      const local = await coverage(task, reads)
      return local !== undefined && tested !== undefined && codeOf(local) === codeOf(tested)
    }
    const resolution = await options.workflow(task)
    const plan = await options.plan(task, resolution, undefined, reads)
    const samePlan =
      progress.visit === visitStart(task) &&
      sameCheckPlan(progress.checks) === sameCheckPlan(plan.map((p) => p.check)) &&
      progress.checks.every((c, i) => c.state !== 'skipped' || plan[i]?.check.state === 'skipped')
    const skipped =
      progress.checks.every((c) => c.state === 'skipped') &&
      plan.every((p) => p.check.state === 'skipped')
    const local = samePlan && !skipped ? await coverage(task, reads) : undefined
    if (samePlan && (skipped || (local && tested === local)))
      return !progress.pending && progress.next >= progress.checks.length
    store.failures.saveProgress({
      taskId: task.id,
      visit: visitStart(task),
      checks: plan.map((p) => p.check),
      executions: [],
      next: 0,
      pending: plan.length > 0,
    })
    await store.persisted()
    return plan.length === 0
  }

  async function verifyRepair(
    task: StoredTask,
    value: FailureCase,
    evidence: string,
    fixedBy?: { id: string; displayId: string; title: string },
  ) {
    if (value.source.kind !== 'factory-check' && value.source.kind !== 'post-rebase-check')
      throw new RequestError(409, 'only a check repair can use current check coverage')
    const source = store.getCheckRun(value.source.checkRunId)
    const obligations = await failures.obligations(task)
    const current = await currentCoverage(task)
    const progress = store.failures.progress(task.id)
    const original = failures.sourceCheck(value)
    const decision = value.resolutions.at(-1)
    const incorporation =
      decision?.resolution === 'repair'
        ? (value.repairProgress?.findLast((p) => p.requestId === decision.requestId) ??
          (failures.abandonedRepair(value) ? decision : undefined))
        : undefined
    const freshRepair =
      incorporation &&
      progress &&
      (progress.checks.length === 0 ||
        progress.executions.some((execution) => {
          const run = store.getCheckRun(execution.runId)
          return (
            execution.start === 0 &&
            run?.finishedAt !== undefined &&
            run.stage === task.stage &&
            run.trigger === task.stage &&
            run.startedAt >= incorporation.at
          )
        }))
    if (
      !current ||
      !progress ||
      progress.pending ||
      !source ||
      (!freshRepair &&
        (source.startedAt >= progress.visit ||
          !store
            .listStageEntries(task.id)
            .some(
              (entry) =>
                handsOff(entry.stage) && entry.at > source.startedAt && entry.at < progress.visit,
            ))) ||
      !original ||
      progress.checks.some((c, position) => {
        if (c.state === 'passed' || c.state === 'skipped') return false
        if (c.state !== 'failed' && c.state !== 'timed-out') return true
        const execution = validationExecution(progress, position)
        return !store.failures
          .list(task.id)
          .some(
            (failure) =>
              (failure.source.kind === 'factory-check' ||
                failure.source.kind === 'post-rebase-check') &&
              failure.source.checkRunId === execution?.runId &&
              failure.source.position === position - execution.start &&
              obligations.cases.some(
                (entry) =>
                  entry.id === failure.id &&
                  entry.disposition === 'accepted' &&
                  entry.context === 'current',
              ),
          )
      }) ||
      progress.checks.some(
        (c) =>
          c.name === original.name &&
          c.repo === original.repo &&
          c.command === original.command &&
          c.state !== 'skipped',
      )
    )
      throw new RequestError(
        409,
        'complete current checks after repair incorporation or in a fresh Validate visit, and explain why the old check is now skipped, removed or replaced',
      )
    return failures.verifyResult(
      task,
      value.id,
      `${evidence}\n\nTask Lead reported repair against Validate visit ${progress.visit}. Current checks: ${generatedFailureText(summary(progress.checks)) || '(empty plan)'}. Original execution remains failed.`,
      undefined,
      undefined,
      fixedBy,
    )
  }

  async function requireCoverage(
    task: StoredTask,
    mergedOnGitHub = false,
    reads?: WorktreeReads,
  ): Promise<void> {
    if (await currentCoverage(task, false, mergedOnGitHub, reads)) return
    const progress = store.failures.progress(task.id)
    if (progress && !progress.pending && progress.next < progress.checks.length)
      throw new RequestError(
        409,
        'A check failed on the Task’s current code, so Ted can’t move it on. Resolve its failure case first.',
      )
    throw new StaleCoverageError()
  }

  function pendingRepair(task: Task): boolean {
    return store.failures.list(task.id).some((value) => {
      const decision = value.resolutions.at(-1)
      if (decision?.resolution !== 'repair' || value.verifications?.length) return false
      const incorporation = value.repairProgress?.findLast(
        (p) => p.requestId === decision.requestId,
      )
      return (
        incorporation !== undefined &&
        !store
          .listCheckRuns(task.id)
          .some(
            (run) =>
              run.stage === task.stage &&
              run.trigger === task.stage &&
              run.startedAt >= incorporation.at &&
              run.finishedAt !== undefined &&
              run.outcome !== 'interrupted',
          )
      )
    })
  }

  function recover(skip: ReadonlySet<string> = new Set()) {
    for (const checkRun of store.listCheckRuns().filter((r) => r.finishedAt === undefined)) {
      const task = store.getTask(checkRun.taskId)
      const restart =
        checkRun.trigger === 'validate' &&
        !skip.has(checkRun.taskId) &&
        task !== undefined &&
        validates(task.stage) &&
        !pendingRepair(task)
      if (restart) options.setChecking(task.id, true)
      store.checkSlotBoundary(checkRun.id, 'recovered', new Date().toISOString())
      store.finishChecks(checkRun.id, 'interrupted')
      if (restart) {
        options.background(`run ${task.displayId}’s checks again`, () => resumeValidation(task.id))
      }
    }

    for (const task of store.listTasks()) {
      const progress = store.failures.progress(task.id)
      const failure = progress?.failureId ? store.failures.get(progress.failureId) : undefined
      const decision = failure?.resolutions.at(-1)
      const decided =
        decision?.resolution === 'retry' ||
        decision?.resolution === 'accepted' ||
        decision?.resolution === 'fix'
      if (
        validates(task.stage) &&
        !skip.has(task.id) &&
        !pendingRepair(task) &&
        !task.archived &&
        !store.failures.list(task.id).some((f) => {
          const decision = f.resolutions.at(-1)
          return (
            decision?.resolution === 'repair' &&
            !f.verifications?.length &&
            !f.repairProgress?.some((p) => p.requestId === decision.requestId)
          )
        }) &&
        !find(task.id).waitsForBlockers &&
        !find(task.id).stopped &&
        (!progress ||
          progress.visit !== visitStart(task) ||
          progress.pending ||
          decided ||
          validationFixes(task).length > 0 ||
          unreturnedEntryFailure(task) !== undefined) &&
        !options.isChecking(task.id)
      ) {
        options.setChecking(task.id, true)
        options.background(`continue ${task.displayId}’s Validate checks`, () =>
          resumeValidation(task.id),
        )
      }
    }
  }

  return {
    pendingRepair,
    merge: mergeChecks,
    begin: beginChecks,
    coverage,
    enter: validateChecks,
    carryOver,
    resume: resumeValidation,
    fixes: validationFixes,
    resolve: resolveValidationFailure,
    currentCoverage,
    requireCoverage,
    verifyRepair,
    recover,
  }
}
