import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  AgentStageId,
  CheckRun,
  CheckRunTrigger,
  FailureCase,
  FailureContext,
  ResolveFailureRequest,
  Task,
} from '@ted/protocol'
import { validationExecution } from '@ted/protocol'
import { RequestError } from '../errors.ts'
import type { StoredTask, TedStore } from '../store/index.ts'
import type { WorkflowResolution } from '../workflow/workflows.ts'
import { type CheckRunnerResult, type RunnableCheck, runChecks, summary } from './checks.ts'
import type { CommandLaunch } from './command.ts'
import { type createFailureCases, generatedFailureText } from './failure-cases.ts'
import { sameCheckPlan, validationReport } from './validation-report.ts'

interface ValidationOptions {
  store: TedStore
  failures: ReturnType<typeof createFailureCases>
  find(id: string): StoredTask
  context(task: Task): Promise<Pick<FailureContext, 'repos' | 'checks'>>
  workflow(task: StoredTask): Promise<WorkflowResolution>
  plan(task: StoredTask, resolution: WorkflowResolution, only?: string): Promise<RunnableCheck[]>
  checkSandbox(task: StoredTask): Promise<void>
  prepareLaunch(task: StoredTask): Promise<CommandLaunch>
  env(): NodeJS.ProcessEnv
  libraryDir: string
  signal: AbortSignal
  lowPriority(): boolean
  takeCheckSlot(taskId: string): Promise<(() => void) | undefined>
  checkLog(task: Task, id: string, position: number): string
  checkDir(task: Task, id: string): string
  findings(task: Task, run: CheckRun): Promise<string | undefined>
  reportNotFound(task: Task, result: CheckRunnerResult): void
  setChecking(id: string, on: boolean): void
  isChecking(id: string): boolean
  deliver(task: StoredTask, message: string): Promise<unknown>
  instructions(task: StoredTask, resolution: WorkflowResolution, message?: string): Promise<string>
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
  const coverageOf = (context: Pick<FailureContext, 'repos' | 'checks'>) =>
    JSON.stringify({
      repos: context.repos.map(({ repo, head, tree }) => ({ repo, head, tree })),
      checks: context.checks,
    })
  const coverage = async (task: Task) =>
    options
      .context(task)
      .then(coverageOf)
      .catch(() => undefined)

  async function failureEvidence(task: Task, run: CheckRun, position: number) {
    const evidence = generatedFailureText(
      (await options.findings(task, run)) ?? summary(run.checks),
    )
    const reference = `\n\nFull output: ${options.checkLog(task, run.id, position)}`
    return evidence.slice(0, Math.max(0, 16_000 - reference.length)) + reference
  }

  function sourceCheck(value: FailureCase) {
    return value.source.kind === 'factory-check'
      ? (store.getCheckRun(value.source.checkRunId)?.checks[value.source.position] ??
          value.originalCheck)
      : value.originalCheck
  }

  function verifyPassed(task: Task, run: CheckRun) {
    for (const prior of store.failures.list(task.id)) {
      const original = sourceCheck(prior)
      if (
        !prior.validation ||
        prior.verifications?.length ||
        prior.source.kind !== 'factory-check' ||
        prior.source.checkRunId === run.id ||
        !original ||
        run.startedAt < prior.createdAt
      )
        continue
      const decision = prior.resolutions.at(-1)
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
        failures.verifyResult(task, prior.id, `Verification passed in Check run ${run.id}.`, run.id)
    }
  }

