import type { AgentKind, Comment, Run, RunMessage, TaskLead, TaskRepo } from '@ted/protocol'
import { agentShortNames } from '@ted/protocol'
import { AgentDisabledError, agentStartHold } from '../agent-eligibility.ts'
import type { Agents } from '../agents/index.ts'
import type { Clock, Timer } from '../clock.ts'
import { RequestError } from '../errors.ts'
import type { AgentHealthMonitor } from '../health/agent-health.ts'
import type { RunManager } from '../runs/run-manager.ts'
import type { RecordedSetup, RunFlags, StoredTask, TedStore } from '../store/index.ts'
import type { WorkflowSettings } from '../workflow/check.ts'
import type { WorkflowResolution } from '../workflow/workflows.ts'
import { endingReason, failedAsk, revivedMessage, silentReason } from './failures.ts'
import { overnightGuidance } from './overnight.ts'
import { type FactoryRepoEntry, repoEntry, sameRepo } from './repos.ts'

export type SetupStep = { repo: TaskRepo; setup: RecordedSetup }
type LaunchIntent = { resumeSession?: string | undefined; pickUp?: string | undefined }
export type PreparationIntent =
  | { kind: 'existing' }
  | { kind: 'held' }
  | {
      kind: 'created' | 'restored'
      resolution: WorkflowResolution
      entries: readonly FactoryRepoEntry[]
    }
  | { kind: 'added'; step: SetupStep; tellLead: boolean }

export interface LeadLifecycleOptions {
  store: TedStore
  clock: Clock
  runs: Pick<
    RunManager,
    | 'start'
    | 'revive'
    | 'restart'
    | 'send'
    | 'dispatch'
    | 'acceptedInputs'
    | 'lastHeard'
    | 'output'
    | 'stop'
    | 'interrupt'
  >
  health: Pick<AgentHealthMonitor, 'ready' | 'check' | 'limited'>
  agents: Pick<Agents, 'get'>
  local(taskId: string): Promise<unknown>
  beforeLeadStart(taskId: string): Promise<WorkflowResolution | undefined>
  afterLeadStart(taskId: string): void
  workflow(task: StoredTask): Promise<WorkflowResolution>
  entries(task: StoredTask, resolution: WorkflowResolution): FactoryRepoEntry[]
  defaultLead(settings: WorkflowSettings): TaskLead
  context(
    task: StoredTask,
    current: StoredTask,
    resolution: WorkflowResolution,
    setupReport: string | undefined,
    intent: LaunchIntent,
  ): Promise<{
    prompt: string
    cwd: string
    waiting: { comments: Comment[]; answers: Comment[] }
    overnight: boolean
  }>
  appEnv(taskId: string): Promise<Record<string, string>>
  protectComments(comments: Comment[], on: boolean): void
  launched(run: Run, overnight: boolean): void
  deliver(taskId: string): Promise<void>
  editedSince(task: StoredTask): string[]
  freshRunNote(task: StoredTask): string
  agentChangeNote(
    task: StoredTask,
    run: Run,
    agent: AgentKind,
    unread: readonly RunMessage[],
  ): Promise<string>
  failedSetupReports(task: StoredTask): Promise<string[]>
  setUp(task: StoredTask, steps: readonly SetupStep[]): Promise<string[] | undefined>
  setUpAdded(taskId: string, step: SetupStep): Promise<{ report?: string } | undefined>
  hold(taskId: string): () => void
  mayContinue?(taskId: string): boolean
  stopRequested(taskId: string): boolean
  wake(): void
  background(what: string, work: () => Promise<void>): void
  hasAnswerText(comment: Comment): boolean
  refreshSteering(runId: string): Promise<void>
  stallAfterMs: number
}

export function liveLeadOf(store: TedStore, task: StoredTask): Run | undefined {
  if (!task.leadRunId || task.stage === 'backlog' || task.stage === 'done') return undefined
  const run = store.getRun(task.leadRunId)
  return run && run.state !== 'finished' ? run : undefined
}

