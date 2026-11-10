import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  CheckRun,
  CheckRunTrigger,
  FailureCase,
  ResolveFailureRequest,
  Task,
} from '@ted/protocol'
import { RequestError } from '../errors.ts'
import type { StoredTask, TedStore } from '../store/index.ts'
import type { WorkflowResolution } from '../workflow/workflows.ts'
import { type CheckRunnerResult, type RunnableCheck, runChecks, summary } from './checks.ts'
import type { CommandSandbox } from './command.ts'
import type { createFailureCases } from './failure-cases.ts'
import { sameCheckPlan, validationReport } from './validation-report.ts'

interface ValidationOptions {
  store: TedStore
  failures: ReturnType<typeof createFailureCases>
  find(id: string): StoredTask
  workflow(task: StoredTask): Promise<WorkflowResolution>
  plan(task: StoredTask, resolution: WorkflowResolution, only?: string): Promise<RunnableCheck[]>
  sandbox(task: StoredTask, resolution: WorkflowResolution): Promise<CommandSandbox | undefined>
  env(): NodeJS.ProcessEnv
  libraryDir: string
  signal: AbortSignal
  checkLog(task: Task, id: string, position: number): string
  checkDir(task: Task, id: string): string
  findings(task: Task, run: CheckRun): Promise<string | undefined>
  reportNotFound(task: Task, result: CheckRunnerResult): void
  setChecking(id: string, on: boolean): void
  isChecking(id: string): boolean
  deliver(task: StoredTask, message: string): Promise<unknown>
  instructions(resolution: WorkflowResolution): string
  apps(task: StoredTask): Promise<string | undefined>
  fix(task: StoredTask, value: FailureCase): Promise<void>
  checkFix(resolution: WorkflowResolution): void
  holding(task: Task, work: () => Promise<void>): Promise<void>
  background(what: string, work: () => Promise<void>): void
}

