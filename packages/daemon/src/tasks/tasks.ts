import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  AgentStageId,
  AnswerRequest,
  Attachment,
  CheckRun,
  CheckRunReport,
  CheckRunTrigger,
  Comment,
  CommentAnswer,
  DaemonEvent,
  FactoryBoard,
  InboxItem,
  LinearIssue,
  MoveTaskRequest,
  OutcomeResult,
  Priority,
  ReportOutcomeRequest,
  RoundInput,
  Run,
  RunSlots,
  SetClarifyDepthRequest,
  StageId,
  StartSubAgentRequest,
  SubAgent,
  SubAgentWait,
  Task,
  TaskBrief,
  TaskDefaults,
  TaskLead,
  TaskRepo,
  TaskSource,
  ThreadEvent,
  WorktreeCommandOutcome,
} from '@ted/protocol'
import { briefHeadings, clarifyDepths, parseLinearUrl, priorities } from '@ted/protocol'
import type { Agents } from '../agents/index.ts'
import type { Banners } from '../banners.ts'
import { worktreeCommandEnv } from '../command-env.ts'
import { RequestError } from '../errors.ts'
import { clonePath, ensureClone } from '../factories.ts'
import * as git from '../git.ts'
import type { Gh } from '../github/gh.ts'
import type { AgentHealthMonitor } from '../health/agent-health.ts'
import type { IdleTimer } from '../idle.ts'
import type { Linear } from '../linear/linear.ts'
import { redactSecrets } from '../redact.ts'
import type { RunManager } from '../runs/run-manager.ts'
import type {
  NewTask,
  RecordedSetup,
  RunFlags,
  StoredFactory,
  StoredTask,
  TedStore,
} from '../store/index.ts'
import { resolveAgentChoices } from '../workflow/agent-choices.ts'
import type { WorkflowSettings } from '../workflow/check.ts'
import { boardStages, type ResolvedWorkflow } from '../workflow/resolve.ts'
import {
  backStageMessage,
  nextStageMessage,
  stageTitle,
  taskLeadPrompt,
} from '../workflow/workflow.ts'
import type { WorkflowResolution, Workflows } from '../workflow/workflows.ts'
import {
  type CheckRunnerResult,
  failureFindings,
  lastLines,
  planChecks,
  readOutput,
  runChecks,
  summary,
  tedSettingsCheck,
} from './checks.ts'
import {
  alreadyFailed,
  asksForFreshRun,
  endingReason,
  failedAsk,
  freshAfterFailure,
  recentFailures,
  retryChoice,
  revivedMessage,
  silentReason,
} from './failures.ts'
import { placeBetween } from './order.ts'
import {
  createPullRequests,
  type PullRequestTarget,
  type PullRequestTask,
} from './pull-requests.ts'
import { type QueueEntry, queueOrder, type SlotUse, startsNow } from './queue.ts'
import {
  clarifySignoffCaption,
  depthNames,
  pickDepth,
  roundAnswerMessage,
  roundAnswerSummary,
  roundAnswers,
} from './rounds.ts'
import { createSubAgents } from './sub-agents.ts'
import { nudgeMessage, threadEvents } from './thread.ts'
import {
  type CommandResult,
  copyFiles,
  outputTail,
  primaryRepoWorktree,
  runWorktreeCommand,
} from './worktree.ts'

export type Caller = { kind: 'daemon' } | { kind: 'run'; runId: string }

export interface CreateTaskInput
  extends Omit<NewTask, 'title' | 'factoryId' | 'startRequested' | 'blockedBy' | 'source'> {
  title?: string
  source?: string
  factory?: string
  blockedBy?: string[]
  attachments?: Attachment[]
  start?: boolean
}

export interface Tasks {
  create(input: CreateTaskInput): Promise<Task>
  defaults(factoryId: string): Promise<TaskDefaults>
  board(factoryId: string): Promise<FactoryBoard>
  start(ref: string): Promise<Task>
  moveToBacklog(ref: string): Task
  stop(ref: string): Promise<Task>
  resume(ref: string, input?: { comment?: string }): Promise<Task>
  move(ref: string, request: MoveTaskRequest): Task
  setPriority(ref: string, priority: Priority): Task
  archive(ref: string, options?: { closePullRequests?: boolean }): Task
  block(ref: string, caller: Caller, by: string): Promise<Task>
  unblock(ref: string, caller: Caller, by?: string): Task
  slots(): Promise<RunSlots>
  subscribe(listener: (event: DaemonEvent) => void): () => void
  comment(
    ref: string,
    caller: Caller,
    input: { body: string; choices?: string[]; round?: RoundInput; supersedes?: string },
  ): Promise<Comment>
  setClarifyDepth(ref: string, caller: Caller, request: SetClarifyDepthRequest): Promise<Task>
  markRead(ref: string): number
  threadEvents(ref: string): ThreadEvent[]
  setActivity(ref: string, caller: Caller, text: string): Task
  reportOutcome(ref: string, caller: Caller, outcome: ReportOutcomeRequest): Promise<OutcomeResult>
  answer(commentId: string, answer: AnswerRequest): Promise<Comment>
  writeBrief(ref: string, caller: Caller, text: string): TaskBrief
  brief(ref: string, caller: Caller): TaskBrief
  inbox(): InboxItem[]
  setLead(ref: string, lead: TaskLead): Task
  useDefaultModel(ref: string): Promise<Task>
  setupLog(ref: string, repo: string): Promise<string>
  runChecks(ref: string, caller: Caller, only?: string): Promise<CheckRun>
  checkRun(id: string, caller: Caller): Promise<CheckRunReport>
  checkOutput(id: string, position: number): Promise<{ text: string; log: string }>
  wake(factoryId?: string): void
  startSubAgent(ref: string, caller: Caller, input: StartSubAgentRequest): Promise<SubAgent>
  waitForSubAgent(runId: string, caller: Caller, timeoutMs: number): Promise<SubAgentWait>
  sendSubAgent(runId: string, caller: Caller, text: string): Promise<SubAgent>
  stopSubAgent(runId: string, caller: Caller): Promise<SubAgent>
  close(): Promise<void>
}

const slugLength = 40

