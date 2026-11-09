import { mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import type {
  AgentStageId,
  AnswerRequest,
  Attachment,
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
  Run,
  RunSlots,
  StageId,
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
import { RequestError } from '../errors.ts'
import { clonePath, ensureClone } from '../factories.ts'
import * as git from '../git.ts'
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
import { placeBetween } from './order.ts'
import { type QueueEntry, type SlotUse, startsNow } from './queue.ts'
import { threadEvents } from './thread.ts'
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
  move(ref: string, request: MoveTaskRequest): Task
  setPriority(ref: string, priority: Priority): Task
  archive(ref: string): Task
  block(ref: string, caller: Caller, by: string): Promise<Task>
  unblock(ref: string, caller: Caller, by?: string): Task
  slots(): Promise<RunSlots>
  subscribe(listener: (event: DaemonEvent) => void): () => void
  comment(
    ref: string,
    caller: Caller,
    input: { body: string; choices?: string[]; supersedes?: string },
  ): Promise<Comment>
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
  wake(factoryId?: string): void
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
  agents: Agents
  health: AgentHealthMonitor
  attachmentFile: (attachment: Attachment) => string
  linear?: Pick<Linear, 'issueFor'>
  isCloned?: (factoryId: string) => boolean
  idle?: IdleTimer
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
  const heldPickUps = new Map<string, string>()
  const interrupted = new Set<string>()
  const advancing = new Set<string>()
  const applying = new Set<string>()
  const asked = new Map<string, string>()
  const stoppingForBlockers = new Set<string>()
  const sendingComments = new Set<string>()
  const background = new Set<Promise<void>>()
  const stopping = new AbortController()
  const holds = new Map<string, number>()
  const beginning = new Map<string, Promise<void>>()
  const settingUp = new Map<string, AbortController>()
  const caps = new Map<string, number | undefined>()
  const listeners = new Set<(event: DaemonEvent) => void>()
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
      const runs = task.runs.filter((r) => r.state === 'working' && r.paused === undefined).length
      const settingUp = task.repos.some((r) => !r.removed && r.setup?.state === 'running')
      const slots = Math.max(runs, settingUp || holds.has(task.id) ? 1 : 0)
      return slots > 0 ? [{ task, runs, settingUp, slots }] : []
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
  const ready = () =>
    runnable(store.queue()).filter((q) => q.factoryId === undefined || cloned(q.factoryId))

  function heldReady(): QueueEntry[] {
    const paused = store.agentPauses()
    return store.heldRuns().flatMap((held) => {
      const task = store.getTask(held.taskId)
      const agent = task?.lead?.agent ?? held.agent
      if (!task || paused[agent] !== undefined || holds.has(task.id)) return []
      if (task.waitsForBlockers) return []
      return [{ id: task.id, kind: 'task' as const, rank: -1, factoryId: task.factoryId }]
    })
  }

  async function fill(): Promise<void> {
    if (store.newWorkHold() !== undefined) return
    const held = heldReady()
    const queued = ready()
    if (queued.length === 0 && held.length === 0) return
    const { use } = await slotUse([...held, ...queued].flatMap((q) => q.factoryId ?? []))
    const heldIds = new Set(held.map((h) => h.id))
    for (const entry of startsNow<QueueEntry>([...held, ...ready()], use)) {
      if (heldIds.has(entry.id)) relaunch(entry.id)
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
    const queue = store.queue().flatMap((entry, i) => {
      const task = byId.get(entry.id)
      return task
        ? [
            {
              kind: 'task' as const,
              place: i + 1,
              taskId: task.id,
              displayId: task.displayId,
              title: task.title,
              factoryId: task.factoryId,
              priority: task.priority,
            },
          ]
        : []
    })
    return {
      limit: use.limit,
      working: use.working,
      queued: queue.length,
      holders: holders.map(({ task, runs, settingUp }) => ({
        kind: 'task' as const,
        taskId: task.id,
        displayId: task.displayId,
        title: task.title,
        factoryId: task.factoryId,
        runs,
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

  const commandEnv = (task: Task, env: Record<string, string>): NodeJS.ProcessEnv => ({
    ...process.env,
    ...env,
    TED_TASK: task.displayId,
  })

  const leadFrom = (settings?: WorkflowSettings) =>
    resolveAgentChoices(settings, {
      claude: agents.installed('claude'),
      codex: agents.installed('codex'),
    }).lead

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
    if (task.leadRunId) await runs.stop(task.leadRunId)
    const factory = factoryOf(task)
    const clone = clonePath(reposDir, factory)
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
    if (find(task.id).archived) return
    const lead = task.lead ?? leadFrom(resolution.workflow.settings)
    const agent = lead.agent
    const note = pickUp ?? (resumeSession === undefined ? heldPickUps.get(task.id) : undefined)
    if (!(await health.ready(agent))) {
      store.holdTaskRun({
        taskId: task.id,
        agent,
        ...(resumeSession !== undefined && { sessionId: resumeSession }),
      })
      if (note !== undefined) heldPickUps.set(task.id, note)
      return
    }
    heldPickUps.delete(task.id)
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
    ].join('\n\n')
    const run = await runs.start({
      agent,
      prompt,
      cwd: repo.worktree,
      taskId: task.id,
      env: { ...env, TED_TASK: task.displayId },
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
  ): Promise<void> {
    const release = hold(task.id)
    try {
      await setUpThenLaunch(task, resolution, repo, setup)
    } finally {
      release()
    }
  }

  async function setUpThenLaunch(
    task: StoredTask,
    resolution: WorkflowResolution,
    repo: TaskRepo,
    setup: RecordedSetup,
  ): Promise<void> {
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
    if (result.outcome === 'interrupted' || find(task.id).archived) return
    store.worktreeSetupFinished(task.id, repo.name, {
      outcome: result.outcome,
      ...(result.exitCode !== undefined && { exitCode: result.exitCode }),
    })
    const report =
      result.outcome === 'passed'
        ? undefined
        : setupFailure(setup.command, result, await outputTail(log))
    await launch(find(task.id), resolution, repo, setup.env, report)
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
    if (!repo || task.archived || task.stage === 'backlog' || task.stage === 'done') {
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

  async function move(
    task: StoredTask,
    resolution: WorkflowResolution,
    next: AgentStageId | 'done',
    message: string | undefined,
  ): Promise<Task> {
    const moved = store.changeStage(task.id, next, entryFor(resolution, next))
    if (next === 'done') {
      inBackground(`finish ${task.displayId}`, () => finish(task, resolution))
    } else if (message !== undefined) {
      await deliver(task, message)
    }
    return moved
  }

  function postedBy(request: Comment, task: StoredTask, runId: string): boolean {
    const { author } = request
    if (author.kind !== 'run') return false
    if (author.runId === runId) return true
    return task.leadRunId === runId && store.getRun(author.runId)?.taskId === task.id
  }

  function answerRequest(task: Task, comment: Comment, answer: CommentAnswer): Comment {
    const answered = store.answerComment(comment.id, answer)
    if (comment.stage !== undefined) store.resetSendBacks(task.id, comment.stage)
    return answered
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
    store.recordSendBack({ taskId: task.id, from, to, findings, counted })
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
      const env =
        store.recordedSetup(task.id, repo.name)?.env ??
        primaryRepoWorktree(resolution.workflow, factory).env
      await launch(find(task.id), resolution, repo, env, undefined, { pickUp: pickUpNote(task) })
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

  function pickUpNote(task: StoredTask): string {
    const merged = store
      .blockers(task.id)
      .filter((b) => b.merged)
      .map((b) => b.displayId)
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
      '# Picking up after a blocker',
      `This Task waited for ${joinIds(merged)}, which ${merged.length === 1 ? 'has' : 'have'} merged. An earlier Run worked on it in this worktree and stopped to wait. Read the Task brief, the Comments since and the branch’s commits to see where it stopped, then carry on with this Stage.`,
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
      if (task.archived) continue
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
    const task = store.getTask(run.taskId)
    if (!task || task.leadRunId !== run.id || task.stage === 'backlog' || task.stage === 'done') {
      return
    }
    const [checked] = await health.check([run.agent])
    if (checked?.state === 'ready') return
    const now = store.getTask(task.id)
    if (!now || now.leadRunId !== run.id || now.stage === 'done' || now.waitsForBlockers) return
    store.holdTaskRun({
      taskId: task.id,
      agent: run.agent,
      ...(run.sessionId !== undefined && { sessionId: run.sessionId }),
    })
  }

  runs.observe({
    authFailed(run) {
      if (run.state !== 'finished') interrupted.add(run.id)
      health.authFailed(run.agent)
    },
    accepted: markAccepted,
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

    archive(ref) {
      const task = live(ref)
      const archived = store.archiveTask(task.id)
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
          store.requeueAfterBlockers(task.id)
        }
      }
      return publicTask(task.id)
    },

    slots,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    async comment(ref, caller, { body, choices = [], supersedes }) {
      if (caller.kind === 'daemon') {
        if (choices.length > 0) throw new RequestError(400, 'only a Run can ask a question')
        if (supersedes !== undefined) {
          throw new RequestError(403, 'only a Run can supersede a request')
        }
        return humanComment(find(ref), body)
      }
      const { task, runId } = ownTask(ref, caller)
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
      const text = request.text?.trim() ?? ''
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
              `The Task stays in ${stageTitle(comment.stage ?? '')}. Make the changes, write the Task brief again with \`ted brief write\`, then run \`ted outcome advance\`.`,
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
          if (text !== '' && !liveLead(now)) store.holdAnswer(comment.id)
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
        const gate = workflow.settings.stages[stage]?.gate === true && outcome.skip !== true
        if (!gate) {
          const next = workflow.next(stage) as AgentStageId | 'done'
          const moved = await move(
            current,
            resolution,
            next,
            next === 'done' ? undefined : nextStageMessage(workflow, next),
          )
          return { task: moved, message: `${task.displayId} moved to ${stageTitle(next)}` }
        }
        const name = `${stageTitle(stage)} Gate`
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

    async close() {
      closed = true
      unsubscribe()
      stopPumping()
      await pumping
      stopping.abort()
      await Promise.all(background)
    },
  }
}

const skippableStages: readonly StageId[] = ['clarify', 'design']
const useDefaultChoice = 'Use the default model'

function latest(a: string, b: string): string {
  return a > b ? a : b
}

function gateName(comment: Comment): string {
  return `${stageTitle(comment.stage ?? '')} Gate`
}

function gateButtons(workflow: ResolvedWorkflow, stage: StageId): NonNullable<Comment['gate']> {
  if (stage === 'merge') return { approveLabel: 'Merge' }
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
    return answer.text === undefined ? undefined : `approved, adding: ${answer.text}`
  if (answer.kind === 'changes-requested') return `asked for changes: ${answer.text}`
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

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > 200 ? `${line.slice(0, 199)}…` : line
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