export function createValidation(options: ValidationOptions) {
  const { store, failures, find } = options
  const visitStart = (task: Task) =>
    store.listStageEntries(task.id).findLast((e) => e.stage === 'validate')?.at ?? ''
  async function beginChecks(
    task: StoredTask,
    resolution: WorkflowResolution,
    trigger: CheckRunTrigger,
    only?: string,
  ): Promise<{ checkRun: CheckRun; done: Promise<CheckRunnerResult> } | undefined> {
    const hold = store.newWorkHold()
    if (hold) throw new RequestError(409, hold)
    let plan = await options.plan(task, resolution, only)
    if (plan.length === 0) {
      if (task.stage === 'validate' && trigger !== 'merge')
        store.failures.saveProgress({
          taskId: task.id,
          visit: visitStart(task),
          checks: [],
          executions: [],
          next: 0,
          pending: false,
        })
      return undefined
    }
    const validating = task.stage === 'validate' && trigger !== 'merge'
    let progress = validating ? store.failures.progress(task.id) : undefined
    let start = 0
    let contextId: string | undefined
    if (validating) {
      const context = await failures.snapshot(task).catch(() => undefined)
      if (context) contextId = store.failures.capture(context).id
      if (context) await failures.obligations(task, context)
      const prior = progress?.contextId ? store.failures.context(progress.contextId) : undefined
      if (
        !progress ||
        progress.visit !== visitStart(task) ||
        !context ||
        prior?.fingerprint !== context.fingerprint ||
        sameCheckPlan(progress.checks) !== sameCheckPlan(plan.map((p) => p.check))
      ) {
        progress = {
          taskId: task.id,
          visit: visitStart(task),
          ...(contextId && { contextId }),
          checks: plan.map((p) => p.check),
          executions: [],
          next: 0,
          pending: true,
        }
      }
      if (trigger === 'agent' && progress.next >= plan.length) {
        const next = only === undefined ? 0 : plan.findIndex((p) => p.check.name === only)
        if (next < 0) throw new RequestError(404, 'no matching Check')
        progress = {
          ...progress,
          next,
          checks: [...progress.checks.slice(0, next), ...plan.slice(next).map((p) => p.check)],
          pending: true,
        }
      }
      start = progress.next
      if (only !== undefined && progress.checks[start]?.name !== only)
        throw new RequestError(
          409,
          'run the outstanding Validate Checks in order; the requested Check is not next',
        )
      if (start >= plan.length) {
        store.failures.saveProgress({ ...progress, pending: false })
        await store.persisted()
        return undefined
      }
      plan = plan.slice(start)
    }
    const sandbox = await options.sandbox(task, resolution)
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
      const result = await runChecks({
        checks: plan,
        taskDisplayId: task.displayId,
        libraryDir: options.libraryDir,
        env: options.env(),
        logFor: (position) => options.checkLog(task, checkRun.id, position),
        ...(sandbox !== undefined && { sandbox }),
        signal: options.signal,
        onStart: (position) => store.checkStarted(checkRun.id, position),
        onFinish: (position, finished) => {
          store.checkFinished(checkRun.id, position, finished)
          if (validating) {
            const current = store.failures.progress(task.id)
            if (current?.executions.at(-1)?.runId === checkRun.id) {
              const checks = [...current.checks]
              const original = checks[start + position]
              if (!original) throw new Error('missing planned Check')
              checks[start + position] = { ...original, ...finished }
              store.failures.saveProgress({
                ...current,
                checks,
                next: finished.state === 'passed' ? start + position + 1 : start + position,
              })
            }
          }
        },
      }).catch((error: unknown) => {
        console.error(`couldn’t run ${task.displayId}’s Checks:`, error)
        return { outcome: 'interrupted' as const, notFound: [] }
      })
      if (result.outcome === 'interrupted' && options.signal.aborted) return result
      store.finishChecks(checkRun.id, result.outcome)
      options.reportNotFound(task, result)
      if (validating && result.outcome !== 'interrupted') {
        const current = store.failures.progress(task.id)
        if (current?.executions.at(-1)?.runId === checkRun.id) {
          const executed = store.getCheckRun(checkRun.id) ?? checkRun
          for (const prior of store.failures.list(task.id)) {
            if (
              !prior.validation ||
              prior.verifications?.length ||
              prior.source.kind !== 'factory-check' ||
              !prior.originalCheck
            )
              continue
            const accepted = prior.resolutions.at(-1)
            if (
              !['retry', 'fix'].includes(accepted?.resolution ?? '') &&
              prior.assessments.at(-1)?.assessment !== 'regression'
            )
              continue
            if (
              accepted?.resolution === 'accepted' &&
              !prior.invalidations.some((i) => i.requestId === accepted.requestId)
            )
              continue
            if (
              executed.checks.some(
                (c) =>
                  c.state === 'passed' &&
                  c.name === prior.originalCheck?.name &&
                  c.repo === prior.originalCheck.repo &&
                  c.command === prior.originalCheck.command,
              )
            )
              failures.verifyResult(
                task,
                prior.id,
                `Verification passed in Check run ${checkRun.id}.`,
                checkRun.id,
              )
          }
          let failureId: string | undefined
          if (result.failed) {
            const stored = store.getCheckRun(checkRun.id) ?? checkRun
            const evidence = (await options.findings(task, stored)) ?? summary(stored.checks)
            const value = await failures.record(find(task.id), task.leadRunId ?? 'ted', {
              source: {
                kind: 'factory-check',
                checkRunId: checkRun.id,
                position: result.failed.position,
              },
              evidence,
              ...(contextId && { contextId }),
            })
            failureId = value.id
            for (const previous of store.failures.list(task.id)) {
              if (
                previous.id === failureId ||
                !previous.validation ||
                previous.verifications?.length ||
                previous.source.kind !== 'factory-check' ||
                previous.originalCheck?.name !== value.originalCheck?.name ||
                previous.originalCheck?.repo !== value.originalCheck?.repo ||
                previous.originalCheck?.command !== value.originalCheck?.command
              )
                continue
              const decision = previous.resolutions.at(-1)
              if (
                decision?.resolution === 'accepted' &&
                !previous.invalidations.some((i) => i.requestId === decision.requestId)
              )
                continue
              failures.verifyResult(
                task,
                previous.id,
                `A new execution failed; failure ${failureId} now holds this verification.`,
                checkRun.id,
                failureId,
              )
            }
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
    if (task.stage !== 'validate' || task.archived || task.stopped) {
      options.setChecking(taskId, false)
      return
    }
    const fixes = validationFixes(task)
    if (fixes.length) {
      options.setChecking(taskId, false)
      await options.holding(task, async () => {
        for (const value of fixes) {
          if (find(taskId).stage !== 'validate') break
          await options.fix(find(taskId), value)
        }
      })
      return
    }
    if (!progress) {
      await validateChecks(taskId)
      return
    }
    const execution = progress.executions.at(-1)
    const run = execution && store.getCheckRun(execution.runId)
    const position =
      run?.checks.findIndex((c) => c.state === 'failed' || c.state === 'timed-out') ?? -1
    if (run && execution && position >= 0) {
      const existing = store.failures
        .list(taskId)
        .find(
          (f) =>
            f.source.kind === 'factory-check' &&
            f.source.checkRunId === run.id &&
            f.source.position === position,
        )
      const value =
        existing ??
        (await failures.record(task, task.leadRunId ?? 'ted', {
          source: { kind: 'factory-check', checkRunId: run.id, position },
          evidence: (await options.findings(task, run)) ?? summary(run.checks),
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
        store.failures.saveProgress({
          ...progress,
          failureId: value.id,
          next: execution.start + position,
          pending: false,
        })
        options.setChecking(taskId, false)
        await store.persisted()
        await options.deliver(
          task,
          `Validate failure ${value.id} still needs diagnosis or a human decision. Original evidence:\n\n${value.evidence}`,
        )
        return
      }
    }
    await validateChecks(taskId)
  }

  async function validateChecks(taskId: string, message?: string): Promise<void> {
    options.setChecking(taskId, true)
    try {
      const task = find(taskId)
      const resolution = await options.workflow(find(task.id))
      const instructions = message ?? options.instructions(resolution)
      const started = await beginChecks(task, resolution, 'validate')
      const withApps = async (text: string) => {
        const current = find(taskId)
        const apps = current.setup ? await options.apps(current) : undefined
        return apps === undefined ? text : `${text}\n\n${apps}`
      }
      if (!started) {
        const progress = store.failures.progress(taskId)
        const report = progress
          ? `\n\n# Validation results\n\n${validationReport(progress, store.failures.list(taskId))}`
          : ''
        await options.deliver(task, await withApps(instructions + report))
        return
      }
      const result = await started.done
      const checkRun = store.getCheckRun(started.checkRun.id) ?? started.checkRun
      const current = find(taskId)
      if (result.outcome === 'interrupted' || current.stage !== 'validate') return
      if (result.outcome === 'passed') {
        const progress = store.failures.progress(taskId)
        const previousFailures = progress?.checks.some(
          (c) => c.state === 'failed' || c.state === 'timed-out',
        )
        const checksReport =
          previousFailures && progress
            ? `Outstanding Checks finished. Earlier failures remain factual:\n\n${validationReport(progress, store.failures.list(taskId))}`
            : `TED ran the Factory’s Checks before handing you this Stage. None failed:\n\n${summary(checkRun.checks)}`
        await options.deliver(
          current,
          await withApps(`${instructions}\n\n# Checks\n\n${checksReport}`),
        )
        return
      }
      const findings = (await options.findings(current, checkRun)) ?? summary(checkRun.checks)
      await writeFile(path.join(options.checkDir(current, checkRun.id), 'findings.md'), findings, {
        mode: 0o600,
      })
      const failureId = store.failures.progress(taskId)?.failureId
      await options.deliver(
        current,
        `${instructions}\n\n# A Check failed\n\nThe Task stays in Validate. Investigate failure case ${failureId ?? '(see ted failure list)'}, add evidence and assess regression, unrelated or uncertain. A supported regression goes back through \`ted outcome back\`; unrelated or uncertain causes require a human decision. Investigation and retry do not count as send-backs.\n\n${findings}`,
      )
    } finally {
      options.setChecking(taskId, false)
    }
  }

  async function resolveValidationFailure(
    task: StoredTask,
    id: string,
    input: ResolveFailureRequest,
  ) {
    const value = failures.get(task, id)
    if (!value.validation) {
      if (input.resolution === 'retry' || input.resolution === 'fix')
        throw new RequestError(400, 'this failure does not support Validate actions')
      return failures.resolve(task, id, input)
    }
    if (task.stage !== 'validate')
      throw new RequestError(409, 'this Validate decision is no longer current')
    if (input.resolution === 'fixed' || input.resolution === 'no-longer-applicable')
      throw new RequestError(
        409,
        'use Retry, Fix in this Task or Accept this failure for a Validate case',
      )
    failures.pendingDecision(task, id, input.requestId)
    const resolution = await options.workflow(find(task.id))
    if (input.resolution === 'fix') options.checkFix(resolution)
    if (
      value.source.kind === 'factory-check' &&
      input.resolution === 'retry' &&
      store.failures.progress(task.id)?.failureId !== id
    )
      throw new RequestError(409, 'this failure is not the outstanding Check')
    const result = await failures.resolve(task, id, input)
    if (input.resolution === 'fix') {
      await options.fix(find(task.id), result)
    } else if (
      value.source.kind === 'factory-check' &&
      (input.resolution === 'retry' || input.resolution === 'accepted') &&
      store.failures.progress(task.id)?.failureId === id
    ) {
      const progress = store.failures.progress(task.id)
      if (progress?.failureId !== id)
        throw new RequestError(409, 'this failure is not the outstanding Check')
      store.failures.saveProgress({
        ...progress,
        next: input.resolution === 'accepted' ? progress.next + 1 : progress.next,
        pending: true,
      })
      await store.persisted()
      options.setChecking(task.id, true)
      options.background(`continue ${task.displayId}’s Checks`, () => validateChecks(task.id))
    }
    return result
  }

  async function currentCoverage(task: StoredTask): Promise<boolean> {
    const progress = store.failures.progress(task.id)
    if (!progress) return true
    if (progress.pending || progress.next < progress.checks.length) return false
    const resolution = await options.workflow(task)
    const plan = await options.plan(task, resolution)
    const samePlan =
      progress.visit === visitStart(task) &&
      sameCheckPlan(progress.checks) === sameCheckPlan(plan.map((p) => p.check))
    const skipped =
      progress.checks.every((c) => c.state === 'skipped') &&
      plan.every((p) => p.check.state === 'skipped')
    const context =
      samePlan && !skipped ? await failures.snapshot(task).catch(() => undefined) : undefined
    const previous = progress.contextId ? store.failures.context(progress.contextId) : undefined
    if (samePlan && (skipped || (context && previous?.fingerprint === context.fingerprint)))
      return true
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

  async function requireCoverage(task: StoredTask): Promise<void> {
    if (!(await currentCoverage(task)))
      throw new RequestError(
        409,
        'Validate Check coverage is stale or incomplete; run ted checks before advancing. Not-run Checks are not passed.',
      )
  }

  function recover() {
    for (const checkRun of store.listCheckRuns().filter((r) => r.finishedAt === undefined)) {
      const task = store.getTask(checkRun.taskId)
      const restart = checkRun.trigger === 'validate' && task?.stage === 'validate'
      if (restart) options.setChecking(task.id, true)
      store.finishChecks(checkRun.id, 'interrupted')
      if (restart) {
        options.background(`run ${task.displayId}’s Checks again`, () => resumeValidation(task.id))
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
        task.stage === 'validate' &&
        !task.archived &&
        !find(task.id).stopped &&
        (progress?.pending || decided || validationFixes(task).length > 0) &&
        !options.isChecking(task.id)
      ) {
        options.setChecking(task.id, true)
        options.background(`continue ${task.displayId}’s Validate Checks`, () =>
          resumeValidation(task.id),
        )
      }
    }
  }

  return {
    begin: beginChecks,
    enter: validateChecks,
    resume: resumeValidation,
    fixes: validationFixes,
    resolve: resolveValidationFailure,
    currentCoverage,
    requireCoverage,
    recover,
  }
}