export function createTasks(options: {
  store: TedStore
  runs: RunManager
  workflows: Workflows
  banners: Banners
  reposDir: string
  worktreesDir: string
  logsDir: string
  libraryDir?: string
  agents: Agents
  health: AgentHealthMonitor
  attachmentFile: (attachment: Attachment) => string
  linear?: Pick<Linear, 'issueFor'>
  isCloned?: (factoryId: string) => boolean
  idle?: IdleTimer
  gh?: Gh
  nudgeAfterMs?: number
  stallAfterMs?: number
}): Tasks {
  const {
    store,
    runs,
    workflows,
    banners,
    reposDir,
    worktreesDir,
    logsDir,
    agents,
    health,
    attachmentFile,
  } = options
  const starting = new Set<string>()
  const relaunching = new Set<string>()
  const interrupted = new Set<string>()
  const advancing = new Set<string>()
  const applying = new Set<string>()
  const asked = new Map<string, string>()
  const stoppingForBlockers = new Set<string>()
  const sendingComments = new Set<string>()
  const stoppingByHand = new Set<string>()
  const nudgeTimers = new Map<string, NodeJS.Timeout>()
  const nudgeAfterMs = options.nudgeAfterMs ?? 60_000
  const stallAfterMs = options.stallAfterMs ?? 30 * 60_000
  const silent = new Map<string, string>()
  const pausedAt = new Map<string, number>()
  const recovering = new Set<string>()
  const awaitingRevive = new Set<string>()
  const background = new Set<Promise<void>>()
  const stopping = new AbortController()
  const holds = new Map<string, number>()
  const beginning = new Map<string, Promise<void>>()
  const settingUp = new Map<string, AbortController>()
  const caps = new Map<string, number | undefined>()
  const listeners = new Set<(event: DaemonEvent) => void>()
  const checking = new Set<string>()
  const pullRequests = options.gh && createPullRequests({ store, gh: options.gh })
  const pullRequestQueue = new Map<string, Promise<void>>()
  let pumping: Promise<void> | undefined
  let again = false
  let shownSlots = ''

  function hold(taskId: string): () => void {
    holds.set(taskId, (holds.get(taskId) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const left = (holds.get(taskId) ?? 1) - 1
      if (left > 0) holds.set(taskId, left)
      else holds.delete(taskId)
      void pump()
    }
  }

  function remember(factoryId: string, resolution: WorkflowResolution): WorkflowResolution {
    caps.set(factoryId, resolution.workflow.settings.max_working_runs)
    return resolution
  }

  async function resolveWorkflow(
    factory: StoredFactory,
    options?: { fetch?: boolean },
  ): Promise<WorkflowResolution> {
    return remember(factory.id, await workflows.resolve(factory, options))
  }

  async function capOf(factoryId: string): Promise<number | undefined> {
    if (caps.has(factoryId)) return caps.get(factoryId)
    const factory = store.getFactory(factoryId)
    if (!factory) return undefined
    const resolution = await workflows.resolve(factory, { fetch: false }).catch(() => undefined)
    if (!resolution) return undefined
    return remember(factoryId, resolution).workflow.settings.max_working_runs
  }

  async function slotUse(factoryIds: readonly string[]) {
    const all = store.listTasks()
    const holders = all.flatMap((task) => {
      const working = task.runs.filter(
        (r) => r.state === 'working' && r.paused === undefined && !r.onSubAgents,
      )
      const startingSubAgents = subAgents.starting(task.id)
      const runs = working.length + startingSubAgents
      const subAgentRuns = working.filter((r) => r.role === 'sub-agent').length + startingSubAgents
      const settingUp =
        task.status?.kind !== 'stopped' &&
        !task.statuses.includes('queued') &&
        task.repos.some((r) => !r.removed && r.setup?.state === 'running')
      const slots = Math.max(runs, settingUp || holds.has(task.id) ? 1 : 0)
      return slots > 0 ? [{ task, runs, subAgentRuns, settingUp, slots }] : []
    })
    const byFactory: Record<string, number> = {}
    for (const { task, slots } of holders) {
      byFactory[task.factoryId] = (byFactory[task.factoryId] ?? 0) + slots
    }
    const capsNow: Record<string, number | undefined> = {}
    for (const id of new Set([...factoryIds, ...holders.map((h) => h.task.factoryId)])) {
      capsNow[id] = await capOf(id)
    }
    const use: SlotUse = {
      limit: store.settings().maxWorkingRuns,
      working: holders.reduce((sum, h) => sum + h.slots, 0),
      byFactory,
      caps: capsNow,
    }
    return { use, holders, all }
  }

  const cloned = (factoryId: string) => options.isCloned?.(factoryId) ?? true
  const ready = (): QueueEntry[] =>
    queueOrder<QueueEntry>([
      ...subAgents.queued(),
      ...runnable(store.queue()).filter((q) => q.factoryId === undefined || cloned(q.factoryId)),
    ]).filter((q) => q.kind !== 'sub-agent' || subAgentRunnable(q.id))

  function subAgentRunnable(id: string): boolean {
    const request = store.subAgentRequests().find((r) => r.id === id)
    return request !== undefined && store.agentPauses()[request.agent] === undefined
  }

  function heldReady(): QueueEntry[] {
    const paused = store.agentPauses()
    return store.heldRuns().flatMap((held) => {
      const task = store.getTask(held.taskId)
      const agent = task?.lead?.agent ?? held.agent
      if (!task || paused[agent] !== undefined || holds.has(task.id)) return []
      if (task.waitsForBlockers || task.stopped) return []
      return [{ id: task.id, kind: 'task' as const, rank: -1, factoryId: task.factoryId }]
    })
  }

  function revivesReady(): QueueEntry[] {
    const paused = store.agentPauses()
    return [...awaitingRevive].flatMap((taskId) => {
      const pending = pendingRevive(taskId)
      if (!pending) {
        awaitingRevive.delete(taskId)
        return []
      }
      if (paused[pending.run.agent] !== undefined || holds.has(taskId)) return []
      return [{ id: taskId, kind: 'task' as const, rank: -1, factoryId: pending.task.factoryId }]
    })
  }

  async function fill(): Promise<void> {
    if (store.newWorkHold() !== undefined) return
    const revives = revivesReady()
    const held = heldReady()
    const queued = ready()
    if (queued.length === 0 && held.length === 0 && revives.length === 0) return
    const { use } = await slotUse(
      [...revives, ...held, ...queued].flatMap((q) => q.factoryId ?? []),
    )
    const heldIds = new Set(held.map((h) => h.id))
    const reviveIds = new Set(revives.map((r) => r.id))
    for (const entry of startsNow<QueueEntry>([...revives, ...held, ...ready()], use)) {
      if (reviveIds.has(entry.id)) {
        awaitingRevive.delete(entry.id)
        inBackground('resume a Task Lead session', () => reviveLead(entry.id))
      } else if (heldIds.has(entry.id)) relaunch(entry.id)
      else if (entry.kind === 'sub-agent') subAgents.begin(entry.id)
      else if (!holds.has(entry.id)) begin(entry.id)
    }
  }

  function runnable<T extends { id: string }>(entries: readonly T[]): T[] {
    const paused = store.agentPauses()
    return entries.filter((entry) => {
      const agent = store.getTask(entry.id)?.lead?.agent
      return agent === undefined || paused[agent] === undefined
    })
  }

  function pump(): Promise<void> {
    again = true
    if (closed) return Promise.resolve()
    pumping ??= (async () => {
      while (again) {
        again = false
        await fill()
      }
    })()
      .catch((error: unknown) => console.error('couldn’t start queued Tasks:', error))
      .finally(() => {
        pumping = undefined
        if (again) void pump()
        else void publishSlots()
      })
    return pumping
  }

  async function slots(): Promise<RunSlots> {
    const factoryIds = store.listFactories().map((f) => f.id)
    const { use, holders, all } = await slotUse(factoryIds)
    const byId = new Map(all.map((t) => [t.id, t]))
    const requests = new Map(store.subAgentRequests().map((r) => [r.id, r]))
    const ordered = queueOrder<QueueEntry>([...subAgents.queued(), ...store.queue()])
    const queue = ordered.flatMap((entry): RunSlots['queue'] => {
      const request = requests.get(entry.id)
      const task = byId.get(request?.taskId ?? entry.id)
      if (!task) return []
      if (request) {
        return [
          {
            kind: 'sub-agent',
            place: 0,
            runId: request.id,
            name: request.name,
            taskId: task.id,
            displayId: task.displayId,
            factoryId: task.factoryId,
          },
        ]
      }
      return [
        {
          kind: 'task',
          place: 0,
          taskId: task.id,
          displayId: task.displayId,
          title: task.title,
          factoryId: task.factoryId,
          priority: task.priority,
        },
      ]
    })
    for (const [i, entry] of queue.entries()) entry.place = i + 1
    return {
      limit: use.limit,
      working: use.working,
      queued: queue.length,
      holders: holders.map(({ task, runs, subAgentRuns, settingUp }) => ({
        kind: 'task' as const,
        taskId: task.id,
        displayId: task.displayId,
        title: task.title,
        factoryId: task.factoryId,
        runs,
        subAgents: subAgentRuns,
        settingUp,
      })),
      queue,
      factories: factoryIds.flatMap((factoryId) => {
        const cap = use.caps[factoryId]
        return cap === undefined ? [] : [{ factoryId, cap, working: use.byFactory[factoryId] ?? 0 }]
      }),
    }
  }

  async function publishSlots(): Promise<void> {
    if (closed) return
    const current = await slots().catch(() => undefined)
    const shown = JSON.stringify(current)
    if (!current || closed || shown === shownSlots) return
    const first = shownSlots === ''
    shownSlots = shown
    if (first) return
    for (const listener of listeners) listener({ type: 'slots-changed', slots: current })
  }

  function begin(taskId: string): Promise<void> {
    const release = hold(taskId)
    const work = launchQueued(taskId)
      .catch((error: unknown) => {
        if (store.queue().some((q) => q.id === taskId)) {
          if (store.getTask(taskId)?.repos.some((r) => !r.removed)) store.waitForBlockers(taskId)
          else store.moveToBacklog(taskId)
          const message = error instanceof Error ? error.message : String(error)
          store.setActivity(taskId, oneLine(`Couldn’t start: ${message}`))
        }
        throw error
      })
      .finally(() => {
        beginning.delete(taskId)
        release()
      })
    beginning.set(taskId, work)
    inBackground(`start ${store.getTask(taskId)?.displayId ?? taskId}`, () => work)
    return work
  }

  function inBackground(what: string, work: () => Promise<void>): void {
    const release = options.idle?.hold()
    const done = work()
      .catch((error: unknown) => console.error(`couldn’t ${what}:`, error))
      .finally(() => {
        background.delete(done)
        release?.()
      })
    background.add(done)
  }

  const commandLog = (task: Task, kind: 'setup' | 'teardown', name: string) =>
    path.join(logsDir, 'worktrees', `${task.displayId}-${name}-${kind}.log`)

  const commandEnv = (task: Task, env: Record<string, string>): NodeJS.ProcessEnv =>
    worktreeCommandEnv(env, { TED_TASK: task.displayId })

  const checkDir = (task: Task, checkRunId: string) =>
    path.join(logsDir, 'checks', task.displayId, checkRunId)

  const checkLog = (task: Task, checkRunId: string, position: number) =>
    path.join(checkDir(task, checkRunId), `${position + 1}.log`)

  async function beginChecks(
    task: StoredTask,
    resolution: WorkflowResolution,
    trigger: CheckRunTrigger,
    only?: string,
  ): Promise<{ checkRun: CheckRun; done: Promise<CheckRunnerResult> } | undefined> {
    const factory = factoryOf(task)
    const settings = primaryRepoWorktree(resolution.workflow, factory)
    const plan = await planChecks({
      checks: resolution.workflow.settings.stages.validate?.checks ?? [],
      repos: task.repos
        .filter((r) => !r.removed)
        .map((r) => ({
          name: r.name,
          worktree: r.worktree,
          baseBranch: settings.baseBranch,
          env: r.name === settings.name ? settings.env : {},
        })),
      primary: settings.name,
      ...(only !== undefined && { only }),
    })
    if (plan.length === 0) return undefined
    const checkRun = store.startChecks({
      taskId: task.id,
      trigger,
      stage: task.stage,
      checks: plan.map((p) => p.check),
    })
    const done = (async () => {
      const result = await runChecks({
        checks: plan,
        taskDisplayId: task.displayId,
        libraryDir: options.libraryDir ?? path.join(path.dirname(logsDir), 'library'),
        logFor: (position) => checkLog(task, checkRun.id, position),
        signal: stopping.signal,
        onStart: (position) => store.checkStarted(checkRun.id, position),
        onFinish: (position, finished) => store.checkFinished(checkRun.id, position, finished),
      }).catch((error: unknown) => {
        console.error(`couldn’t run ${task.displayId}’s Checks:`, error)
        return { outcome: 'interrupted' as const, notFound: [] }
      })
      if (result.outcome === 'interrupted' && stopping.signal.aborted) return result
      store.finishChecks(checkRun.id, result.outcome)
      reportNotFound(factory.id, result)
      return result
    })()
    return { checkRun, done }
  }

  function reportNotFound(factoryId: string, result: CheckRunnerResult): void {
    const ref = { problem: 'setup-suggested', factoryId, subject: 'check-not-found' }
    const [command] = result.notFound
    if (command !== undefined) {
      banners.raise({
        ...ref,
        severity: 'warning',
        text: `A Check’s command wasn’t found: \`${command}\``,
        action: { label: 'Open Factory settings', opens: { kind: 'factory-settings', factoryId } },
      })
    } else if (result.outcome !== 'interrupted') {
      banners.clear(ref)
    }
  }

  async function failedFindings(task: Task, checkRun: CheckRun): Promise<string | undefined> {
    const position = checkRun.checks.findIndex(
      (c) => c.state === 'failed' || c.state === 'timed-out',
    )
    const check = checkRun.checks[position]
    if (!check) return undefined
    const log = checkLog(task, checkRun.id, position)
    return failureFindings({ check, output: await lastLines(log), log, checks: checkRun.checks })
  }

  async function report(checkRun: CheckRun): Promise<string> {
    const task = find(checkRun.taskId)
    if (checkRun.outcome === 'interrupted') {
      return `TED stopped before the Checks finished.\n\n${summary(checkRun.checks)}`
    }
    return (await failedFindings(task, checkRun)) ?? `Checks passed.\n\n${summary(checkRun.checks)}`
  }

  async function validateChecks(taskId: string, message?: string): Promise<void> {
    checking.add(taskId)
    try {
      const task = find(taskId)
      const resolution = await resolveWorkflow(factoryOf(task), { fetch: false })
      const { workflow } = resolution
      const instructions = message ?? nextStageMessage(workflow, 'validate')
      const started = await beginChecks(task, resolution, 'validate')
      if (!started) {
        await deliver(task, instructions)
        return
      }
      const result = await started.done
      const checkRun = store.getCheckRun(started.checkRun.id) ?? started.checkRun
      const current = find(taskId)
      if (result.outcome === 'interrupted' || current.stage !== 'validate') return
      if (result.outcome === 'passed') {
        await deliver(
          current,
          `${instructions}\n\n# Checks\n\nTED ran the Factory’s Checks before handing you this Stage. None failed:\n\n${summary(checkRun.checks)}`,
        )
        return
      }
      const findings = (await failedFindings(current, checkRun)) ?? summary(checkRun.checks)
      await writeFile(path.join(checkDir(current, checkRun.id), 'findings.md'), findings, {
        mode: 0o600,
      })
      const canSendBack =
        workflow.stages.includes('work') &&
        workflow.order.indexOf('work') < workflow.order.indexOf('validate')
      if (!canSendBack) {
        await deliver(
          current,
          `${instructions}\n\n# A Check failed\n\nTED ran the Factory’s Checks and one failed. Work isn’t before Validate in this Workflow, so TED couldn’t send the Task back.\n\n${findings}`,
        )
        return
      }
      const outcome = await holding(current, () =>
        sendBack(
          current,
          resolution,
          'validate',
          { outcome: 'back', to: 'work', findings },
          checkRun.id,
        ),
      )
      if (outcome.request) {
        await deliver(
          current,
          `${instructions}\n\n# A Check failed\n\nTED ran the Factory’s Checks and one failed. ${outcome.message}\n\n${findings}`,
        )
      }
    } finally {
      checking.delete(taskId)
    }
  }

  async function pullRequestTargets(task: StoredTask): Promise<PullRequestTarget[]> {
    const factory = factoryOf(task)
    const { workflow } = await resolveWorkflow(factory, { fetch: false })
    const primary = primaryRepoWorktree(workflow, factory)
    const live = task.repos.filter((r) => !r.removed)
    return Promise.all(
      live.map(async (r) => ({
        name: r.name,
        repo: r.repo,
        branch: r.branch,
        worktree: r.worktree,
        url: factory.repos.find((f) => f.repo === r.repo)?.cloneUrl ?? factory.cloneUrl,
        base:
          workflow.settings.repos?.find((s) => s.name === r.name)?.base_branch ??
          (r.name === primary.name ? primary.baseBranch : await git.defaultBranch(r.worktree)),
      })),
    )
  }

  function pullRequestTask(task: StoredTask): PullRequestTask {
    const brief = store.latestBrief(task.id)
    const goal = brief ? briefSection(brief.text, 'goal') : task.description
    return {
      id: task.id,
      displayId: task.displayId,
      title: task.title,
      ...(goal !== undefined && goal !== '' && { goal }),
      ...(task.source?.url !== undefined && { sourceUrl: task.source.url }),
    }
  }

  function pullRequestWork(taskId: string, what: 'first' | 'again' | 'ready' | 'close'): void {
    const prs = pullRequests
    if (!prs) return
    const task = find(taskId)
    const work = async () => {
      if (what === 'close') return prs.close(taskId)
      const current = find(taskId)
      const targets = await pullRequestTargets(current)
      if (what === 'ready') await prs.ready(pullRequestTask(current), targets)
      else await prs.push(pullRequestTask(current), targets, what)
    }
    const next = (pullRequestQueue.get(taskId) ?? Promise.resolve()).then(work)
    const settled = next.catch(() => undefined)
    pullRequestQueue.set(taskId, settled)
    void settled.then(() => {
      if (pullRequestQueue.get(taskId) === settled) pullRequestQueue.delete(taskId)
    })
    inBackground(`update ${task.displayId}’s pull requests`, () => next)
  }

  const leadFrom = (settings?: WorkflowSettings) =>
    resolveAgentChoices(settings, {
      claude: agents.installed('claude'),
      codex: agents.installed('codex'),
    }).lead

  const subAgents = createSubAgents({
    store,
    runs,
    agents,
    find: (ref) => find(ref),
    async leadFor(task) {
      if (task.lead) return task.lead
      return leadFrom((await resolveWorkflow(factoryOf(task), { fetch: false })).workflow.settings)
    },
    async envFor(task, repo) {
      const recorded = store.recordedSetup(task.id, repo.name)?.env
      if (recorded) return recorded
      const factory = factoryOf(task)
      const resolution = await resolveWorkflow(factory, { fetch: false })
      return primaryRepoWorktree(resolution.workflow, factory).env
    },
    async permissionsFor(task) {
      const resolution = await resolveWorkflow(factoryOf(task), { fetch: false })
      return resolution.workflow.settings.permissions === 'bypass' ? 'bypass' : 'auto'
    },
    clonePathFor: (task) => clonePath(reposDir, factoryOf(task)),
    worktreesDir,
    pump: () => void pump(),
    inBackground: (what, work) => inBackground(what, work),
  })

  const sameChoice = (lead: TaskLead, run: Run) =>
    lead.agent === run.agent && lead.model === run.model && lead.effort === run.effort

  const atIdlePoint = (run: Run) =>
    run.state === 'idle' || (run.problem !== undefined && run.state === 'waiting')

  function liveLead(task: StoredTask): Run | undefined {
    if (!task.leadRunId || task.stage === 'backlog' || task.stage === 'done') return undefined
    const run = store.getRun(task.leadRunId)
    return run && run.state !== 'finished' ? run : undefined
  }

  async function applyLead(taskId: string): Promise<void> {
    if (applying.has(taskId)) return
    const task = store.getTask(taskId)
    const run = task && liveLead(task)
    if (!task?.lead || !run || sameChoice(task.lead, run) || !atIdlePoint(run)) return
    applying.add(taskId)
    try {
      const lead = task.lead
      if (lead.agent !== run.agent) {
        if (store.newWorkHold() !== undefined) return
        await freshLead(task, run)
      } else {
        await restartLead(run, {
          ...(lead.model !== undefined && { model: lead.model }),
          ...(lead.effort !== undefined && { effort: lead.effort }),
          usesDefaultModel: run.usesDefaultModel === true && run.model === lead.model,
        })
      }
    } finally {
      applying.delete(taskId)
    }
    await applyLead(taskId)
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

  async function freshLead(task: StoredTask, run: Run): Promise<void> {
    const factory = factoryOf(task)
    const repo = task.repos.find((r) => !r.removed)
    if (!repo) throw new Error(`${task.displayId} has no worktree`)
    const resolution = await resolveWorkflow(factory, { fetch: false })
    const env =
      store.recordedSetup(task.id, repo.name)?.env ??
      primaryRepoWorktree(resolution.workflow, factory).env
    await runs.stop(run.id)
    await launch(task, resolution, repo, env)
  }

  function askAboutModel(run: Run): void {
    if (run.problem !== 'model-unavailable') {
      const id = asked.get(run.id)
      asked.delete(run.id)
      if (id !== undefined && store.getComment(id)?.answer === undefined) {
        store.answerComment(id, {
          kind: 'answered',
          at: new Date().toISOString(),
          text: 'The Task Lead no longer waits on this model.',
        })
      }
      return
    }
    const task = run.taskId === undefined ? undefined : store.getTask(run.taskId)
    if (!task || task.leadRunId !== run.id || asked.has(run.id)) return
    const question = store.postComment({
      taskId: task.id,
      kind: 'question',
      author: { kind: 'ted' },
      title: `${run.model} isn’t in your plan`,
      body: `The Task Lead asked for the model “${run.model}”, which your plan doesn’t include. TED won’t switch models on its own, so the Run is waiting. Choose Use the default model to run this Run on the CLI’s default model, or Change setting to pick another model in the Task Lead field.`,
      choices: [useDefaultChoice, 'Change setting'],
    })
    asked.set(run.id, question.id)
  }

  async function useDefaultModel(ref: string): Promise<Task> {
    const task = find(ref)
    const run = liveLead(task)
    if (run?.problem !== 'model-unavailable' || applying.has(task.id)) {
      throw new RequestError(409, `${task.displayId}’s Task Lead isn’t waiting on its model`)
    }
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
    return publicTask(task.id)
  }

  let closed = false
  const unsubscribe = store.subscribe((event) => {
    if (event.type !== 'run-updated' || event.run.taskId === undefined) return
    const { run } = event
    setImmediate(() => {
      if (closed) return
      watchIdle(run)
      askAboutModel(run)
      if (run.taskId !== undefined) {
        const taskId = run.taskId
        inBackground('apply the Task Lead setting', () => applyLead(taskId))
      }
    })
  })
  for (const task of store.listTasks()) {
    inBackground('apply the Task Lead setting', () => applyLead(task.id))
  }

  function find(ref: string): StoredTask {
    const task = store.getTask(ref)
    if (!task) throw new RequestError(404, `no Task ${ref}`)
    return task
  }

  function ownTask(ref: string, caller: Caller): { task: StoredTask; runId: string } {
    if (caller.kind !== 'run') {
      throw new RequestError(403, 'only a Run on this Task can do this for now')
    }
    const task = find(ref)
    if (store.getRun(caller.runId)?.taskId !== task.id) {
      throw new RequestError(403, `this Run doesn’t belong to ${task.displayId}`)
    }
    return { task, runId: caller.runId }
  }

  function factoryOf(task: Task) {
    const factory = store.getFactory(task.factoryId)
    if (!factory) throw new RequestError(409, `${task.displayId}’s Factory has no repo`)
    return factory
  }

  async function linearIssue(url: string): Promise<LinearIssue | undefined> {
    const link = parseLinearUrl(url)
    if (!link || !options.linear) return undefined
    const lookup = await options.linear.issueFor(link).catch((error: unknown) => {
      console.error(
        redactSecrets(`fetching ${link.identifier} from Linear failed: ${String(error)}`),
      )
      return undefined
    })
    return lookup?.state === 'found' ? lookup.issue : undefined
  }

  async function branchFor(clone: string, task: Task): Promise<string> {
    const suggested = task.source?.linear?.branchName
    const base =
      suggested !== undefined && (await git.isValidBranchName(clone, suggested))
        ? suggested
        : ['ted/', task.displayId.toLowerCase(), slug(task.title)].join('')
    for (let n = 1; ; n++) {
      const branch = n === 1 ? base : `${base}-${n}`
      if (!(await git.branchExists(clone, branch))) return branch
    }
  }

  async function finish(task: StoredTask, resolution: WorkflowResolution): Promise<void> {
    await pullRequestQueue.get(task.id)
    subAgents.dropFor(task.id)
    await Promise.all(
      store
        .taskRunList(task.id)
        .filter((r) => r.state !== 'finished')
        .map((r) => runs.stop(r.id)),
    )
    const factory = factoryOf(task)
    const clone = clonePath(reposDir, factory)
    for (const worktree of subAgents.ownWorktrees(task)) {
      await git.removeWorktree(clone, worktree).catch((error: unknown) => {
        console.error(`couldn’t remove a sub-agent worktree of ${task.displayId}:`, error)
      })
    }
    const settings = primaryRepoWorktree(resolution.workflow, factory)
    const removed: {
      name: string
      teardown?: { command: string; outcome: WorktreeCommandOutcome }
    }[] = []
    for (const repo of task.repos.filter((r) => !r.removed)) {
      const teardown = settings.name === repo.name ? settings.teardown : undefined
      let result: CommandResult | undefined
      if (teardown) {
        result = await runWorktreeCommand({
          command: teardown,
          cwd: repo.worktree,
          env: commandEnv(task, settings.env),
          log: commandLog(task, 'teardown', repo.name),
          signal: stopping.signal,
        }).catch((error: unknown) => {
          console.error(`couldn’t run teardown for ${task.displayId}:`, error)
          return { outcome: 'failed' as const }
        })
        if (result.outcome !== 'passed') {
          console.error(
            `teardown for ${task.displayId} in ${repo.name} ${result.outcome}; removing the worktree anyway`,
          )
        }
      }
      await git.removeWorktree(clone, repo.worktree)
      removed.push({
        name: repo.name,
        ...(teardown &&
          result &&
          result.outcome !== 'interrupted' && {
            teardown: { command: teardown.run, outcome: result.outcome },
          }),
      })
    }
    if (task.repos.length === 0 && task.worktree) await git.removeWorktree(clone, task.worktree)
    await rm(path.join(worktreesDir, task.displayId), { recursive: true, force: true })
    for (const { name, teardown } of removed) store.worktreeRemoved(task.id, name, teardown)
  }

  async function launch(
    task: StoredTask,
    resolution: WorkflowResolution,
    repo: TaskRepo,
    env: Record<string, string>,
    setupReport?: string,
    { resumeSession, pickUp }: { resumeSession?: string; pickUp?: string } = {},
  ): Promise<void> {
    const current = find(task.id)
    if (current.archived || current.stopped) return
    const lead = task.lead ?? leadFrom(resolution.workflow.settings)
    const agent = lead.agent
    const note = pickUp ?? (resumeSession === undefined ? pendingPickUp(current) : undefined)
    if (!(await health.ready(agent))) {
      store.holdTaskRun({
        taskId: task.id,
        agent,
        ...(resumeSession !== undefined && { sessionId: resumeSession }),
      })
      return
    }
    const waiting = waitingForRun(task.id)
    const since = sinceLastRun(task.id, waiting, resumeSession === undefined && note === undefined)
    const prompt = [
      ...(resumeSession === undefined
        ? [
            await taskLeadPrompt(
              task,
              resolution.workflow,
              task.stage as AgentStageId,
              attachmentFile,
              setupReport,
            ),
            ...(note !== undefined ? [note] : []),
          ]
        : [continueMessage]),
      ...(since !== undefined ? [since] : []),
      ...(resumeSession !== undefined && movedByApproval(current, waiting.answers)
        ? [nextStageMessage(resolution.workflow, current.stage as AgentStageId)]
        : []),
    ].join('\n\n')
    const run = await runs.start({
      agent,
      prompt,
      cwd: repo.worktree,
      taskId: task.id,
      env: { ...env, TED_TASK: task.displayId },
      permissions: resolution.workflow.settings.permissions === 'bypass' ? 'bypass' : 'auto',
      ...(resumeSession !== undefined && { resume: resumeSession }),
      ...(lead.model !== undefined && { model: lead.model }),
      ...(lead.effort !== undefined && { effort: lead.effort }),
    })
    store.commentsDelivered(
      waiting.comments.map((c) => c.id),
      run.id,
    )
    store.answersDelivered(
      waiting.answers.map((c) => c.id),
      run.id,
    )
    store.releaseTaskRun(task.id)
    await sendWaiting(task.id)
  }

  function waitingForRun(taskId: string): { comments: Comment[]; answers: Comment[] } {
    return {
      comments: store
        .listComments(taskId)
        .filter(
          (c) =>
            c.author.kind === 'human' && c.delivered === undefined && !sendingComments.has(c.id),
        ),
      answers: store.heldAnswers(taskId),
    }
  }

  function sinceLastRun(
    taskId: string,
    { comments, answers }: { comments: Comment[]; answers: Comment[] },
    withBrief: boolean,
  ): string | undefined {
    const items = [
      ...comments.map((c) => ({ at: c.createdAt, line: `- ${c.createdAt}: ${flat(c.body)}` })),
      ...answers.flatMap((c) => {
        const answer = answerText(c)
        return answer === undefined
          ? []
          : [
              {
                at: c.answer?.at ?? c.createdAt,
                line: `- ${c.answer?.at ?? c.createdAt}: the human answered “${c.title ?? firstLine(c.body)}”: ${flat(answer)}`,
              },
            ]
      }),
    ].sort((a, b) => a.at.localeCompare(b.at))
    if (items.length === 0) return undefined
    const brief = withBrief ? store.latestBrief(taskId) : undefined
    return [
      '# Comments since the last Run',
      'The human wrote these while no Run was working on this Task. Read them before you carry on.',
      ...(brief ? [`## Task brief (version ${brief.version})\n\n${brief.text.trim()}`] : []),
      items.map((i) => i.line).join('\n'),
    ].join('\n\n')
  }

  async function sendWaiting(taskId: string): Promise<void> {
    const task = store.getTask(taskId)
    const run = task && liveLead(task)
    if (!task || !run) return
    for (const c of waitingForRun(taskId).comments) await sendComment(run.id, c)
  }

  async function sendComment(runId: string, comment: Comment): Promise<void> {
    sendingComments.add(comment.id)
    try {
      await runs.send(runId, humanMessage(comment.body))
      store.commentsDelivered([comment.id], runId)
    } catch (error) {
      console.error(`couldn’t send a Comment to Run ${runId}; the next Run gets it:`, error)
    } finally {
      sendingComments.delete(comment.id)
    }
  }

  function roundsThisVisit(task: Task): Comment[] {
    const since = visitStart(task)
    return store
      .listComments(task.id)
      .filter((c) => c.kind === 'round' && c.stage === 'clarify' && c.createdAt >= since)
  }

  function openRound(task: Task): Comment | undefined {
    return store.listComments(task.id).find((c) => c.kind === 'round' && c.answer === undefined)
  }

  async function postRound(
    task: StoredTask,
    runId: string,
    input: RoundInput,
    supersedes: string | undefined,
  ): Promise<Comment> {
    if (task.leadRunId !== runId) throw new RequestError(403, 'only the Task Lead posts a round')
    if (task.stage !== 'clarify') {
      throw new RequestError(
        409,
        `rounds are for Clarify, and ${task.displayId} is in ${stageTitle(task.stage)}`,
      )
    }
    if (task.clarifyDepth === 'auto') {
      throw new RequestError(409, `pick a Clarify depth first with \`${pickDepth}\``)
    }
    if (task.clarifyDepth === 'none') {
      throw new RequestError(
        409,
        `Clarify depth is None, which asks no questions; change it with \`${pickDepth}\` first`,
      )
    }
    return holding(task, async () => {
      const old = supersedes === undefined ? undefined : store.getComment(supersedes)
      if (supersedes !== undefined) {
        if (!old || old.taskId !== task.id) {
          throw new RequestError(404, `no request ${supersedes} on ${task.displayId}`)
        }
        if (old.kind !== 'round') throw new RequestError(400, 'a round can replace only a round')
        if (!postedBy(old, task, runId)) {
          throw new RequestError(403, 'a Run can supersede only its own requests')
        }
        if (old.answer) throw new RequestError(409, 'that request has already been answered')
      } else {
        const open = openRound(task)
        if (open) {
          throw new RequestError(
            409,
            `Round ${open.round?.number ?? ''} is still waiting on the human; if it’s out of date, replace it with \`ted ask --supersedes ${open.id} --round <file>\``,
          )
        }
        const answered = roundsThisVisit(task).some((c) => c.answer?.kind === 'answered')
        if (task.clarifyDepth === 'few' && answered) {
          throw new RequestError(
            409,
            'Clarify depth is Few, which asks one round; to ask more, switch to grilling with `ted clarify depth grilling "<why>"`',
          )
        }
      }
      const numbers = store.listComments(task.id).map((c) => c.round?.number ?? 0)
      const comment = {
        taskId: task.id,
        kind: 'round' as const,
        title: input.title,
        body: input.summary ?? '',
        author: { kind: 'run' as const, runId },
        round: {
          number: old?.round?.number ?? Math.max(0, ...numbers) + 1,
          questions: input.questions,
        },
      }
      return old ? store.supersedeComment(old.id, comment) : store.postComment(comment)
    })
  }

  async function humanComment(task: StoredTask, body: string): Promise<Comment> {
    const posted = store.postComment({ taskId: task.id, body, author: { kind: 'human' } })
    const run = liveLead(find(task.id))
    if (!run) return posted
    await sendComment(run.id, posted)
    return store.getComment(posted.id) ?? posted
  }

  function markAccepted(run: Run, texts: string[]): void {
    if (run.taskId === undefined) return
    const read = store
      .listComments(run.taskId)
      .filter(
        (c) =>
          c.author.kind === 'human' &&
          c.delivered?.runId === run.id &&
          c.readAt === undefined &&
          texts.some((text) => flat(text).includes(flat(c.body))),
      )
    store.commentsRead(read.map((c) => c.id))
  }

  async function setUpAndLaunch(
    task: StoredTask,
    resolution: WorkflowResolution,
    repo: TaskRepo,
    setup: RecordedSetup,
    pickUp?: string,
  ): Promise<void> {
    const release = hold(task.id)
    try {
      await setUpThenLaunch(task, resolution, repo, setup, pickUp)
    } finally {
      release()
    }
  }

  async function setUpThenLaunch(
    task: StoredTask,
    resolution: WorkflowResolution,
    repo: TaskRepo,
    setup: RecordedSetup,
    pickUp?: string,
  ): Promise<void> {
    const before = find(task.id)
    if (before.stopped || before.archived) return
    if (store.queue().some((q) => q.id === task.id)) store.dequeue(task.id)
    store.worktreeSetupStarted(task.id, repo.name, setup)
    const log = commandLog(task, 'setup', repo.name)
    const cancel = new AbortController()
    settingUp.set(task.id, cancel)
    const result = await runWorktreeCommand({
      command: { run: setup.command, timeoutMs: setup.timeoutMs },
      cwd: repo.worktree,
      env: commandEnv(task, setup.env),
      log,
      signal: AbortSignal.any([stopping.signal, cancel.signal]),
    }).finally(() => settingUp.delete(task.id))
    const now = find(task.id)
    if (result.outcome === 'interrupted' || now.archived || now.stopped) return
    store.worktreeSetupFinished(task.id, repo.name, {
      outcome: result.outcome,
      ...(result.exitCode !== undefined && { exitCode: result.exitCode }),
    })
    const report =
      result.outcome === 'passed'
        ? undefined
        : setupFailure(setup.command, result, await outputTail(log))
    await launch(find(task.id), resolution, repo, setup.env, report, {
      ...(pickUp !== undefined && { pickUp }),
    })
  }

  async function resume(taskId: string): Promise<void> {
    const release = hold(taskId)
    try {
      await resumeTask(taskId)
    } finally {
      release()
    }
  }

  async function resumeTask(taskId: string): Promise<void> {
    const task = find(taskId)
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
      const resolution = await workflows.resolve(factoryOf(task), { fetch: false })
      const env = store.recordedSetup(task.id, repo.name)?.env ?? {}
      return launch(task, resolution, repo, env, undefined, { resumeSession: held.sessionId })
    }
    const factory = factoryOf(task)
    const resolution = await resolveWorkflow(factory, { fetch: false })
    const recorded = store.recordedSetup(task.id, repo.name)
    const setup = repo.setup
    if (recorded && setup?.state === 'running') {
      return setUpAndLaunch(task, resolution, repo, recorded)
    }
    const report =
      setup && setup.state !== 'passed' && setup.state !== 'running'
        ? setupFailure(
            setup.command,
            {
              outcome: setup.state,
              ...(setup.exitCode !== undefined && { exitCode: setup.exitCode }),
            },
            await outputTail(commandLog(task, 'setup', repo.name)),
          )
        : undefined
    const env = recorded?.env ?? primaryRepoWorktree(resolution.workflow, factory).env
    await launch(task, resolution, repo, env, report)
  }

  function entryFor({ workflow, layers }: WorkflowResolution, stage: AgentStageId | 'done') {
    const file = stage === 'done' ? undefined : workflow.stageFile(stage)
    const order = workflow.order.map((id) => ({
      stage: id,
      enabled: workflow.stages.includes(id),
    }))
    return { ...(file && { stageFile: { layer: file.layer, path: file.path } }), layers, order }
  }

  function publicTask(id: string): Task {
    const task = store.listTasks().find((t) => t.id === id)
    if (!task) throw new RequestError(404, `no Task ${id}`)
    return task
  }

  async function holding<T>(task: Task, work: () => Promise<T>): Promise<T> {
    if (advancing.has(task.id)) {
      throw new RequestError(409, `${task.displayId} is already moving; try again`)
    }
    advancing.add(task.id)
    try {
      return await work()
    } finally {
      advancing.delete(task.id)
    }
  }

  async function deliver(task: Task, text: string): Promise<boolean> {
    const runId = find(task.id).leadRunId
    const run = runId === undefined ? undefined : store.getRun(runId)
    if (!run || run.state === 'finished') return false
    await runs.send(run.id, text)
    return true
  }

  async function deliverAnswer(task: Task, comment: Comment, text: string): Promise<void> {
    if (!(await deliver(task, text))) store.holdAnswer(comment.id)
  }

  async function answerRound(task: Task, comment: Comment, request: AnswerRequest) {
    if (!comment.round) throw new RequestError(409, 'this round has no questions')
    const answers = roundAnswers(comment.round, request)
    return holding(task, async () => {
      const current = store.getComment(comment.id)
      if (current?.answer?.kind === 'withdrawn') {
        throw new RequestError(409, 'this request was withdrawn')
      }
      if (current?.answer?.kind === 'superseded') {
        throw new RequestError(409, 'this request was replaced by a newer one')
      }
      if (current?.answer) throw new RequestError(409, 'this request has already been answered')
      const answered = answerRequest(task, comment, {
        kind: 'answered',
        at: new Date().toISOString(),
        answers,
      })
      await deliverAnswer(
        task,
        comment,
        roundAnswerMessage(comment, answers, find(task.id).clarifyDepth),
      )
      return answered
    })
  }

  async function move(
    task: StoredTask,
    resolution: WorkflowResolution,
    next: AgentStageId | 'done',
    message: string | undefined,
  ): Promise<Task> {
    const moved = store.changeStage(task.id, next, entryFor(resolution, next))
    if (next === 'validate') pullRequestWork(task.id, 'first')
    if (next === 'merge') pullRequestWork(task.id, 'ready')
    if (next === 'done') {
      inBackground(`finish ${task.displayId}`, () => finish(task, resolution))
    } else if (next === 'validate' && message !== undefined) {
      checking.add(task.id)
      inBackground(`run ${task.displayId}’s Checks`, () => validateChecks(task.id, message))
    } else if (message !== undefined) {
      await deliver(task, message)
    }
    return moved
  }

  function postedBy(request: Comment, task: StoredTask, runId: string): boolean {
    const { author } = request
    if (author.kind !== 'run') return false
    if (author.runId === runId) return true
    const authorRun = store.getRun(author.runId)
    return (
      task.leadRunId === runId &&
      authorRun?.taskId === task.id &&
      authorRun.parentRunId === undefined
    )
  }

  function answerRequest(task: Task, comment: Comment, answer: CommentAnswer): Comment {
    const answered = store.answerComment(comment.id, answer)
    if (comment.stage !== undefined) store.resetSendBacks(task.id, comment.stage)
    return answered
  }

  async function answerPermission(
    task: Task,
    comment: Comment,
    request: AnswerRequest,
    text: string,
  ): Promise<Comment> {
    if (request.action !== 'approve' && request.action !== 'deny') {
      throw new RequestError(400, 'answer a permission request with Approve or Deny')
    }
    const target = store.permissionTarget(comment.id)
    if (!target) throw new RequestError(409, 'this request can’t be answered')
    return holding(task, async () => {
      const current = store.getComment(comment.id)
      if (current?.answer?.kind === 'withdrawn') {
        throw new RequestError(409, 'this request was withdrawn')
      }
      if (current?.answer) throw new RequestError(409, 'this request has already been answered')
      if (store.getRun(target.runId)?.state === 'finished') {
        throw new RequestError(409, 'the Run that asked has stopped')
      }
      const approved = request.action === 'approve'
      const at = new Date().toISOString()
      const answered = store.answerPermission(comment.id, {
        kind: approved ? 'approved' : 'denied',
        at,
        ...(text !== '' && { text }),
      })
      const said = permissionMessage(approved, target.command, text)
      await runs.answerPermission(target.runId, target.generation, {
        requestId: target.requestId,
        approved,
        ...(target.input !== undefined && { input: target.input }),
        ...(said !== undefined && { text: said }),
      })
      return answered
    })
  }

  function visitStart(task: Task): string {
    return store.listStageEntries(task.id).findLast((e) => e.stage === task.stage)?.at ?? ''
  }

  function lastChangesRequested(task: Task): string {
    const since = visitStart(task)
    return store
      .listComments(task.id)
      .flatMap((c) =>
        c.gate && c.stage === task.stage && c.answer?.kind === 'changes-requested'
          ? [c.answer.at]
          : [],
      )
      .filter((at) => at >= since)
      .reduce(latest, '')
  }

  function openGateRequest(task: Task): Comment | undefined {
    return store
      .listComments(task.id)
      .find((c) => c.gate && c.stage === task.stage && c.answer === undefined)
  }

  async function sendBack(
    task: StoredTask,
    resolution: WorkflowResolution,
    from: AgentStageId,
    request: Extract<ReportOutcomeRequest, { outcome: 'back' }>,
    checkRunId?: string,
  ): Promise<OutcomeResult> {
    const { workflow } = resolution
    const to = request.to
    const findings = request.findings.trim()
    if (!workflow.stages.includes(to)) {
      throw new RequestError(409, `${stageTitle(to)} isn’t on in this Factory’s Workflow`)
    }
    if (workflow.order.indexOf(to) >= workflow.order.indexOf(from)) {
      throw new RequestError(
        409,
        `\`back\` goes only to an earlier Stage; ${stageTitle(to)} isn’t before ${stageTitle(from)}`,
      )
    }
    const counted = lastChangesRequested(task) === ''
    const limit = workflow.settings.stages[from]?.max_back
    const count = store.sendBackCount(task.id, from)
    if (counted && limit !== undefined && count >= limit) {
      const times = `${count} ${count === 1 ? 'time' : 'times'}`
      const request = store.postComment({
        taskId: task.id,
        kind: 'question',
        author: { kind: 'ted' },
        title: `${stageTitle(from)} wants to send this Task back to ${stageTitle(to)} again`,
        body: `${stageTitle(from)} has sent this Task back ${times}, its limit (max_back: ${limit}). Its Findings this time:\n\n${findings}`,
        choices: [`Send it back to ${stageTitle(to)}`, `Keep it in ${stageTitle(from)}`],
      })
      return {
        task: publicTask(task.id),
        message: `${stageTitle(from)} has sent this Task back ${times}, its limit, so TED asked the human instead. TED sends you their answer.`,
        request,
      }
    }
    store.recordSendBack({
      taskId: task.id,
      from,
      to,
      findings,
      counted,
      ...(counted && { round: count + 1 }),
      ...(counted && limit !== undefined && { limit }),
      ...(checkRunId !== undefined && { checkRunId }),
    })
    if (from === 'review') store.resetSendBacks(task.id, 'validate')
    const moved = await move(task, resolution, to, backStageMessage(workflow, to, from, findings))
    return { task: moved, message: `${task.displayId} moved back to ${stageTitle(to)}` }
  }

  function live(ref: string): StoredTask {
    const task = find(ref)
    if (task.archived) throw new RequestError(409, `${task.displayId} is archived`)
    return task
  }

  async function clearAway(taskId: string): Promise<void> {
    if (store.heldRuns().some((h) => h.taskId === taskId)) store.releaseTaskRun(taskId)
    settingUp.get(taskId)?.abort()
    await beginning.get(taskId)?.catch(() => undefined)
    settingUp.get(taskId)?.abort()
    subAgents.dropFor(taskId)
    const task = find(taskId)
    await Promise.all(task.runs.map((run) => runs.stop(run.id)))
    if (!task.repos.some((r) => !r.removed) && !task.worktree) return
    const resolution = await resolveWorkflow(factoryOf(task), { fetch: false })
    await finish(find(taskId), resolution)
  }

  async function start(ref: string): Promise<Task> {
    const task = live(ref)
    const factory = factoryOf(task)
    if (task.stage !== 'backlog' || starting.has(task.id)) {
      throw new RequestError(409, `${task.displayId} has already started`)
    }
    if (unmergedBlockers(task.id).length > 0) return store.setStartRequested(task.id, true)
    starting.add(task.id)
    try {
      if (cloned(factory.id)) await ensureClone({ banners, reposDir }, factory)
      const resolution = await resolveWorkflow(factory, { fetch: false })
      if (!task.lead) store.setTaskLead(task.id, leadFrom(resolution.workflow.settings))
      store.queueTask(task.id, resolution.workflow.next('backlog'))
    } finally {
      starting.delete(task.id)
    }
    await pump()
    await beginning.get(task.id)
    return publicTask(task.id)
  }

  async function launchQueued(taskId: string): Promise<void> {
    const task = find(taskId)
    const factory = factoryOf(task)
    const repo = task.repos.find((r) => !r.removed)
    if (repo) {
      const resolution = await resolveWorkflow(factory, { fetch: false })
      const recorded = store.recordedSetup(task.id, repo.name)
      const pickUp = freshRunNote(task)
      if (recorded && repo.setup?.state === 'running') {
        await setUpAndLaunch(find(task.id), resolution, repo, recorded, pickUp)
      } else {
        const env = recorded?.env ?? primaryRepoWorktree(resolution.workflow, factory).env
        await launch(find(task.id), resolution, repo, env, undefined, { pickUp })
      }
      store.dequeue(task.id)
      return
    }
    {
      const clone = await ensureClone({ banners, reposDir }, factory)
      await git.fetch(clone)
      const resolution = await resolveWorkflow(factory, { fetch: false })
      if (!task.lead) store.setTaskLead(task.id, leadFrom(resolution.workflow.settings))
      const stage = resolution.workflow.next('backlog') as AgentStageId
      const settings = primaryRepoWorktree(resolution.workflow, factory)
      const branch = await branchFor(clone, task)
      const worktree = path.join(worktreesDir, task.displayId, settings.name)
      await mkdir(path.dirname(worktree), { recursive: true })
      await git
        .addWorktree(clone, { path: worktree, branch, from: `origin/${settings.baseBranch}` })
        .catch((error: unknown) => {
          throw new RequestError(
            409,
            `couldn’t make ${task.displayId}’s worktree from origin/${settings.baseBranch}: ${error instanceof Error ? error.message : String(error)}`,
          )
        })
      const copy = await copyFiles(store.localFolder(factory.repo), worktree, settings.copy).catch(
        async (error: unknown) => {
          await git.removeWorktree(clone, worktree)
          await git.deleteBranch(clone, branch)
          throw new RequestError(
            409,
            `couldn’t copy files into ${task.displayId}’s worktree: ${error instanceof Error ? error.message : String(error)}`,
          )
        },
      )
      store.startTask({
        taskId: task.id,
        stage,
        branch,
        worktree,
        entry: entryFor(resolution, stage),
        repo: { name: settings.name, repo: factory.repo, ...copy },
      })
      const started = find(task.id)
      const repo = started.repos.find((r) => r.name === settings.name)
      if (!repo) throw new Error(`${task.displayId} has no worktree record`)
      const setup = settings.setup
      if (setup) {
        inBackground(`set up ${task.displayId}’s worktree`, () =>
          setUpAndLaunch(started, resolution, repo, {
            command: setup.run,
            timeoutMs: setup.timeoutMs,
            env: settings.env,
          }),
        )
      } else {
        await launch(started, resolution, repo, settings.env)
      }
    }
  }

  function pendingPickUp(task: StoredTask): string | undefined {
    const log = store.taskLog(task.id)
    const asked = log.findLastIndex(asksForFreshRun)
    const started = log.findLastIndex(
      (e) => e.name === 'v2.RunStarted' || e.name === 'v3.RunStarted',
    )
    return asked > started ? freshRunNote(task) : undefined
  }

  function movedByApproval(task: StoredTask, answers: readonly Comment[]): boolean {
    if (task.stage === 'backlog' || task.stage === 'done') return false
    return answers.some((c) => c.gate && c.answer?.kind === 'approved' && c.stage !== task.stage)
  }

  function freshRunNote(task: StoredTask): string {
    const last = store.taskLog(task.id).findLast(asksForFreshRun)
    if (last?.name === 'v1.TaskRetried' || last?.name === 'v1.TaskLeadFailed') {
      return fromTheBrief(task, freshAfterFailure(last))
    }
    if (last?.name === 'v1.TaskResumed') {
      return fromTheBrief(task, {
        heading: 'Picking up after a stop',
        why: 'The human stopped this Task and has now resumed it.',
      })
    }
    const merged = store
      .blockers(task.id)
      .filter((b) => b.merged)
      .map((b) => b.displayId)
    return fromTheBrief(task, {
      heading: 'Picking up after a blocker',
      why: `This Task waited for ${joinIds(merged)}, which ${merged.length === 1 ? 'has' : 'have'} merged.`,
    })
  }

  function fromTheBrief(task: StoredTask, { heading, why }: { heading: string; why: string }) {
    const brief = store.latestBrief(task.id)
    const authors = { ted: 'TED', human: 'The human', run: 'Task Lead' } as const
    const notes = store
      .listComments(task.id)
      .filter((c) => !brief || c.createdAt > brief.createdAt)
      .filter((c) => c.author.kind !== 'human' || c.delivered !== undefined)
      .map(
        (c) => `- ${authors[c.author.kind]}, ${c.createdAt}: ${c.body.replace(/\s*\n\s*/g, ' ')}`,
      )
    return [
      `# ${heading}`,
      `${why} An earlier Run worked on it in this worktree and has stopped. Read the Task brief, the Comments since and the branch’s commits to see where it stopped, then carry on with this Stage.`,
      ...(brief ? [`## Task brief (version ${brief.version})\n\n${brief.text.trim()}`] : []),
      ...(notes.length > 0
        ? [`## ${brief ? 'Comments since the brief' : 'Comments'}\n\n${notes.join('\n')}`]
        : []),
    ].join('\n\n')
  }

  function cycleFrom(blockerId: string, taskId: string): string[] | undefined {
    const seen = new Set<string>()
    const walk = (id: string): string[] | undefined => {
      if (id === taskId) return [id]
      if (seen.has(id)) return undefined
      seen.add(id)
      for (const link of store.blockers(id)) {
        const rest = walk(link.blockerId)
        if (rest) return [id, ...rest]
      }
      return undefined
    }
    return walk(blockerId)
  }

  function unmergedBlockers(taskId: string) {
    return store.blockers(taskId).filter((b) => !b.merged)
  }

  function shouldStopForBlockers(task: StoredTask, run: Run): boolean {
    return (
      run.state === 'idle' &&
      task.stage !== 'backlog' &&
      task.stage !== 'done' &&
      unmergedBlockers(task.id).some((b) => b.setByRunId === run.id)
    )
  }

  async function stopForBlockers(taskId: string): Promise<void> {
    const task = store.getTask(taskId)
    const run = task && liveLead(task)
    if (!task || !run || stoppingForBlockers.has(taskId) || !shouldStopForBlockers(task, run)) {
      return
    }
    stoppingForBlockers.add(taskId)
    try {
      await runs.stop(run.id)
      store.waitForBlockers(taskId)
    } finally {
      stoppingForBlockers.delete(taskId)
    }
    wake()
  }

  function wake(): void {
    const queued = new Set(store.queue().map((q) => q.id))
    for (const { id } of store.listTasks()) {
      const task = store.getTask(id)
      if (!task || task.blockedBy.length === 0 || queued.has(id) || starting.has(id)) continue
      if (task.archived || task.stopped) continue
      if (unmergedBlockers(id).length > 0) continue
      if (task.stage === 'backlog' && task.startRequested) {
        inBackground(`start ${task.displayId}`, async () => {
          await start(id)
        })
      } else if (task.waitsForBlockers && !liveLead(task)) {
        store.requeueAfterBlockers(id)
      }
    }
  }

  function tellLead(blocker: StoredTask, run: Run): Promise<void> {
    const id = blocker.displayId
    return runs.send(
      run.id,
      `The human made this Task wait for ${id} (“${blocker.title}”). If this Task can’t go on until ${id} merges, run \`ted task block --by ${id}\`, write the Task brief with \`ted brief write\`, and end your turn: TED stops this Run and starts a fresh one when ${id} merges. If you can carry on, say why with \`ted comment\` and keep working.`,
    )
  }

  function relaunch(taskId: string): void {
    if (relaunching.has(taskId)) return
    relaunching.add(taskId)
    const release = hold(taskId)
    inBackground(`continue ${taskId}`, () =>
      resume(taskId).finally(() => {
        relaunching.delete(taskId)
        release()
      }),
    )
  }

  async function leadStopped(run: Run): Promise<void> {
    if (run.taskId === undefined) return
    const silence = silent.get(run.id)
    silent.delete(run.id)
    pausedAt.delete(run.id)
    const task = store.getTask(run.taskId)
    if (!task || task.leadRunId !== run.id || task.stage === 'backlog' || task.stage === 'done') {
      return
    }
    const [checked] = await health.check([run.agent])
    if (checked?.state === 'ready') {
      const ended = store.getRun(run.id)?.ended
      if (silence !== undefined || (ended !== undefined && ended.how !== 'stopped')) {
        await leadFailed(run.id, silence)
      }
      return
    }
    const now = store.getTask(task.id)
    if (!now || now.leadRunId !== run.id || now.stage === 'done') return
    if (now.waitsForBlockers || now.stopped) return
    store.holdTaskRun({
      taskId: task.id,
      agent: run.agent,
      ...(run.sessionId !== undefined && { sessionId: run.sessionId }),
    })
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
    if (task.status?.kind === 'failed' || stoppingByHand.has(task.id)) return
    if (stoppingForBlockers.has(task.id) || store.queue().some((q) => q.id === task.id)) return
    if (store.heldRuns().some((h) => h.taskId === task.id)) return
    const log = store.taskLog(task.id)
    if (alreadyFailed(log, run.id, run.revivedAt ?? run.startedAt)) return
    const ended = run.ended
    const reason = silence ?? endingReason(ended)
    const resumeFailed = silence === undefined && ended?.resumeFailed === true
    const now = Date.now()
    const earlier = recentFailures(log, now)
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
    const first = earlier[0]
    store.leadFailed({
      taskId: task.id,
      runId: run.id,
      reason,
      recovery,
      resumeFailed,
      ...(recovery === 'failed' && {
        ask: failedAsk(run.agent, first ? log.slice(log.indexOf(first)) : [], reason, ended, now),
      }),
    })
    if (recovery === 'resume') awaitingRevive.add(task.id)
    void pump()
  }

  function pendingRevive(
    taskId: string,
  ): { task: StoredTask; run: Run; reason: string } | undefined {
    const task = store.getTask(taskId)
    if (!task || task.archived || task.stopped || task.waitsForBlockers) return undefined
    if (task.stage === 'backlog' || task.stage === 'done') return undefined
    const last = store.taskLog(taskId).findLast((e) => e.name === 'v1.TaskLeadFailed')
    if (last?.data.recovery !== 'resume') return undefined
    const run = store.getRun(String(last.data.runId))
    if (run?.state !== 'finished' || task.leadRunId !== run.id) return undefined
    if (run.revivedAt !== undefined && run.revivedAt >= last.at) return undefined
    return { task, run, reason: String(last.data.reason) }
  }

  async function reviveLead(taskId: string): Promise<void> {
    const release = hold(taskId)
    const pending = pendingRevive(taskId)
    if (!pending) return release()
    const { task, run, reason } = pending
    try {
      const repo = task.repos.find((r) => !r.removed)
      const env = (repo && store.recordedSetup(task.id, repo.name)?.env) ?? {}
      await runs.revive(run.id, {
        prompt: revivedMessage(reason),
        env: { ...env, TED_TASK: task.displayId },
      })
      await sendWaiting(task.id)
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
    const now = Date.now()
    for (const run of store.listRuns()) {
      if (run.state !== 'working' || run.taskId === undefined || silent.has(run.id)) {
        if (run.state !== 'working') pausedAt.delete(run.id)
        continue
      }
      if (store.getTask(run.taskId)?.leadRunId !== run.id) continue
      if (paused[run.agent] !== undefined) {
        pausedAt.set(run.id, now)
        continue
      }
      const heard = [store.lastOutputAt(run.id), run.revivedAt, run.startedAt]
        .flatMap((at) => (at === undefined ? [] : [Date.parse(at)]))
        .concat(pausedAt.get(run.id) ?? [], runs.lastHeard(run.id) ?? [])
      if (now - Math.max(...heard) < stallAfterMs) continue
      silent.set(run.id, silentReason(stallAfterMs))
      inBackground('stop a silent Task Lead', () => runs.stop(run.id))
    }
  }

  async function stopByHand(ref: string): Promise<Task> {
    const task = live(ref)
    if (task.stage === 'done') throw new RequestError(409, `${task.displayId} is done`)
    const started =
      task.stage !== 'backlog' &&
      (task.leadRunId !== undefined || task.repos.length > 0 || beginning.has(task.id))
    if (!started) {
      throw new RequestError(409, `${task.displayId} hasn’t started, so there’s nothing to stop`)
    }
    if (task.stopped || stoppingByHand.has(task.id)) {
      throw new RequestError(409, `${task.displayId} is already stopped`)
    }
    stoppingByHand.add(task.id)
    try {
      if (store.heldRuns().some((h) => h.taskId === task.id)) store.releaseTaskRun(task.id)
      store.stopTask(task.id, { runs: task.runs.length, why: 'human' })
      subAgents.dropFor(task.id)
      settingUp.get(task.id)?.abort()
      await beginning.get(task.id)?.catch(() => undefined)
      settingUp.get(task.id)?.abort()
      await Promise.all(find(task.id).runs.map((run) => runs.stop(run.id)))
      closeIdleQuestion(task.id, 'The Task was stopped.')
    } finally {
      stoppingByHand.delete(task.id)
    }
    void pump()
    return publicTask(task.id)
  }

  async function resumeByHand(ref: string, { comment }: { comment?: string } = {}): Promise<Task> {
    const task = live(ref)
    if (!task.stopped && task.status?.kind !== 'failed') {
      throw new RequestError(409, `${task.displayId} isn’t stopped`)
    }
    if (stoppingByHand.has(task.id)) {
      throw new RequestError(409, `${task.displayId} is still stopping; try again`)
    }
    const text = comment?.trim() ?? ''
    if (text !== '') store.postComment({ taskId: task.id, body: text, author: { kind: 'human' } })
    const waitForBlockers = unmergedBlockers(task.id).length > 0
    if (task.status?.kind === 'failed') {
      const at = new Date().toISOString()
      for (const ask of openRequests(task.id).filter((c) => c.failed !== undefined)) {
        store.answerComment(ask.id, { kind: 'answered', at, choice: retryChoice })
      }
      store.retryTask(task.id, { waitForBlockers })
    } else {
      store.resumeTask(task.id, { waitForBlockers })
    }
    await pump()
    return publicTask(task.id)
  }

  function watchIdle(run: Run): void {
    const timer = nudgeTimers.get(run.id)
    if (run.state !== 'idle') {
      if (timer) clearTimeout(timer)
      nudgeTimers.delete(run.id)
      if (run.state === 'working' && run.taskId !== undefined) {
        if (store.getTask(run.taskId)?.leadRunId === run.id) {
          closeIdleQuestion(run.taskId, 'The Task Lead carried on.')
        }
      }
      return
    }
    if (timer || run.taskId === undefined) return
    const next = setTimeout(() => {
      nudgeTimers.delete(run.id)
      if (!closed) inBackground('nudge the Task Lead', () => nudgeIfIdle(run.id))
    }, nudgeAfterMs)
    next.unref()
    nudgeTimers.set(run.id, next)
  }

  async function nudgeIfIdle(runId: string): Promise<void> {
    const run = store.getRun(runId)
    if (run?.state !== 'idle' || run.problem !== undefined || run.taskId === undefined) return
    const task = store.getTask(run.taskId)
    if (!task || task.leadRunId !== run.id || task.archived || task.stopped) return
    if (task.stage === 'backlog' || task.stage === 'done' || advancing.has(task.id)) return
    if (store.heldRuns().some((h) => h.taskId === task.id)) return
    if (stoppingForBlockers.has(task.id) || shouldStopForBlockers(task, run)) return
    if (openRequests(task.id).length > 0) return
    const nudged = store
      .taskLog(task.id)
      .findLast((e) => e.name === 'v1.TaskLeadNudged' && e.data.runId === run.id)?.at
    if (nudged === undefined || heardSince(task, nudged)) await sendNudge(task, run)
    else askAboutIdle(task, run)
  }

  function heardSince(task: StoredTask, at: string): boolean {
    const comments = store.listComments(task.id)
    return (
      store.listStageEntries(task.id).some((e) => e.at > at) ||
      comments.some((c) => c.author.kind === 'human' && c.createdAt > at) ||
      comments.some((c) => c.answer !== undefined && c.answer.at > at)
    )
  }

  async function sendNudge(task: Task, run: Run): Promise<void> {
    await runs.send(run.id, nudgeMessage)
    store.leadNudged(task.id, run.id)
  }

  function askAboutIdle(task: StoredTask, run: Run): void {
    const agent = agents.get(run.agent)
    const said = store
      .conversation(run.id)
      .map(({ line }) => agent.agentTextFrom(line))
      .findLast((text) => text !== undefined && text.trim() !== '')
    const quoted = said === undefined ? undefined : oneLine(said, 500)
    store.postComment({
      taskId: task.id,
      kind: 'question',
      author: { kind: 'ted' },
      title: idleTitle,
      body:
        quoted === undefined
          ? 'It went idle again after the nudge, with nothing open, and wrote no message.'
          : `It went idle again after the nudge, with nothing open. Its last message:\n\n> ${quoted}`,
      choices: [nudgeAgainChoice],
    })
  }

  function openRequests(taskId: string): Comment[] {
    return store.listComments(taskId).filter((c) => c.kind !== 'note' && c.answer === undefined)
  }

  function closeIdleQuestion(taskId: string, text: string): void {
    for (const question of openRequests(taskId).filter(isIdleQuestion)) {
      store.answerComment(question.id, { kind: 'answered', at: new Date().toISOString(), text })
    }
  }

  runs.observe({
    authFailed(run) {
      if (run.state !== 'finished') interrupted.add(run.id)
      health.authFailed(run.agent)
    },
    accepted(run, texts) {
      markAccepted(run, texts)
      const timer = nudgeTimers.get(run.id)
      if (timer) clearTimeout(timer)
      nudgeTimers.delete(run.id)
      setImmediate(() => {
        const now = store.getRun(run.id)
        if (now && !closed) watchIdle(now)
      })
    },
    finished(run) {
      interrupted.delete(run.id)
      inBackground(`check why Run ${run.id} stopped`, () => leadStopped(run))
    },
  })

  health.onReady((agent) => {
    void pump()
    for (const runId of [...interrupted]) {
      const run = store.getRun(runId)
      if (run && run.state !== 'finished' && run.agent !== agent) continue
      interrupted.delete(runId)
      if (run && run.state !== 'finished') {
        runs.send(runId, continueMessage).catch((error: unknown) => console.error(error))
      }
    }
  })

  const paused = store.agentPauses()
  for (const run of store.listRuns()) {
    if (run.state === 'finished' || paused[run.agent] === undefined) continue
    const agent = agents.get(run.agent)
    if (
      store
        .conversation(run.id)
        .slice(-5)
        .some(({ line }) => agent.authErrorFrom(line))
    ) {
      interrupted.add(run.id)
    }
  }

  const heldAtStart = new Set(store.heldRuns().map((h) => h.taskId))
  for (const task of store.listTasks()) {
    if (task.archived && task.repos.some((r) => !r.removed)) {
      inBackground(`finish archiving ${task.displayId}`, () => clearAway(task.id))
      continue
    }
    if (heldAtStart.has(task.id)) continue
    if (task.leadRunId === undefined && task.repos.some((r) => !r.removed)) {
      inBackground(`resume ${task.displayId}`, () => resume(task.id))
    }
  }

  for (const run of store.listRuns()) {
    if (run.state === 'idle' && run.taskId !== undefined) watchIdle(run)
  }

  for (const task of store.listTasks()) {
    if (pendingRevive(task.id)) {
      awaitingRevive.add(task.id)
      continue
    }
    const run = task.leadRunId === undefined ? undefined : store.getRun(task.leadRunId)
    if (run?.state === 'finished' && run.ended && run.ended.how !== 'stopped') {
      inBackground(`check why Run ${run.id} stopped`, () => leadStopped(run))
    }
  }

  const silenceTimer = setInterval(checkSilence, Math.min(60_000, Math.max(50, stallAfterMs / 4)))
  silenceTimer.unref()

  for (const checkRun of store.listCheckRuns().filter((r) => r.finishedAt === undefined)) {
    store.finishChecks(checkRun.id, 'interrupted')
    const task = store.getTask(checkRun.taskId)
    if (checkRun.trigger === 'validate' && task?.stage === 'validate') {
      checking.add(task.id)
      inBackground(`run ${task.displayId}’s Checks again`, () => validateChecks(task.id))
    }
  }

  const stopPumping = store.subscribe((event) => {
    if (event.type === 'run-updated' && event.run.state === 'idle' && event.run.taskId) {
      const taskId = event.run.taskId
      setImmediate(() => {
        if (!closed) inBackground('stop a blocked Task Lead', () => stopForBlockers(taskId))
      })
    }
    if (event.type === 'task-updated' && event.task.stage === 'done') {
      setImmediate(() => {
        if (!closed) wake()
      })
    }
    if (
      event.type === 'run-updated' ||
      event.type === 'task-created' ||
      event.type === 'task-updated' ||
      event.type === 'settings-changed'
    ) {
      void pump()
    }
  })
  void pump()
  wake()
  for (const task of store.listTasks()) {
    inBackground('stop a blocked Task Lead', () => stopForBlockers(task.id))
  }

  return {
    async create({
      title,
      factory: key,
      blockedBy = [],
      start: startNow,
      lead,
      source: sourceUrl,
      ...fields
    }) {
      const issue = sourceUrl === undefined ? undefined : await linearIssue(sourceUrl)
      const name =
        title?.trim() || issue?.title || firstLine(fields.description ?? '') || sourceUrl || ''
      if (name === '') throw new RequestError(400, 'a Task needs a title or a description')
      const blockers = [...new Set(blockedBy.map((ref) => find(ref).id))]
      const factory =
        key === undefined ? undefined : store.listFactories().find((f) => f.key === key)
      if (key !== undefined && !factory) throw new RequestError(404, `no Factory with key ${key}`)
      let failure: unknown
      const resolution = factory
        ? await resolveWorkflow(factory, { fetch: cloned(factory.id) }).catch((error: unknown) => {
            failure = error
            return undefined
          })
        : undefined
      const task = await store.createTask({
        ...fields,
        ...(fields.description !== undefined && { description: fields.description.trim() }),
        title: name,
        ...(fields.priority === undefined && issue && { priority: issue.priority }),
        ...(sourceUrl !== undefined && { source: taskSource(sourceUrl, issue) }),
        lead: lead ?? leadFrom(resolution?.workflow.settings),
        blockedBy: blockers,
        startRequested: startNow === true,
        ...(factory && { factoryId: factory.id }),
      })
      if (!factory) return task
      if (!resolution) {
        console.error(
          `couldn’t read ${factory.repo}’s Workflow; ${task.displayId} waits in Backlog:`,
          failure,
        )
      }
      if (!resolution || unmergedBlockers(task.id).length > 0) return task
      const hasBacklog = resolution.workflow.stages.includes('backlog')
      return hasBacklog && startNow !== true ? task : start(task.id)
    },

    async defaults(factoryId) {
      const factory = store.getFactory(factoryId)
      if (!factory) throw new RequestError(404, `no Factory ${factoryId}`)
      const resolution = await resolveWorkflow(factory, { fetch: false })
      const depth = resolution.workflow.settings.stages.clarify?.depth
      return {
        lead: leadFrom(resolution.workflow.settings),
        clarifyDepth: clarifyDepths.find((d) => d === depth) ?? 'auto',
      }
    },

    async board(factoryId) {
      const factory = store.getFactory(factoryId)
      if (!factory) throw new RequestError(404, `no Factory ${factoryId}`)
      const resolution = await resolveWorkflow(factory, { fetch: false })
      return { stages: boardStages(resolution.workflow) }
    },

    start,
    stop: stopByHand,
    resume: resumeByHand,

    moveToBacklog(ref) {
      const task = find(ref)
      if (task.leadRunId !== undefined || task.repos.length > 0 || holds.has(task.id)) {
        throw new RequestError(
          409,
          `${task.displayId} has had a Run, so it can’t go back to Backlog`,
        )
      }
      if (!store.queue().some((q) => q.id === task.id)) {
        throw new RequestError(409, `${task.displayId} isn’t queued`)
      }
      return store.moveToBacklog(task.id)
    },

    move(ref, { after, before }) {
      const task = live(ref)
      if (after === undefined && before === undefined) {
        throw new RequestError(400, 'a move needs a Task to go after or before')
      }
      const neighbour = (other: string | undefined) => {
        if (other === undefined) return undefined
        const found = find(other)
        if (found.id === task.id) throw new RequestError(400, 'a Task can’t move next to itself')
        return found
      }
      const below = neighbour(after)
      const above = neighbour(before)
      const placed = placeBetween(task.priority, {
        ...(below && { after: below }),
        ...(above && { before: above }),
      })
      return store.rankTask(task.id, placed.rank, placed.priority)
    },

    setPriority(ref, priority) {
      return store.setPriority(live(ref).id, priority)
    },

    archive(ref, { closePullRequests = false } = {}) {
      const task = live(ref)
      const archived = store.archiveTask(task.id)
      if (closePullRequests) pullRequestWork(task.id, 'close')
      inBackground(`archive ${task.displayId}`, () => clearAway(task.id))
      return archived
    },

    async block(ref, caller, by) {
      const task = caller.kind === 'run' ? ownTask(ref, caller).task : find(ref)
      await beginning.get(task.id)?.catch(() => undefined)
      const blocker = find(by)
      if (blocker.id === task.id) {
        throw new RequestError(409, `${task.displayId} can’t block itself`)
      }
      if (task.stage === 'done') throw new RequestError(409, `${task.displayId} is done`)
      const cycle = cycleFrom(blocker.id, task.id)
      if (cycle) {
        const ids = [task.id, ...cycle].map((id) => store.getTask(id)?.displayId ?? id)
        throw new RequestError(
          409,
          `${blocker.displayId} can’t block ${task.displayId}: that makes a cycle, ${ids.join(' → ')}`,
        )
      }
      const current = find(task.id)
      const runId = caller.kind === 'run' ? caller.runId : undefined
      const existing = store.blockers(task.id).find((b) => b.blockerId === blocker.id)
      if (existing && (runId === undefined || existing.setByRunId === runId)) {
        return publicTask(task.id)
      }
      const unmerged = blocker.stage !== 'done'
      const queued = store.queue().some((q) => q.id === task.id)
      const midFlow = current.repos.some((r) => !r.removed)
      const then = !unmerged || !queued ? undefined : midFlow ? 'wait' : 'backlog'
      const updated = store.addBlocker(task.id, blocker.id, {
        ...(runId !== undefined && { runId }),
        ...(then !== undefined && { then }),
      })
      const run = liveLead(current)
      if (unmerged && run && caller.kind === 'daemon' && !existing) await tellLead(blocker, run)
      return updated
    },

    unblock(ref, caller, by) {
      const task = caller.kind === 'run' ? ownTask(ref, caller).task : find(ref)
      const links = store.blockers(task.id)
      const blocker = by === undefined ? undefined : find(by)
      if (blocker && !links.some((l) => l.blockerId === blocker.id)) {
        throw new RequestError(404, `${task.displayId} isn’t blocked by ${blocker.displayId}`)
      }
      const wasBlocked = links.some((l) => !l.merged)
      const runId = caller.kind === 'run' ? caller.runId : undefined
      for (const link of links) {
        if (!blocker || link.blockerId === blocker.id) {
          store.removeBlocker(task.id, link.blockerId, runId)
        }
      }
      const current = find(task.id)
      if (caller.kind === 'daemon' && wasBlocked && unmergedBlockers(task.id).length === 0) {
        if (current.stage === 'backlog' && current.startRequested) {
          store.setStartRequested(task.id, false)
        } else if (current.waitsForBlockers && !liveLead(current) && !current.archived) {
          store.stopTask(task.id, { runs: 0, why: 'blockers-removed' })
        }
      }
      return publicTask(task.id)
    },

    slots,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    async comment(ref, caller, { body, choices = [], round, supersedes }) {
      if (caller.kind === 'daemon') {
        if (choices.length > 0) throw new RequestError(400, 'only a Run can ask a question')
        if (round !== undefined) throw new RequestError(403, 'only the Task Lead posts a round')
        if (supersedes !== undefined) {
          throw new RequestError(403, 'only a Run can supersede a request')
        }
        return humanComment(find(ref), body)
      }
      const { task, runId } = ownTask(ref, caller)
      if (store.getRun(runId)?.parentRunId !== undefined) {
        if (choices.length > 0 || round !== undefined || supersedes !== undefined) {
          throw new RequestError(
            403,
            'a sub-agent can post only plain notes; tell the Task Lead what to ask in your final message',
          )
        }
      }
      if (round !== undefined) return postRound(task, runId, round, supersedes)
      if (supersedes === undefined) {
        return store.postComment({
          taskId: task.id,
          body,
          author: { kind: 'run', runId },
          ...(choices.length > 0 && { kind: 'question', choices }),
        })
      }
      const old = store.getComment(supersedes)
      if (!old || old.taskId !== task.id) {
        throw new RequestError(404, `no request ${supersedes} on ${task.displayId}`)
      }
      if (old.kind === 'note') throw new RequestError(400, 'a note isn’t a request')
      if (old.kind === 'round') throw new RequestError(400, 'replace a round with another round')
      if (old.gate) throw new RequestError(409, 'a Gate request can’t be superseded')
      if (!postedBy(old, task, runId)) {
        throw new RequestError(403, 'a Run can supersede only its own requests')
      }
      return holding(task, async () => {
        if (store.getComment(old.id)?.answer) {
          throw new RequestError(409, 'that request has already been answered')
        }
        return store.supersedeComment(old.id, {
          taskId: task.id,
          kind: old.kind,
          body,
          author: { kind: 'run', runId },
          ...(choices.length > 0 && { choices }),
        })
      })
    },

    async setClarifyDepth(ref, caller, { depth, why }) {
      if (caller.kind === 'daemon') {
        const task = find(ref)
        if (task.archived || task.stage === 'done') {
          throw new RequestError(409, `${task.displayId} has finished; its Clarify depth is fixed`)
        }
        const set = store.setClarifyDepth(task.id, { depth, by: 'human' })
        if (liveLead(find(task.id))) {
          await deliver(
            task,
            depth === 'auto'
              ? 'The human set Clarify depth back to Auto. Pick one yourself at Clarify.'
              : `The human set Clarify depth to ${depthNames[depth]}. Use it at Clarify instead of picking one.`,
          )
        }
        return set
      }
      const { task, runId } = ownTask(ref, caller)
      if (task.leadRunId !== runId) {
        throw new RequestError(403, 'only the Task Lead picks the Clarify depth')
      }
      if (task.stage !== 'clarify') {
        throw new RequestError(
          409,
          `pick the Clarify depth at Clarify; ${task.displayId} is in ${stageTitle(task.stage)}`,
        )
      }
      if (depth === 'auto') throw new RequestError(400, 'pick none, few or grilling')
      return store.setClarifyDepth(task.id, {
        depth,
        by: 'task-lead',
        runId,
        ...(why !== undefined && { why }),
      })
    },

    markRead(ref) {
      const task = find(ref)
      const unread = store
        .listComments(task.id)
        .filter((c) => c.author.kind !== 'human' && c.readAt === undefined)
      store.commentsRead(unread.map((c) => c.id))
      return unread.length
    },

    threadEvents(ref) {
      const task = find(ref)
      return threadEvents(task.id, store.taskLog(task.id), {
        comments: store.listComments(task.id),
        displayIdOf: (id) => store.getTask(id)?.displayId ?? id,
        waitingFor: unmergedBlockers(task.id).map((b) => b.displayId),
      })
    },

    writeBrief(ref, caller, text) {
      const { task, runId } = ownTask(ref, caller)
      if (task.leadRunId !== runId) {
        throw new RequestError(403, 'only the Task Lead writes the Task brief')
      }
      if (!hasBriefHeadings(text)) {
        throw new RequestError(
          400,
          `the Task brief needs these headings, in order: ${briefHeadings.join(', ')}`,
        )
      }
      return store.writeBrief({ taskId: task.id, text, runId })
    },

    brief(ref, caller) {
      const task = caller.kind === 'run' ? ownTask(ref, caller).task : find(ref)
      const brief = store.latestBrief(task.id)
      if (!brief) throw new RequestError(404, `${task.displayId} has no Task brief yet`)
      return brief
    },

    inbox() {
      const tasks = new Map(store.listTasks().map((t) => [t.id, t]))
      const rank = (task: Task) => priorities.indexOf(task.priority)
      return store
        .listOpenRequests()
        .flatMap((request) => {
          const task = tasks.get(request.taskId)
          return task && !task.archived ? [{ request, task }] : []
        })
        .sort(
          (a, b) =>
            rank(a.task) - rank(b.task) || a.request.createdAt.localeCompare(b.request.createdAt),
        )
    },

    async answer(id, request) {
      const comment = store.getComment(id)
      if (!comment) throw new RequestError(404, `no Comment ${id}`)
      if (comment.kind === 'note') throw new RequestError(400, 'a note has nothing to answer')
      const task = find(comment.taskId)
      if (comment.kind === 'round') return answerRound(task, comment, request)
      if (request.action === 'answer-round' || request.action === 'accept-recommended') {
        throw new RequestError(400, `a ${comment.kind} request isn’t a round`)
      }
      const text = request.text?.trim() ?? ''
      if (comment.kind === 'permission') return answerPermission(task, comment, request, text)
      if (comment.gate) {
        if (request.action === 'request-changes') {
          if (text === '') throw new RequestError(400, 'Request changes needs your comment')
        } else if (request.action !== 'approve') {
          throw new RequestError(400, 'answer a Gate request with Approve or Request changes')
        }
      } else if (comment.kind !== 'question') {
        throw new RequestError(400, `TED can’t answer a ${comment.kind} request yet`)
      } else if (request.action !== 'answer') {
        throw new RequestError(400, 'answer a question with a choice or your own words')
      } else if (request.choice !== undefined && !comment.choices?.includes(request.choice)) {
        throw new RequestError(400, `“${request.choice}” isn’t one of the question’s choices`)
      } else if (request.choice === undefined && text === '') {
        throw new RequestError(400, 'pick a choice or write an answer')
      }
      if (comment.failed !== undefined && comment.answer === undefined) {
        if (request.action === 'answer' && request.choice === retryChoice) {
          await resumeByHand(task.id, { comment: text })
        } else {
          await humanComment(find(task.id), text)
        }
        return store.getComment(id) ?? comment
      }
      return holding(task, async () => {
        const current = store.getComment(id)
        if (current?.answer?.kind === 'withdrawn') {
          throw new RequestError(409, 'this request was withdrawn')
        }
        if (current?.answer?.kind === 'superseded') {
          throw new RequestError(409, 'this request was replaced by a newer one')
        }
        if (current?.answer) throw new RequestError(409, 'this request has already been answered')
        const at = new Date().toISOString()
        if (request.action === 'request-changes') {
          const answered = answerRequest(task, comment, { kind: 'changes-requested', at, text })
          await deliverAnswer(
            task,
            comment,
            [
              `The human asked for changes at the ${gateName(comment)}:`,
              text,
              comment.stage === 'clarify'
                ? 'The Task stays in Clarify. Ask another round about it with `ted ask --round <file>`. When it’s answered, write the Task brief again with `ted brief write`, then run `ted outcome advance` for a new sign-off.'
                : `The Task stays in ${stageTitle(comment.stage ?? '')}. Make the changes, write the Task brief again with \`ted brief write\`, then run \`ted outcome advance\`.`,
            ].join('\n\n'),
          )
          return answered
        }
        if (request.action === 'approve') {
          const now = find(task.id)
          const resolution = await resolveWorkflow(factoryOf(now))
          const next = resolution.workflow.next(now.stage) as AgentStageId | 'done'
          const answered = answerRequest(task, comment, {
            kind: 'approved',
            at,
            ...(text !== '' && { text }),
          })
          if (!liveLead(now)) store.holdAnswer(comment.id)
          const approved =
            text === ''
              ? `The human approved the ${gateName(comment)}.`
              : `The human approved the ${gateName(comment)} and added:\n\n${text}\n\n`
          await move(
            now,
            resolution,
            next,
            next === 'done'
              ? undefined
              : `${approved}${text === '' ? ' ' : ''}${nextStageMessage(resolution.workflow, next)}`,
          )
          return answered
        }
        const choice = request.choice
        if (isIdleQuestion(comment) && choice === nudgeAgainChoice) {
          const answered = answerRequest(task, comment, { kind: 'answered', at, choice })
          const run = liveLead(find(task.id))
          if (run) await sendNudge(task, run)
          return answered
        }
        const aboutModel = [...asked.values()].includes(comment.id)
        if (aboutModel && choice === useDefaultChoice) await useDefaultModel(task.id)
        const answered = answerRequest(task, comment, {
          kind: 'answered',
          at,
          ...(choice !== undefined && { choice }),
          ...(text !== '' && { text }),
        })
        if (aboutModel) return answered
        await deliverAnswer(
          task,
          comment,
          [
            `The human answered “${comment.title ?? firstLine(comment.body)}”:`,
            ...(choice !== undefined ? [choice] : []),
            ...(text !== '' ? [text] : []),
          ].join('\n\n'),
        )
        return answered
      })
    },

    setActivity(ref, caller, text) {
      const { task, runId } = ownTask(ref, caller)
      return store.setActivity(task.id, text, runId)
    },

    async reportOutcome(ref, caller, outcome) {
      const { task, runId } = ownTask(ref, caller)
      if (task.leadRunId !== runId) {
        throw new RequestError(403, 'only the Task Lead reports outcomes')
      }
      if (task.stage === 'backlog' || task.stage === 'done') {
        throw new RequestError(409, `${task.displayId} isn’t in a Stage that has an outcome`)
      }
      if (checking.has(task.id)) {
        throw new RequestError(
          409,
          `TED is running ${task.displayId}’s Checks; wait for their results before reporting an outcome`,
        )
      }
      return holding(task, async () => {
        const current = find(task.id)
        const stage = current.stage as AgentStageId
        if (outcome.outcome === 'ask') {
          const request = store.postComment({
            taskId: task.id,
            kind: 'question',
            body: outcome.question,
            author: { kind: 'run', runId },
            ...(outcome.choices && outcome.choices.length > 0 && { choices: outcome.choices }),
          })
          return {
            task: publicTask(task.id),
            message: `Asked the human (request ${request.id}). TED sends you their answer.`,
            request,
          }
        }
        const resolution = await resolveWorkflow(factoryOf(current))
        const { workflow } = resolution
        if (outcome.outcome === 'back') return sendBack(current, resolution, stage, outcome)
        const waiting = stage === 'clarify' ? openRound(current) : undefined
        if (waiting) {
          throw new RequestError(
            409,
            `Round ${waiting.round?.number ?? ''} is still waiting on the human; TED sends you their answers`,
          )
        }
        if (outcome.skip === true) {
          if (!skippableStages.includes(stage)) {
            throw new RequestError(
              409,
              `only Clarify and Design can skip themselves; ${stageTitle(stage)} can’t`,
            )
          }
          const since = visitStart(current)
          if (store.listComments(task.id).some((c) => c.gate && c.createdAt >= since)) {
            throw new RequestError(
              409,
              `${stageTitle(stage)} has already posted its Gate request, so it can’t skip itself`,
            )
          }
          store.postComment({
            taskId: task.id,
            body: `The Task Lead skipped ${stageTitle(stage)}: it had nothing to do.${
              workflow.settings.stages[stage]?.gate === true ? ' Its Gate was skipped too.' : ''
            }`,
            author: { kind: 'ted' },
          })
        }
        const gate =
          (workflow.settings.stages[stage]?.gate === true ||
            (stage === 'clarify' && current.clarifyDepth === 'grilling')) &&
          outcome.skip !== true
        if (!gate) {
          const next = workflow.next(stage) as AgentStageId | 'done'
          if (stage === 'validate') pullRequestWork(task.id, 'again')
          const moved = await move(
            current,
            resolution,
            next,
            next === 'done' ? undefined : nextStageMessage(workflow, next),
          )
          return { task: moved, message: `${task.displayId} moved to ${stageTitle(next)}` }
        }
        const name = stage === 'clarify' ? 'Clarify sign-off' : `${stageTitle(stage)} Gate`
        if (openGateRequest(current)) {
          throw new RequestError(409, `${task.displayId} is already waiting at the ${name}`)
        }
        const brief = store.latestBrief(task.id)
        const since = latest(visitStart(current), lastChangesRequested(current))
        if (!brief || brief.createdAt < since) {
          throw new RequestError(
            409,
            `write the Task brief with \`ted brief write\` before passing the ${name}`,
          )
        }
        const request = store.postComment({
          taskId: task.id,
          kind: stage === 'design' ? 'review' : 'signoff',
          title: briefGoal(brief.text) ?? name,
          body: brief.text,
          author: { kind: 'run', runId },
          gate: gateButtons(workflow, stage),
        })
        if (stage === 'validate') pullRequestWork(task.id, 'again')
        if (stage === 'review') pullRequestWork(task.id, 'ready')
        return {
          task: publicTask(task.id),
          message: `Waiting for the human at the ${name}. TED sends you their answer.`,
          request,
        }
      })
    },

    setLead(ref, lead) {
      const task = store.setTaskLead(find(ref).id, lead)
      inBackground('apply the Task Lead setting', () => applyLead(task.id))
      const held = store.heldRuns().find((h) => h.taskId === task.id)
      if (held && held.agent !== lead.agent) void pump()
      return task
    },

    useDefaultModel,

    async setupLog(ref, name) {
      const task = find(ref)
      if (!task.repos.some((r) => r.name === name)) {
        throw new RequestError(404, `${task.displayId} has no worktree for ${name}`)
      }
      return redactSecrets(await readFile(commandLog(task, 'setup', name), 'utf8').catch(() => ''))
    },

    async runChecks(ref, caller, only) {
      const { task } = ownTask(ref, caller)
      if (task.stage === 'backlog' || task.stage === 'done' || task.repos.every((r) => r.removed)) {
        throw new RequestError(409, `${task.displayId} has no worktree to run Checks in`)
      }
      if (checking.has(task.id)) {
        throw new RequestError(409, `TED is already running ${task.displayId}’s Checks`)
      }
      checking.add(task.id)
      try {
        const resolution = await resolveWorkflow(factoryOf(task), { fetch: false })
        const listed = resolution.workflow.settings.stages.validate?.checks ?? []
        if (
          only !== undefined &&
          only !== tedSettingsCheck &&
          !listed.some((c) => c.name === only)
        ) {
          const names = listed.map((c) => c.name).join(', ')
          throw new RequestError(
            404,
            listed.length === 0
              ? 'this Factory has no Checks'
              : `no Check named “${only}”; this Factory’s Checks are ${names}`,
          )
        }
        const started = await beginChecks(find(task.id), resolution, 'agent', only)
        if (!started) {
          throw new RequestError(
            409,
            only === undefined ? 'this Factory has no Checks' : `no Check named “${only}” applies`,
          )
        }
        inBackground(`run ${task.displayId}’s Checks`, () =>
          started.done
            .then(
              () => undefined,
              () => undefined,
            )
            .finally(() => checking.delete(task.id)),
        )
        return started.checkRun
      } catch (error) {
        checking.delete(task.id)
        throw error
      }
    },

    async checkRun(id, caller) {
      const checkRun = store.getCheckRun(id)
      if (!checkRun) throw new RequestError(404, `no Check run ${id}`)
      if (caller.kind === 'run') ownTask(checkRun.taskId, caller)
      return {
        checkRun,
        ...(checkRun.finishedAt !== undefined && { report: await report(checkRun) }),
      }
    },

    async checkOutput(id, position) {
      const checkRun = store.getCheckRun(id)
      const check = checkRun?.checks[position]
      if (!checkRun || !check) throw new RequestError(404, `no Check ${position} in run ${id}`)
      const log = checkLog(find(checkRun.taskId), id, position)
      return { text: await readOutput(log), log }
    },

    wake(factoryId) {
      if (factoryId !== undefined) caps.delete(factoryId)
      void pump()
      for (const task of store.listTasks()) {
        if (task.runs.length > 0) {
          applyLead(task.id).catch((error: unknown) =>
            console.error(`couldn’t apply ${task.displayId}’s Task Lead:`, error),
          )
        }
      }
    },

    startSubAgent: (ref, caller, input) => subAgents.request(ref, caller, input),
    waitForSubAgent: (runId, caller, timeoutMs) => subAgents.wait(runId, caller, timeoutMs),
    sendSubAgent: (runId, caller, text) => subAgents.send(runId, caller, text),
    stopSubAgent: (runId, caller) => subAgents.stop(runId, caller),

    async close() {
      closed = true
      subAgents.close()
      clearInterval(silenceTimer)
      for (const timer of nudgeTimers.values()) clearTimeout(timer)
      nudgeTimers.clear()
      unsubscribe()
      stopPumping()
      await pumping
      stopping.abort()
      await Promise.all(background)
    },
  }
}

const skippableStages: readonly StageId[] = ['clarify', 'design']
const idleTitle = 'The Task Lead stopped without saying why'
const nudgeAgainChoice = 'Nudge again'

function isIdleQuestion(comment: Comment): boolean {
  return (
    comment.author.kind === 'ted' && comment.title === idleTitle && comment.answer === undefined
  )
}
const useDefaultChoice = 'Use the default model'

function latest(a: string, b: string): string {
  return a > b ? a : b
}

function gateName(comment: Comment): string {
  if (comment.stage === 'clarify') return 'Clarify sign-off'
  return `${stageTitle(comment.stage ?? '')} Gate`
}

function gateButtons(workflow: ResolvedWorkflow, stage: StageId): NonNullable<Comment['gate']> {
  if (stage === 'merge') return { approveLabel: 'Merge' }
  if (stage === 'clarify') return { approveLabel: 'Approve', caption: clarifySignoffCaption }
  if (stage !== 'review') return { approveLabel: 'Approve' }
  if (!workflow.stages.includes('merge')) {
    return {
      approveLabel: 'Approve',
      caption: 'Merge is off for this Factory. You’ll merge on GitHub.',
    }
  }
  return { approveLabel: workflow.settings.stages.merge?.gate ? 'Approve' : 'Approve and merge' }
}

const headingLine = /^#{1,6}\s+(.*?)\s*#*\s*$/

function headings(text: string): { title: string; line: number }[] {
  return text.split('\n').flatMap((line, i) => {
    const match = headingLine.exec(line.trim())
    return match?.[1] ? [{ title: match[1].toLowerCase(), line: i }] : []
  })
}

function briefSection(text: string, title: string): string | undefined {
  const lines = text.split('\n')
  const found = headings(text)
  const start = found.find((h) => h.title === title)
  if (!start) return undefined
  const end = found.find((h) => h.line > start.line)?.line ?? lines.length
  return (
    lines
      .slice(start.line + 1, end)
      .join('\n')
      .trim() || undefined
  )
}

function hasBriefHeadings(text: string): boolean {
  let next = 0
  for (const { title } of headings(text)) {
    if (title === briefHeadings[next]?.toLowerCase()) next++
  }
  return next === briefHeadings.length
}

function briefGoal(text: string): string | undefined {
  const lines = text.split('\n')
  const found = headings(text)
  const goal = found.find((h) => h.title === 'goal')
  if (!goal) return undefined
  const end = found.find((h) => h.line > goal.line)?.line ?? lines.length
  return firstLine(lines.slice(goal.line + 1, end).join('\n')) || undefined
}

const continueMessage =
  'TED paused you because your agent couldn’t run (signed out, not installed or too old). It can run again now. Carry on where you left off.'

function permissionMessage(approved: boolean, command: string, text: string): string | undefined {
  if (approved) {
    return text === ''
      ? undefined
      : `The human approved your permission request for \`${oneLine(command)}\` and added:\n\n${text}`
  }
  return text === ''
    ? 'The human denied this request. Don’t retry it; find another way or ask with `ted ask`.'
    : `The human denied this request and said:\n\n${text}`
}

function humanMessage(body: string): string {
  return `The human posted a Comment on this Task:\n\n${body}`
}

function flat(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ')
}

function answerText(comment: Comment): string | undefined {
  const { answer } = comment
  if (!answer) return undefined
  if (answer.kind === 'approved')
    return answer.text === undefined ? 'approved' : `approved, adding: ${answer.text}`
  if (answer.kind === 'changes-requested') return `asked for changes: ${answer.text}`
  if (answer.kind === 'answered' && answer.answers) {
    return roundAnswerSummary(comment, answer.answers)
  }
  if (answer.kind === 'answered') {
    return [answer.choice, answer.text].filter((part) => part !== undefined).join(' · ')
  }
  return undefined
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '') ?? ''
  )
}