export function effectiveLead(task: StoredTask, fallback?: TaskLead): TaskLead | undefined {
  const lead = task.lead ?? fallback
  if (lead?.effortMode !== 'stage' || task.stageEffort === undefined) return lead
  return { ...lead, effort: task.stageEffort }
}
export const sameChoice = (lead: TaskLead, run: Run) =>
  lead.agent === run.agent && lead.model === run.model && lead.effort === run.effort
export const atIdlePoint = (run: Run) =>
  run.state === 'idle' || (run.problem !== undefined && run.state === 'waiting')

const turnEndMs = 30_000

export const restartedMessage =
  'The human restarted you with new Task Lead settings, which interrupted your last turn. Carry on where you left off.'

export const continueMessage =
  'TED paused you because your agent couldn’t run (a usage limit, no connection, or a sign-in, version or credential problem). It can run again now. Carry on where you left off.'

export function createLeadLifecycle(options: LeadLifecycleOptions) {
  const {
    store,
    clock,
    runs,
    health,
    agents,
    local,
    beforeLeadStart,
    afterLeadStart,
    workflow,
    entries,
    defaultLead,
    context,
    appEnv,
    protectComments,
    launched,
    deliver,
    editedSince,
    freshRunNote,
    agentChangeNote,
    failedSetupReports,
    setUp,
    setUpAdded,
    hold,
    stopRequested,
    wake,
    background,
    hasAnswerText,
    refreshSteering,
    stallAfterMs,
  } = options
  const interrupted = new Set<string>()
  const signedOutAt = new Map<string, string>()
  const turnEnding = new Set<string>()
  const readyMidTurn = new Set<string>()
  const silent = new Map<string, string>()
  const pausedAt = new Map<string, number>()
  const recovering = new Set<string>()
  const awaitingRevive = new Set<string>()
  const applying = new Set<string>()
  const restartAsked = new Set<string>()
  const interruptedForRestart = new Set<string>()
  let closed = false
  let silenceTimer: Timer | undefined
  const find = (id: string): StoredTask => {
    const task = store.getTask(id)
    if (!task) throw new RequestError(404, `no Task ${id}`)
    return task
  }
  const liveLead = (task: StoredTask) => liveLeadOf(store, task)
  function leadEnv(task: StoredTask, entries: readonly FactoryRepoEntry[]): Record<string, string> {
    const repo = task.repos.find((r) => !r.removed)
    if (!repo) return {}
    return store.recordedSetup(task.id, repo.name)?.env ?? repoEntry(entries, repo)?.env ?? {}
  }

  function setupSteps(task: StoredTask, entries: readonly FactoryRepoEntry[]): SetupStep[] {
    return entries.flatMap((entry) => {
      const repo = task.repos.find((r) => !r.removed && sameRepo(r.repo, entry.repo))
      const setup = entry.setup
      return repo && setup
        ? [{ repo, setup: { command: setup.run, timeoutMs: setup.timeoutMs, env: entry.env } }]
        : []
    })
  }

  function interruptedSetups(task: StoredTask): SetupStep[] {
    return task.repos.flatMap((repo) => {
      const recorded = store.recordedSetup(task.id, repo.name)
      return !repo.removed && recorded && repo.setup?.state === 'running'
        ? [{ repo, setup: recorded }]
        : []
    })
  }

  function acknowledgeLeadMessages(run: Run, known?: StoredTask): boolean {
    if (run.taskId === undefined) return false
    const task = known?.id === run.taskId ? known : store.getTask(run.taskId)
    if (task?.leadRunId !== run.id || task.pendingLeadMessages.length === 0) return false
    store.deliveredLeadMessages(run.taskId, runs.acceptedInputs(run.id))
    return true
  }

  async function applyLead(taskId: string, { restart = false } = {}): Promise<void> {
    if (restart) restartAsked.add(taskId)
    if (applying.has(taskId)) return
    const previous = store.getTask(taskId)
    const run = previous && liveLead(previous)
    const task = run && acknowledgeLeadMessages(run, previous) ? store.getTask(taskId) : previous
    const lead = task && effectiveLead(task)
    if (!task || !lead || !run || !atIdlePoint(run) || task.stopped || task.archived) return
    const restartWanted =
      task.leadRestartPending ||
      ((restartAsked.has(taskId) || run.problem === 'model-unavailable') && !sameChoice(lead, run))
    if (
      restartWanted &&
      agentStartHold(store, lead.agent, lead.agent === run.agent ? run.id : undefined)
    )
      return
    if (options.mayContinue?.(taskId) === false) return
    applying.add(taskId)
    try {
      if (sameChoice(lead, run) && !task.leadRestartPending) restartAsked.delete(taskId)
      else if (run.problem === 'model-unavailable') restartAsked.add(taskId)
      if (restartAsked.has(taskId) || task.leadRestartPending) {
        if (lead.agent !== run.agent) {
          if (store.newWorkHold() !== undefined) return
          if (!(await freshLead(task, run, lead.agent))) return
          restartAsked.delete(taskId)
          interruptedForRestart.delete(run.id)
          return
        }
        store.setLeadRestartPending(taskId, true)
        await store.persisted()
        await restartLead(run, {
          ...(lead.model !== undefined && { model: lead.model }),
          ...(lead.effort !== undefined && { effort: lead.effort }),
          usesDefaultModel: run.usesDefaultModel === true && run.model === lead.model,
        })
        restartAsked.delete(taskId)
        store.setLeadRestartPending(taskId, false)
        await store.persisted()
        if (interruptedForRestart.delete(run.id)) await runs.send(run.id, restartedMessage)
      }
      const current = find(taskId)
      const live = liveLead(current)
      const choice = effectiveLead(current)
      if (!live || !choice) return
      if (current.pendingLeadMessages.length > 0 && !restartAsked.has(taskId)) {
        const accepted = await runs
          .dispatch(live.id, current.pendingLeadMessages, false, () => {
            const now = find(taskId)
            return (
              options.mayContinue?.(taskId) !== false &&
              now.leadRunId === live.id &&
              !now.stopped &&
              !now.archived &&
              store.getRun(live.id)?.state !== 'finished'
            )
          })
          .catch((error: unknown) => {
            const remaining = find(taskId).pendingLeadMessages
            if (
              current.pendingLeadMessages.every(
                (message) => !remaining.some((held) => held.id === message.id),
              )
            )
              return false
            throw error
          })
        if (accepted) {
          store.deliveredLeadMessages(
            taskId,
            current.pendingLeadMessages.map((m) => m.id),
          )
          await store.persisted()
        }
      }
    } finally {
      applying.delete(taskId)
      if (store.getTask(taskId)?.pendingLeadMessages.some((message) => message.waitForSlot)) wake()
    }
    const after = find(taskId)
    const live = liveLead(after)
    const choice = effectiveLead(after)
    if (
      live &&
      choice &&
      ((restartAsked.has(taskId) && !sameChoice(choice, live)) ||
        after.pendingLeadMessages.length > 0)
    )
      await applyLead(taskId)
    await refreshSteering(run.id)
  }

  async function restartLead(run: Run, flags: RunFlags): Promise<void> {
    await runs.restart(run.id, flags)
    if (run.problem === 'model-unavailable') {
      const now = flags.usesDefaultModel ? 'the CLI’s default model' : `the model ${flags.model}`
      await runs.send(
        run.id,
        `TED restarted you on ${now} because ${run.model} isn’t available. Your last message got no answer; carry on from where you were.`,
      )
    }
  }

  async function freshLead(task: StoredTask, run: Run, agent: AgentKind): Promise<boolean> {
    if (!task.repos.some((r) => !r.removed)) throw new Error(`${task.displayId} has no worktree`)
    if (!(await health.ready(agent))) return false
    const resolution = await workflow(find(task.id))
    const env = leadEnv(task, entries(task, resolution))
    const unread = store.runMessages(run.id).filter((message) => message.queued === true)
    const pickUp = await agentChangeNote(task, run, agent, unread)
    await runs.stop(run.id)
    await launch(task, resolution, env, undefined, { pickUp })
    if (find(task.id).leadRunId === run.id) return true
    for (const message of unread) store.deleteRunMessage(run.id, message.id)
    await store.persisted()
    return true
  }

  async function restartNow(taskId: string): Promise<void> {
    const task = find(taskId)
    const run = liveLead(task)
    const lead = effectiveLead(task)
    if (task.stopped || task.archived || !run || !lead)
      throw new RequestError(409, `${task.displayId} has no running Task Lead to restart`)
    if (sameChoice(lead, run) && !task.leadRestartPending)
      throw new RequestError(409, `${task.displayId}’s Task Lead already uses these settings`)
    const off = agentStartHold(store, lead.agent, lead.agent === run.agent ? run.id : undefined)
    if (off !== undefined) throw new RequestError(409, off)
    if (lead.agent !== run.agent && !(await health.ready(lead.agent)))
      throw new RequestError(
        409,
        `${agentShortNames[lead.agent]} isn’t ready. Check Settings → Agents.`,
      )
    if (lead.agent !== run.agent && store.newWorkHold() !== undefined)
      throw new RequestError(
        409,
        'TED isn’t starting new work right now, so it can’t switch agents',
      )
    if (run.state === 'working') {
      if (lead.agent === run.agent) interruptedForRestart.add(run.id)
      store.recordTurnInterrupted(run.id, false)
      await runs.interrupt(run.id)
      for (let waited = 0; waited < turnEndMs; waited += 100) {
        if (store.getRun(run.id)?.state !== 'working') break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    await applyLead(taskId, { restart: true })
  }

  async function launch(
    task: StoredTask,
    resolution: WorkflowResolution,
    env: Record<string, string>,
    setupReport?: string,
    { resumeSession, pickUp }: LaunchIntent = {},
  ): Promise<void> {
    const previous = find(task.id)
    if (previous.archived || previous.stopped || previous.waitsForBlockers) return
    await local(task.id)
    resolution = (await beforeLeadStart(task.id)) ?? resolution
    const old = previous.leadRunId && store.getRun(previous.leadRunId)
    if (old) acknowledgeLeadMessages(old)
    const current = find(task.id)
    if (current.archived || current.stopped || current.waitsForBlockers) return
    const lead = effectiveLead(current, defaultLead(resolution.workflow.settings)) as TaskLead
    const agent = lead.agent
    if (agentStartHold(store, agent) || !(await health.ready(agent))) {
      store.holdTaskRun({
        taskId: task.id,
        agent,
        ...(resumeSession !== undefined && { sessionId: resumeSession }),
      })
      return
    }
    const { prompt, cwd, waiting, overnight } = await context(
      task,
      current,
      resolution,
      setupReport,
      {
        resumeSession,
        pickUp,
      },
    )
    const pending = current.pendingLeadMessages
    let run: Run
    protectComments([...waiting.comments, ...waiting.answers], true)
    try {
      run = await runs.start({
        agent,
        prompt,
        cwd,
        messageIds: pending.map((message) => message.id),
        taskId: task.id,
        env: { ...env, ...(await appEnv(task.id)), TED_TASK: task.displayId },
        permissions: resolution.workflow.settings.permissions === 'bypass' ? 'bypass' : 'auto',
        ...(resumeSession !== undefined && { resume: resumeSession }),
        ...(lead.model !== undefined && { model: lead.model }),
        ...(lead.effort !== undefined && { effort: lead.effort }),
      })
      launched(run, overnight)
      if (current.leadRestartPending) store.setLeadRestartPending(task.id, false)
      store.commentsDelivered(
        waiting.comments.map((c) => c.id),
        run.id,
      )
      store.answersDelivered(
        waiting.answers.map((c) => c.id),
        run.id,
      )
      await store.persisted()
    } catch (error) {
      if (!(error instanceof AgentDisabledError)) throw error
      store.holdTaskRun({
        taskId: task.id,
        agent,
        ...(resumeSession !== undefined && { sessionId: resumeSession }),
      })
      return
    } finally {
      protectComments([...waiting.comments, ...waiting.answers], false)
    }
    store.releaseTaskRun(task.id)
    await deliver(task.id)
    afterLeadStart(task.id)
  }

  async function prepare(taskId: string, intent: PreparationIntent): Promise<void> {
    const task = find(taskId)
    if (intent.kind === 'added') {
      const finished = await setUpAdded(taskId, intent.step)
      if (!finished || !intent.tellLead) return
      const run = liveLead(find(taskId))
      if (run)
        await runs.send(
          run.id,
          finished.report ??
            `TED finished setting up the ${intent.step.repo.name} worktree: \`${intent.step.setup.command}\` passed.`,
        )
      return
    }
    if (intent.kind === 'held') {
      const repo = task.repos.find((r) => !r.removed)
      const held = store.heldRuns().find((h) => h.taskId === taskId)
      const leadLive = task.runs.some((r) => r.id === task.leadRunId)
      if (
        !repo ||
        task.archived ||
        task.stopped ||
        task.stage === 'backlog' ||
        task.stage === 'done'
      ) {
        if (held) store.releaseTaskRun(taskId)
        return
      }
      if (held ? leadLive : task.leadRunId) return
      if (held?.sessionId !== undefined && (task.lead?.agent ?? held.agent) === held.agent) {
        const resolution = await workflow(find(taskId))
        const env = store.recordedSetup(taskId, repo.name)?.env ?? {}
        return launch(task, resolution, env, undefined, { resumeSession: held.sessionId })
      }
    }
    const supplied = intent.kind === 'created' || intent.kind === 'restored'
    const resolution = supplied ? intent.resolution : await workflow(find(taskId))
    const repos = supplied ? intent.entries : entries(task, resolution)
    const env = supplied ? (repos[0]?.env ?? {}) : leadEnv(task, repos)
    const steps = supplied ? setupSteps(task, repos) : interruptedSetups(task)
    const pickUp =
      intent.kind === 'existing' || intent.kind === 'restored' ? freshRunNote(task) : undefined
    if (steps.length > 0) {
      const release = hold(taskId)
      try {
        const reports = await setUp(task, steps)
        if (reports === undefined) return
        await launch(
          find(taskId),
          resolution,
          env,
          reports.length > 0 ? reports.join('\n\n') : undefined,
          { pickUp },
        )
      } finally {
        release()
      }
      return
    }
    const reports = intent.kind === 'held' ? await failedSetupReports(task) : []
    await launch(task, resolution, env, reports.length > 0 ? reports.join('\n\n') : undefined, {
      pickUp,
    })
  }

  async function leadStopped(run: Run, signedOut?: string): Promise<void> {
    if (run.taskId === undefined) return
    const silence = silent.get(run.id)
    silent.delete(run.id)
    pausedAt.delete(run.id)
    const task = store.getTask(run.taskId)
    if (!task || task.leadRunId !== run.id || task.stage === 'backlog' || task.stage === 'done') {
      return
    }
    const stoppedByTed = store.tedStopPending(task.id)
    const [checked] = await health.check([run.agent])
    if (checked?.state === 'ready' && signedOut === undefined) {
      const ended = store.getRun(run.id)?.ended
      if (silence !== undefined || (ended !== undefined && ended.how !== 'stopped')) {
        await leadFailed(run.id, silence)
      }
      return
    }
    const now = store.getTask(task.id)
    if (!now || now.leadRunId !== run.id || now.stage === 'done') return
    if (now.waitsForBlockers || now.stopped || stoppedByTed) return
    if (signedOut !== undefined) {
      const held = new Set(store.heldAnswers(task.id).map((c) => c.id))
      for (const comment of store.listComments(task.id)) {
        const at = comment.answer?.at
        const unread = at !== undefined && at >= signedOut && hasAnswerText(comment)
        if (unread && !held.has(comment.id)) store.holdAnswer(comment.id)
      }
    }
    store.holdTaskRun({
      taskId: task.id,
      agent: run.agent,
      ...(run.sessionId !== undefined && { sessionId: run.sessionId }),
    })
    wake()
  }

  async function leadFailed(runId: string, silence?: string): Promise<void> {
    if (recovering.has(runId)) return
    recovering.add(runId)
    try {
      await recover(runId, silence)
    } finally {
      recovering.delete(runId)
    }
  }

  async function recover(runId: string, silence?: string): Promise<void> {
    const run = store.getRun(runId)
    if (!run?.taskId || run.state !== 'finished') return
    const task = store.getTask(run.taskId)
    if (!task || task.leadRunId !== run.id || task.archived || task.stopped) return
    if (task.stage === 'backlog' || task.stage === 'done' || task.waitsForBlockers) return
    if (task.status?.kind === 'failed' || stopRequested(task.id)) return
    if (store.queue().some((q) => q.id === task.id)) return
    if (store.heldRuns().some((h) => h.taskId === task.id)) return
    if (store.alreadyFailed(task.id, run.id, run.revivedAt ?? run.startedAt)) return
    const ended = run.ended
    const reason = silence ?? endingReason(ended)
    const resumeFailed = silence === undefined && ended?.resumeFailed === true
    const now = clock.now()
    const history = store.failureHistory(task.id, now)
    const earlier = history.recent
    const canResume =
      run.sessionId !== undefined &&
      (task.lead?.agent ?? run.agent) === run.agent &&
      store.newWorkHold() === undefined
    const recovery = resumeFailed
      ? 'fresh'
      : earlier.length > 0
        ? 'failed'
        : canResume
          ? 'resume'
          : 'fresh'
    store.leadFailed({
      taskId: task.id,
      runId: run.id,
      reason,
      recovery,
      resumeFailed,
      ...(recovery === 'failed' && {
        ask: failedAsk(run.agent, history.sinceFirst, reason, ended, now),
      }),
    })
    if (recovery === 'resume') awaitingRevive.add(task.id)
    wake()
  }

  function pendingRevive(
    taskId: string,
  ): { task: StoredTask; run: Run; reason: string } | undefined {
    const task = store.getTask(taskId)
    if (!task || task.archived || task.stopped || task.waitsForBlockers) return undefined
    if (task.stage === 'backlog' || task.stage === 'done') return undefined
    const last = store.latestLeadFailure(taskId)
    if (last?.recovery !== 'resume') return undefined
    const run = store.getRun(last.runId)
    if (run?.state !== 'finished' || task.leadRunId !== run.id) return undefined
    if (run.revivedAt !== undefined && run.revivedAt >= last.at) return undefined
    return { task, run, reason: last.reason }
  }

  async function reviveLead(taskId: string): Promise<void> {
    const release = hold(taskId)
    const pending = pendingRevive(taskId)
    if (!pending) return release()
    const { task, run, reason } = pending
    try {
      await local(taskId)
      const resolution = await beforeLeadStart(taskId)
      const repo = task.repos.find((r) => !r.removed)
      const env = (repo && store.recordedSetup(task.id, repo.name)?.env) ?? {}
      acknowledgeLeadMessages(run)
      const current = find(taskId)
      if (current.archived || current.stopped || current.waitsForBlockers) return
      const lead = effectiveLead(current, resolution && defaultLead(resolution.workflow.settings))
      const messages = current.pendingLeadMessages
      await runs.revive(run.id, {
        prompt: [
          overnightGuidance(current.autopilot?.enabled === true, current.setup),
          revivedMessage(reason),
          ...editedSince(task),
          ...messages.map((message) => message.text),
        ].join('\n\n'),
        messageIds: messages.map((message) => message.id),
        ...(lead && {
          flags: {
            ...(lead.model !== undefined && { model: lead.model }),
            ...(lead.effort !== undefined && { effort: lead.effort }),
            usesDefaultModel: run.usesDefaultModel === true && run.model === lead.model,
          },
        }),
        env: { ...env, TED_TASK: task.displayId },
      })
      if (current.leadRestartPending) {
        store.setLeadRestartPending(taskId, false)
        await store.persisted()
      }
      await deliver(task.id)
      afterLeadStart(task.id)
    } catch (error) {
      console.error(`couldn’t resume ${task.displayId}’s Task Lead session:`, error)
      const now = store.getTask(task.id)
      if (now && !now.stopped && !now.archived && store.getRun(run.id)?.state === 'finished') {
        store.leadFailed({
          taskId: task.id,
          runId: run.id,
          reason,
          recovery: 'fresh',
          resumeFailed: true,
        })
      }
    } finally {
      release()
    }
  }

  function checkSilence(): void {
    if (closed) return
    const paused = store.agentPauses()
    const now = clock.now()
    const live = store.liveRuns()
    const working = new Set(live.filter((run) => run.state === 'working').map((run) => run.id))
    for (const id of pausedAt.keys()) if (!working.has(id)) pausedAt.delete(id)
    for (const run of live) {
      if (run.state !== 'working' || run.taskId === undefined || silent.has(run.id)) {
        if (run.state === 'waiting') pausedAt.set(run.id, now)
        continue
      }
      if (run.parentRunId !== undefined) continue
      const lead = store.taskRunList(run.taskId).find((r) => r.parentRunId === undefined)
      if (lead?.id !== run.id) continue
      if (paused[run.agent] !== undefined) {
        pausedAt.set(run.id, now)
        continue
      }
      const heard = [store.lastOutputAt(run.id), run.revivedAt, run.startedAt]
        .flatMap((at) => (at === undefined ? [] : [Date.parse(at)]))
        .concat(pausedAt.get(run.id) ?? [], runs.lastHeard(run.id) ?? [])
      if (now - Math.max(...heard) < stallAfterMs) continue
      silent.set(run.id, silentReason(stallAfterMs))
      background('stop a silent Task Lead', () => runs.stop(run.id))
    }
  }

  function stoppedMidTurn(runId: string): void {
    interrupted.add(runId)
    turnEnding.add(runId)
  }
  function settled(run: Run): void {
    if (!interrupted.has(run.id)) signedOutAt.delete(run.id)
    turnEnding.delete(run.id)
    if (!readyMidTurn.delete(run.id) || store.agentPauses()[run.agent] !== undefined) return
    if (!interrupted.delete(run.id)) return
    runs.send(run.id, continueMessage).catch((error: unknown) => console.error(error))
  }
  function finished(run: Run): void {
    interrupted.delete(run.id)
    turnEnding.delete(run.id)
    readyMidTurn.delete(run.id)
    const signedOut = signedOutAt.get(run.id)
    signedOutAt.delete(run.id)
    background(`check why Run ${run.id} stopped`, () => leadStopped(run, signedOut))
  }
  function ready(agent: AgentKind): void {
    wake()
    for (const runId of [...interrupted]) {
      const run = store.getRun(runId)
      if (run && run.state !== 'finished' && run.agent !== agent) continue
      if (run?.state === 'working' && turnEnding.has(runId)) {
        readyMidTurn.add(runId)
        continue
      }
      interrupted.delete(runId)
      if (run && run.state !== 'finished' && run.state !== 'working') {
        runs.send(runId, continueMessage).catch((error: unknown) => console.error(error))
      }
    }
  }
  function offline(agent: AgentKind): void {
    for (const run of store.listRuns()) {
      if (run.agent === agent && run.state === 'working') interrupted.add(run.id)
    }
  }
  function probe(agent: AgentKind): boolean {
    const run = [...interrupted]
      .map((id) => store.getRun(id))
      .find((r) => r !== undefined && r.agent === agent && r.state !== 'finished')
    if (!run) return false
    interrupted.delete(run.id)
    runs.send(run.id, continueMessage).catch((error: unknown) => console.error(error))
    return true
  }
  function restoreHealth(): void {
    const paused = store.agentPauses()
    for (const run of store.listRuns()) {
      if (run.state === 'finished') continue
      const agent = agents.get(run.agent)
      const recent = runs.output.last(run.id, 5)
      const limit = recent.map(({ line }) => agent.usageFrom(line)).findLast((u) => u !== undefined)
      if (limit?.limited) {
        interrupted.add(run.id)
        health.limited(run.agent, limit.resetsAt)
        continue
      }
      if (paused[run.agent] === undefined) continue
      if (recent.some(({ line }) => agent.authErrorFrom(line))) interrupted.add(run.id)
    }
  }
  function recoverStartup(): void {
    for (const task of store.listTasks()) {
      if (pendingRevive(task.id)) {
        awaitingRevive.add(task.id)
        continue
      }
      const run = task.leadRunId === undefined ? undefined : store.getRun(task.leadRunId)
      if (run?.state === 'finished' && run.ended && run.ended.how !== 'stopped') {
        background(`check why Run ${run.id} stopped`, () => leadStopped(run))
      }
    }
    silenceTimer = clock.interval(checkSilence, Math.min(60_000, Math.max(50, stallAfterMs / 4)))
    silenceTimer.unref()
  }
  return {
    prepare,
    applyLead,
    restartNow,
    acknowledgeLeadMessages,
    interruptedSetups,
    pendingRevive: (taskId: string) => pendingRevive(taskId) !== undefined,
    pendingRecoveryTaskIds: (): readonly string[] =>
      [...awaitingRevive].filter((taskId) => pendingRevive(taskId) !== undefined),
    applying: (taskId: string) => applying.has(taskId),
    restartWaiting: (taskId: string) => restartAsked.has(taskId),
    failed: leadFailed,
    recovering: (runId: string) => recovering.has(runId),
    async resume(taskId: string): Promise<void> {
      const release = hold(taskId)
      try {
        await prepare(taskId, { kind: 'held' })
      } finally {
        release()
      }
    },
    reviveCandidates() {
      return [...awaitingRevive].flatMap((taskId) => {
        const pending = pendingRevive(taskId)
        if (!pending) {
          awaitingRevive.delete(taskId)
          return []
        }
        return [{ taskId, factoryId: pending.task.factoryId, agent: pending.run.agent }]
      })
    },
    beginRevive(taskId: string): Promise<void> {
      awaitingRevive.delete(taskId)
      return reviveLead(taskId)
    },
    async useDefaultModel(task: StoredTask): Promise<void> {
      const run = liveLead(task)
      if (run?.problem !== 'model-unavailable' || applying.has(task.id))
        throw new RequestError(409, `${task.displayId}’s Task Lead isn’t waiting on its model`)
      applying.add(task.id)
      try {
        await restartLead(run, {
          ...(run.model !== undefined && { model: run.model }),
          ...(run.effort !== undefined && { effort: run.effort }),
          usesDefaultModel: true,
        })
      } finally {
        applying.delete(task.id)
      }
    },
    authFailed(run: Run): void {
      if (!signedOutAt.has(run.id)) signedOutAt.set(run.id, new Date().toISOString())
      if (run.state !== 'finished') stoppedMidTurn(run.id)
    },
    stoppedMidTurn,
    settled,
    finished,
    ready,
    offline,
    probe,
    restoreHealth,
    recoverStartup,
    close(): void {
      closed = true
      silenceTimer?.cancel()
    },
  }
}