  async function beginChecks(
    task: StoredTask,
    resolution: WorkflowResolution,
    trigger: CheckRunTrigger,
    only?: string,
  ): Promise<{ checkRun: CheckRun; done: Promise<CheckRunnerResult> } | undefined> {
    const hold = store.newWorkHold()
    if (hold) throw new RequestError(409, hold)
    const validating = task.stage === 'validate' && trigger !== 'merge'
    const existing = store.failures.progress(task.id)
    const order = resolution.workflow.order
    const tracking =
      validating ||
      (visitStart(task) !== '' &&
        only === undefined &&
        order.indexOf(task.stage as AgentStageId) > order.indexOf('validate'))
    let plan = await options.plan(task, resolution, only)
    if (plan.length === 0) {
      if (tracking)
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
    let progress = tracking ? existing : undefined
    let start = 0
    let contextId: string | undefined
    if (tracking) {
      const local = await coverage(task)
      const context = validating ? await failures.snapshot(task).catch(() => undefined) : undefined
      if (context) contextId = store.failures.capture(context).id
      if (context) await failures.obligations(task, context)
      const prior = progress?.contextId ? store.failures.context(progress.contextId) : undefined
      if (
        !progress ||
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
      if ((!validating || trigger === 'agent') && progress.next >= plan.length) {
        const next = only === undefined ? 0 : plan.findIndex((p) => p.check.name === only)
        if (next < 0) throw new RequestError(404, 'no matching Check')
        progress = {
          ...progress,
          next,
          checks: [...progress.checks.slice(0, next), ...plan.slice(next).map((p) => p.check)],
          pending: true,
        }
      }
      if (!validating) progress = { ...progress, next: 0, pending: true }
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
      const release = await options.takeCheckSlot(task.id)
      if (release === undefined) {
        if (!options.signal.aborted) store.finishChecks(checkRun.id, 'interrupted')
        return { outcome: 'interrupted' as const, notFound: [] }
      }
      const result = await runChecks({
        checks: plan,
        taskDisplayId: task.displayId,
        libraryDir: options.libraryDir,
        env: options.env(),
        logFor: (position) => options.checkLog(task, checkRun.id, position),
        prepareLaunch: () => options.prepareLaunch(find(task.id)),
        signal: options.signal,
        lowPriority: options.lowPriority(),
        onStart: (position) => store.checkStarted(checkRun.id, position),
        onFinish: (position, finished) => {
          store.checkFinished(checkRun.id, position, finished)
          if (tracking) {
            const executed = store.getCheckRun(checkRun.id)
            if (executed) verifyPassed(find(task.id), executed)
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
      })
        .catch((error: unknown) => {
          console.error(`couldn’t run ${task.displayId}’s Checks:`, error)
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
          if (validating && result.failed) {
            const stored = store.getCheckRun(checkRun.id) ?? checkRun
            const evidence = await failureEvidence(task, stored, result.failed.position)
            const value = await failures.recordCheck(find(task.id), task.leadRunId ?? 'ted', {
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
                sourceCheck(previous)?.name !== sourceCheck(value)?.name ||
                sourceCheck(previous)?.repo !== sourceCheck(value)?.repo ||
                sourceCheck(previous)?.command !== sourceCheck(value)?.command
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
    for (const execution of progress?.executions ?? []) {
      const run = store.getCheckRun(execution.runId)
      if (run) verifyPassed(task, run)
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
    if (!progress || progress.visit !== visitStart(task)) {
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
        (await failures.recordCheck(task, task.leadRunId ?? 'ted', {
          source: { kind: 'factory-check', checkRunId: run.id, position },
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

  async function adoptHandOff(
    task: StoredTask,
    resolution: WorkflowResolution,
    checked: CheckRun,
  ): Promise<boolean> {
    const plan = await options.plan(task, resolution)
    const local = await coverage(task)
    if (
      checked.outcome !== 'passed' ||
      !local ||
      sameCheckPlan(checked.checks) !== sameCheckPlan(plan.map((p) => p.check)) ||
      checked.checks.some((c, i) => c.state === 'skipped' && plan[i]?.check.state !== 'skipped')
    )
      return false
    await failures.obligations(task).catch(() => undefined)
    verifyPassed(task, checked)
    store.failures.saveProgress({
      taskId: task.id,
      visit: visitStart(task),
      coverage: local,
      checks: checked.checks,
      executions: [{ runId: checked.id, start: 0 }],
      next: checked.checks.length,
      pending: false,
    })
    await store.persisted()
    return true
  }

  async function validateChecks(
    taskId: string,
    message?: string,
    checked?: CheckRun,
  ): Promise<void> {
    options.setChecking(taskId, true)
    try {
      const task = find(taskId)
      const resolution = await options.workflow(find(task.id))
      const instructions = await options.instructions(task, resolution, message)
      const withApps = async (text: string) => {
        const current = find(taskId)
        const apps = current.setup ? await options.apps(current) : undefined
        return apps === undefined ? text : `${text}\n\n${apps}`
      }
      if (checked && (await adoptHandOff(task, resolution, checked))) {
        await options.deliver(
          task,
          await withApps(
            `${instructions}\n\n# Checks\n\nTED ran the Factory’s Checks before moving the Task out of Work. None failed:\n\n${summary(checked.checks)}`,
          ),
        )
        return
      }
      const started = await beginChecks(task, resolution, 'validate')
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
      const findings = generatedFailureText(
        (await options.findings(current, checkRun)) ?? summary(checkRun.checks),
      )
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
    sendDrafts = true,
  ) {
    const value = failures.get(task, id)
    if (!value.validation) {
      if (input.resolution === 'retry' || input.resolution === 'fix')
        throw new RequestError(400, 'this failure does not support Validate actions')
      return failures.resolve(task, id, input, sendDrafts)
    }
    if (task.stage !== 'validate')
      throw new RequestError(409, 'this Validate decision is no longer current')
    if (input.resolution === 'fixed' || input.resolution === 'no-longer-applicable')
      throw new RequestError(
        409,
        'use Retry, Fix in this Task or Accept this failure for a Validate case',
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
      if (input.resolution === 'fix') options.checkFix(resolution)
      if (
        value.source.kind === 'factory-check' &&
        input.resolution === 'retry' &&
        store.failures.progress(task.id)?.failureId !== id
      )
        throw new RequestError(409, 'this failure is not the outstanding Check')
      const result = await failures.resolve(task, id, input, sendDrafts)
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
        continuing = true
        options.background(`continue ${task.displayId}’s Checks`, () => validateChecks(task.id))
      }
      return result
    } finally {
      if (!continuing) options.setChecking(task.id, false)
    }
  }

  async function currentCoverage(task: StoredTask): Promise<boolean> {
    const progress = store.failures.progress(task.id)
    if (task.stage === 'done') return true
    if (!progress) return task.stage !== 'validate' && visitStart(task) === ''
    if (progress.pending || progress.next < progress.checks.length) return false
    const resolution = await options.workflow(task)
    const plan = await options.plan(task, resolution)
    const samePlan =
      progress.visit === visitStart(task) &&
      sameCheckPlan(progress.checks) === sameCheckPlan(plan.map((p) => p.check)) &&
      progress.checks.every((c, i) => c.state !== 'skipped' || plan[i]?.check.state === 'skipped')
    const skipped =
      progress.checks.every((c) => c.state === 'skipped') &&
      plan.every((p) => p.check.state === 'skipped')
    const local = samePlan && !skipped ? await coverage(task) : undefined
    const previous = progress.contextId ? store.failures.context(progress.contextId) : undefined
    const tested = progress.coverage ?? (previous && coverageOf(previous))
    if (samePlan && (skipped || (local && tested === local))) return true
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

  async function verifyRepair(task: StoredTask, value: FailureCase, evidence: string) {
    if (value.source.kind !== 'factory-check')
      throw new RequestError(409, 'only a Factory Check repair can use current Check coverage')
    const source = store.getCheckRun(value.source.checkRunId)
    const obligations = await failures.obligations(task)
    const current = await currentCoverage(task)
    const progress = store.failures.progress(task.id)
    const original = sourceCheck(value)
    if (
      !current ||
      !progress ||
      progress.pending ||
      !source ||
      source.startedAt >= progress.visit ||
      !store
        .listStageEntries(task.id)
        .some(
          (entry) =>
            entry.stage === 'work' && entry.at > source.startedAt && entry.at < progress.visit,
        ) ||
      !original ||
      progress.checks.some((c, position) => {
        if (c.state === 'passed' || c.state === 'skipped') return false
        if (c.state !== 'failed' && c.state !== 'timed-out') return true
        const execution = validationExecution(progress, position)
        return !store.failures
          .list(task.id)
          .some(
            (failure) =>
              failure.source.kind === 'factory-check' &&
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
        'complete current Checks in a fresh Validate visit and explain why the old Check is now skipped, removed or replaced',
      )
    return failures.verifyResult(
      task,
      value.id,
      `${evidence}\n\nTask Lead reported repair against Validate visit ${progress.visit}. Current Checks: ${generatedFailureText(summary(progress.checks)) || '(empty plan)'}. Original execution remains failed.`,
    )
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
        (!progress ||
          progress.visit !== visitStart(task) ||
          progress.pending ||
          decided ||
          validationFixes(task).length > 0) &&
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
    verifyRepair,
    recover,
  }
}