function joinIds(ids: readonly string[]): string {
  if (ids.length <= 1) return ids[0] ?? ''
  return `${ids.slice(0, -1).join(', ')} and ${ids.at(-1)}`
}

function oneLine(text: string, max = 200): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function setupFailure(command: string, result: CommandResult, output: string): string {
  const how =
    result.outcome === 'timed-out'
      ? 'it timed out'
      : `it failed${result.exitCode !== undefined ? ` with exit code ${result.exitCode}` : ''}`
  return [
    `# Setup failed\n\nTED ran this worktree’s setup command, \`${command}\`, before starting you, and ${how}. Its output:`,
    `\`\`\`\n${output.trimEnd()}\n\`\`\``,
  ].join('\n\n')
}

function taskSource(url: string, issue: LinearIssue | undefined): TaskSource {
  if (!issue) return { url }
  const { identifier, title, branchName, description } = issue
  return {
    url,
    linear: {
      identifier,
      title,
      ...(branchName !== undefined && { branchName }),
      ...(description !== undefined && { description }),
    },
  }
}

function slug(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (words === '') return ''
  if (words.length <= slugLength) return `-${words}`
  const cut = words.slice(0, slugLength + 1)
  const boundary = cut.lastIndexOf('-')
  return `-${boundary > 0 ? cut.slice(0, boundary) : words.slice(0, slugLength)}`
}
