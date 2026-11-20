import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type {
  AnswerRequest,
  ChatCommandResult,
  Effort,
  Plan,
  PlanDetail,
  PlanFromTask,
  PlanInboxItem,
  PlanRequest,
  PlanStatus,
  PlanTask,
  PlanTaskGone,
  ProposalCreated,
  ProposalInput,
  RoundInput,
  Run,
  RunSlots,
  StartPlanRequest,
} from '@ted/protocol'
import { planRequestLabel, planTitle, planTitleLength } from '@ted/protocol'
import { AgentDisabledError, agentStartHold } from '../agent-eligibility.ts'
import type { Agents } from '../agents/index.ts'
import type { Banners } from '../banners.ts'
import { builtInAgent, chatAgentView, pickAgent, storedAgent } from '../chats/agents.ts'
import { checkOut as checkOutRepos, discard } from '../chats/checkout.ts'
import { type ChatCommands, findCommand } from '../chats/commands.ts'
import { hasPower, requirePower } from '../chats/powers.ts'
import {
  answerable,
  chatTitle,
  planPost,
  proposalRows,
  roundAnswerMessage,
} from '../chats/requests.ts'
import { AnswerSavedError, RequestError } from '../errors.ts'
import { promptGuidance } from '../guidance.ts'
import type { AgentHealthMonitor } from '../health/agent-health.ts'
import type { RunManager } from '../runs/run-manager.ts'
import type { StoredChatAgent } from '../store/chats.ts'
import type { StoredFactory, StoredTask, TedStore } from '../store/index.ts'
import type { StoredPlan } from '../store/plans.ts'
import { approvedShape, createProposalTasks, highestPriority } from '../tasks/proposal-tasks.ts'
import {
  afterProcessEnded,
  automaticResumes,
  queuedRunStatus,
  queuedRuns,
  type RunQueue,
  runLimits,
} from '../tasks/queued-runs.ts'
import { removeInside } from '../tasks/remove-files.ts'
import { type FactoryRepoEntry, factoryRepos } from '../tasks/repos.ts'
import { roundAnswers } from '../tasks/rounds.ts'
import type { Caller, PlanApproval, PlanEnd } from '../tasks/tasks.ts'
import { messageOf } from '../text.ts'
import { resolveAgentChoices } from '../workflow/agent-choices.ts'
import type { Workflows } from '../workflow/workflows.ts'
import {
  earlierPlanContext,
  type PlanTaskContext,
  planApprovedMessage,
  planChangesMessage,
  planCreatedNote,
  plannerInstructions,
  planResumePrompt,
  planRoundNext,
  planToldLeadNote,
  taskDetachedMessage,
  taskDetachedNote,
} from './prompts.ts'

export interface PlansOptions {
  home: string
  store: TedStore
  runs: RunManager
  agents: Agents
  health: AgentHealthMonitor
  banners: Banners
  workflows: Workflows
  queue: RunQueue
  reposDir: string
  builtInAgents: readonly StoredChatAgent[]
  commands: ChatCommands
  isCloned?: (factoryId: string) => boolean
  startTask: (taskId: string) => Promise<unknown>
  planApproved?: (taskId: string, input: PlanApproval) => Promise<void>
  stopLeadForChildren?: (taskId: string) => Promise<void>
  planEnded?: (taskId: string, input: PlanEnd) => Promise<void>
}

export interface Plans {
  list(factory?: string): Promise<Plan[]>
  detail(id: string): Promise<PlanDetail>
  start(input: StartPlanRequest, caller: Caller): Promise<Plan>
  fromTask(input: { taskId: string; sizeCheckId: string; text: string }): Promise<Plan>
  taskGone(taskId: string, reason: PlanTaskGone): void
  rename(id: string, title: string, caller: Caller): Promise<Plan>
  stop(id: string, caller: Caller): Promise<Plan>
  resume(id: string, caller: Caller, message?: string): Promise<Plan>
  archive(id: string, caller: Caller): Promise<Plan>
  unarchive(id: string, caller: Caller): Promise<Plan>
  delete(id: string, caller: Caller): Promise<void>
  removeFactory(factoryId: string): Promise<void>
  inbox(): Promise<PlanInboxItem[]>
  post(
    caller: Caller,
    input: { round?: RoundInput; proposal?: ProposalInput; supersedes?: string },
  ): PlanRequest
  answer(id: string, request: AnswerRequest): Promise<PlanRequest>
  runCommand(caller: Caller, name: string): Promise<ChatCommandResult>
  commandResult(caller: Caller, id: string): Promise<ChatCommandResult>
  isPlanRun(runId: string): boolean
  mayRest(runId: string): boolean
  runEnv(run: Run): Promise<Record<string, string> | undefined>
  close(): void
}

const maxTitleLength = planTitleLength
const maxMessageLength = 100_000

const refuseRun = (caller: Caller) => {
  if (caller.kind !== 'app') throw new RequestError(403, 'Only the human changes planning chats')
}

function firstLine(text: string, max = 500): string {
  const line =
    text
      .split('\n')
      .find((l) => l.trim() !== '')
      ?.trim() ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export function createPlans(options: PlansOptions): Plans {
  const { store, runs, health, banners, workflows } = options
  const planHold = (plan: StoredPlan) =>
    agentStartHold(store, plan.agent, plan.id, {
      factoryId: plan.factoryId,
      model: plan.model,
      agents: options.agents,
      alwaysAuto: true,
    })
  const saved = store.plans
  const retrying = new Set<string>()
  const messageResumes = new Map<string, { count: number; waiting: Set<string> }>()
  const stopping = new Map<string, Promise<void>>()
  let closed = false
  const limits = runLimits({
    store,
    runs,
    health,
    owns: (runId) => saved.get(runId) !== undefined,
    isClosed: () => closed,
    ready: () => pump(),
  })

  const plansDir = path.join(options.home, 'plans')
  const folderOf = (id: string) => path.join(plansDir, id)
  const factoryOf = (plan: StoredPlan) => store.getFactory(plan.factoryId)
  const live = () => saved.list().filter((p) => factoryOf(p) !== undefined)

  function find(id: string): StoredPlan {
    const plan = saved.get(id)
    if (!plan || !factoryOf(plan)) throw new RequestError(404, `no planning chat ${id}`)
    return plan
  }

  function linkedTask(plan: StoredPlan): StoredTask | undefined {
    if (!plan.fromTask || plan.fromTask.gone) return undefined
    const task = store.getTask(plan.fromTask.taskId)
    return task && !task.archived ? task : undefined
  }

  function view(plan: StoredPlan, request: PlanRequest): PlanRequest {
    if (!request.proposal?.firstPiece || linkedTask(plan)) return request
    if (request.answer?.kind === 'approved') return request
    const { firstPiece: _, ...proposal } = request.proposal
    return { ...request, proposal }
  }

  function taskContext(plan: StoredPlan): PlanTaskContext | undefined {
    const task = linkedTask(plan)
    if (!task || !plan.fromTask) return undefined
    const sizeCheck = store.getComment(plan.fromTask.sizeCheckId)
    return {
      displayId: task.displayId,
      title: task.title,
      description: task.description,
      ...(sizeCheck && { why: sizeCheck.body }),
      settle: sizeCheck?.sizeCheck?.settle ?? [],
    }
  }

  function endedWithout(plan: StoredPlan, outcome: PlanEnd['outcome']): void {
    const task = linkedTask(plan)
    if (!task || !options.planEnded) return
    options
      .planEnded(task.id, { planId: plan.id, planTitle: plan.title, outcome })
      .catch((error: unknown) =>
        console.error(`couldn’t tell ${task.displayId} its planning chat ended:`, error),
      )
  }

  function factoryByRef(ref: string): StoredFactory {
    const found = store
      .listFactories()
      .find((f) => f.key.toLowerCase() === ref.toLowerCase() || f.id === ref)
    if (!found) throw new RequestError(404, `no Factory with key ${ref}`)
    return found
  }

  const openRequest = (planId: string) =>
    saved.requests(planId).findLast((r) => r.kind !== 'note' && r.answer === undefined)

  function statusOf(plan: StoredPlan): PlanStatus {
    if (plan.state === 'queued') {
      return store.agentPauses()[plan.agent] !== undefined ? 'paused' : 'queued'
    }
    if (plan.state === 'ended') return plan.outcome ?? 'stopped'
    if (plan.resume === 'queued') return 'queued'
    const run = store.getRun(plan.id)
    const shared = queuedRunStatus(run, { waiting: !!openRequest(plan.id), limits })
    if (shared === 'ended') return 'stopped'
    if (shared !== undefined) return shared
    return run?.state === 'working' ? 'working' : 'idle'
  }

  const { pump } = queuedRuns(options.queue, {
    kind: 'planning',
    what: 'Planning Run',
    waiting: () =>
      live()
        .filter((p) => p.state === 'queued' || (p.state === 'started' && p.resume === 'queued'))
        .map((p) => ({ id: p.id, rank: Date.parse(p.createdAt), factoryId: p.factoryId })),
    runnable(id) {
      const plan = saved.get(id)
      return plan !== undefined && !planHold(plan) && store.agentPauses()[plan.agent] === undefined
    },
    launch: (id) => launch(id),
    candidates: () => live().map((p) => p.id),
    holds(id) {
      const plan = saved.get(id)
      return plan?.state === 'started' && statusOf(plan) === 'working'
    },
    slot(id) {
      const plan = saved.get(id)
      return (
        plan && { runId: plan.id, planId: plan.id, name: plan.title, factoryId: plan.factoryId }
      )
    },
  })

  const agentOf = (plan: Pick<StoredPlan, 'id'>): StoredChatAgent =>
    store.chats.agent(plan.id) ?? builtInAgent(options.builtInAgents, 'planner')

  async function plannerSetup(factory: StoredFactory): Promise<{ entries: FactoryRepoEntry[] }> {
    const { workflow } = await workflows.resolve(factory, { fetch: false })
    return { entries: factoryRepos(workflow, factory) }
  }

  async function prepareFolder(
    plan: StoredPlan,
    factory: StoredFactory,
    entries: readonly FactoryRepoEntry[],
  ): Promise<StoredPlan['checkout']> {
    if (hasPower(agentOf(plan), 'read_code')) return checkOut(plan, factory, entries)
    await mkdir(folderOf(plan.id), { recursive: true, mode: 0o700 })
    return []
  }

  async function agentsNow(factory: StoredFactory) {
    return (await workflows.resolve(factory, { fetch: false }).catch(() => undefined))?.workflow
      .agents
  }

  async function entriesOf(factory: StoredFactory): Promise<FactoryRepoEntry[]> {
    const { workflow } = await workflows.resolve(factory, { fetch: false })
    return factoryRepos(workflow, factory)
  }

  const checkoutDeps = { home: options.home, banners, reposDir: options.reposDir, store }
  const checkOut = (
    plan: StoredPlan,
    factory: StoredFactory,
    entries: readonly FactoryRepoEntry[],
  ) => checkOutRepos(checkoutDeps, folderOf(plan.id), factory, entries)

  const cleaning = new Map<string, Promise<void>>()

  function cleanUp(id: string): void {
    messageResumes.delete(id)
    options.commands.stop(id)
    const plan = saved.get(id)
    const before = cleaning.get(id) ?? Promise.resolve()
    const done = before
      .then(() => discard(plan?.checkout ?? [], folderOf(id), options.home))
      .finally(() => {
        if (cleaning.get(id) === done) cleaning.delete(id)
      })
    cleaning.set(id, done)
  }

  function envFor(plan: StoredPlan, factory: StoredFactory, entries: FactoryRepoEntry[]) {
    return { ...(entries[0]?.env ?? {}), TED_PLAN: plan.id, TED_FACTORY: factory.key }
  }

  async function launch(id: string): Promise<void> {
    const plan = saved.get(id)
    const factory = plan && factoryOf(plan)
    if (!plan || !factory) return
    if (plan.state === 'started' && plan.resume === 'queued') {
      const stillOpen = () => {
        const current = saved.get(id)
        return current?.state === 'started' && current.resume === 'queued'
      }
      try {
        const { entries } = await plannerSetup(factory)
        if (!stillOpen()) return
        const fresh = store.getRun(id)?.sessionId === undefined
        await runs.revive(id, {
          prompt: fresh ? firstPrompt(plan, factory, entries) : planResumePrompt,
          env: envFor(plan, factory, entries),
          fresh,
        })
        if (!stillOpen()) {
          await runs.stop(id).catch((error: unknown) => console.error(error))
          if (saved.get(id)) cleanUp(id)
          return
        }
        saved.revived(id)
      } catch (error) {
        if (!stillOpen()) return
        saved.revived(id)
        fail(id, `Couldn’t resume: ${messageOf(error)}`)
      }
      return
    }
    if (plan.state !== 'queued') return
    let prepared: StoredPlan['checkout'] = []
    try {
      const { entries } = await plannerSetup(factory)
      const checkout = await prepareFolder(plan, factory, entries)
      prepared = checkout
      if (saved.get(id)?.state !== 'queued') {
        await discard(checkout, folderOf(id), options.home)
        return
      }
      const single = entries.length === 1 ? checkout[0]?.worktree : undefined
      await runs.start({
        id,
        agent: plan.agent,
        onStarting: () => saved.began(id, checkout),
        prompt: firstPrompt(plan, factory, entries),
        cwd: single ?? folderOf(id),
        name: agentOf(plan).name,
        permissions: 'auto',
        env: envFor(plan, factory, entries),
        ...(plan.model !== undefined && { model: plan.model }),
        ...(plan.effort !== undefined && { effort: plan.effort }),
      })
      if (saved.get(id)?.state !== 'started') {
        await runs.stop(id).catch((error: unknown) => console.error(error))
        cleanUp(id)
      }
    } catch (error) {
      if (error instanceof AgentDisabledError) {
        await discard(prepared, folderOf(id), options.home)
        return
      }
      const current = saved.get(id)
      if (current?.state === 'queued') saved.began(id, [])
      if (!store.getRun(id)) fail(id, `Couldn’t start: ${messageOf(error)}`)
    }
  }

  function firstPrompt(
    plan: StoredPlan,
    factory: StoredFactory,
    entries: FactoryRepoEntry[],
  ): string {
    const agent = agentOf(plan)
    return `${plannerInstructions({
      role: agent.instructions,
      powers: agent.powers,
      guidance: promptGuidance(store.settings()),
      factory,
      entries,
      folder: folderOf(plan.id),
      ...withTask(plan),
      ...(plan.from && { earlier: plan.from.context }),
      ...(agent.commands && { commands: agent.commands }),
    })}\n\n${plan.message}`
  }

  function withTask(plan: StoredPlan): { task?: PlanTaskContext } {
    const task = taskContext(plan)
    return task ? { task } : {}
  }

  function fail(id: string, error: string): void {
    const plan = saved.get(id)
    if (!plan || plan.state === 'ended') return
    withdrawUnlessResumable(id)
    saved.ended(id, { outcome: 'failed', error: firstLine(error) })
    endedWithout(plan, 'failed')
    cleanUp(id)
  }

  function resumable(plan: StoredPlan): boolean {
    return plan.state === 'ended' && plan.archivedAt === undefined
  }

  function withdrawUnlessResumable(planId: string): void {
    if (store.getRun(planId)?.sessionId === undefined) withdrawOpen(planId)
  }

  function openRequestIds(planId: string): string[] {
    return saved
      .requests(planId)
      .filter((r) => r.kind !== 'note' && r.answer === undefined)
      .map((r) => r.id)
  }

  function withdrawOpen(planId: string): void {
    const at = new Date().toISOString()
    for (const request of saved.requests(planId)) {
      if (request.kind !== 'note' && request.answer === undefined) {
        saved.answerRequest(request.id, { kind: 'withdrawn', at, runStopped: true })
      }
    }
  }

  function resumeForMessage(planId: string, run: Run | undefined): boolean {
    const waiting = store
      .runMessages(planId)
      .filter((m) => m.queued === true)
      .map((m) => m.id)
    const previous = messageResumes.get(planId)
    const count = previous && waiting.some((id) => previous.waiting.has(id)) ? previous.count : 0
    if (waiting.length === 0 || run?.sessionId === undefined || count >= automaticResumes) {
      messageResumes.delete(planId)
      return false
    }
    messageResumes.set(planId, { count: count + 1, waiting: new Set(waiting) })
    return true
  }

  function ended(runId: string, stopped: boolean, lastLines: readonly string[]): void {
    if (closed) return
    limits.clear(runId)
    const plan = saved.get(runId)
    if (plan?.state !== 'started') return
    const run = store.getRun(runId)
    const forMessage = !stopped && resumeForMessage(plan.id, run)
    const next = afterProcessEnded({
      stopped,
      run,
      resumedBefore: plan.resume !== undefined && !forMessage,
      lastLines,
    })
    if ('stopped' in next) {
      withdrawUnlessResumable(plan.id)
      saved.ended(plan.id, { outcome: 'stopped' })
      endedWithout(plan, 'stopped')
      cleanUp(plan.id)
    } else if ('resume' in next) {
      saved.resumeQueued(plan.id, firstLine(next.resume))
      pump()
    } else fail(plan.id, next.fail)
  }

  runs.observe({
    finished(run, { stopped, lastLines }) {
      setImmediate(() => ended(run.id, stopped, lastLines))
    },
  })

  const unsubscribe = store.subscribe((event) => {
    if (closed) return
    if (event.type === 'run-updated' && saved.get(event.run.id)) pump()
  })

  function createdTasks(planId: string): PlanTask[] {
    const links = saved.createdTasks(planId)
    const created = store.tasksIn(new Set(links.map((link) => link.taskId)))
    const tasks = [
      ...created,
      ...store.tasksIn(
        new Set(
          created.flatMap((t) => t.blockedBy).filter((id) => !created.some((t) => t.id === id)),
        ),
      ),
    ]
    return links.flatMap((link): PlanTask[] => {
      const task = created.find((t) => t.id === link.taskId)
      if (!task) return []
      return [
        {
          row: link.row,
          id: task.id,
          displayId: task.displayId,
          title: task.title,
          stage: task.stage,
          blockedBy: task.blockedBy.map((b) => tasks.find((t) => t.id === b)?.displayId ?? b),
        },
      ]
    })
  }

  function describe(
    plan: StoredPlan,
    slots: RunSlots | undefined,
    current?: readonly { id: string }[],
  ): Plan {
    const factory = factoryOf(plan)
    const status = statusOf(plan)
    const place = slots?.queue.find((q) => q.kind === 'planning' && q.planId === plan.id)?.place
    const requests = saved.requests(plan.id)
    const latest = requests.findLast((r) => r.kind === 'proposal')
    const waitingOn = requests.findLast((r) => r.kind !== 'note' && r.answer === undefined)
    const paused =
      planHold(plan) ??
      (status === 'paused' ? (store.agentPauses()[plan.agent] ?? 'usage limit') : undefined)
    return {
      id: plan.id,
      factoryId: plan.factoryId,
      factoryKey: factory?.key ?? '',
      title: plan.title,
      message: plan.message,
      agent: plan.agent,
      ...(plan.model !== undefined && { model: plan.model }),
      ...(plan.effort !== undefined && { effort: plan.effort }),
      status,
      ...(status === 'queued' && place !== undefined && { queuePlace: place }),
      ...(paused !== undefined && { paused }),
      ...(plan.error !== undefined && status === 'failed' && { error: plan.error }),
      createdAt: plan.createdAt,
      ...(plan.startedAt !== undefined && { startedAt: plan.startedAt }),
      ...(plan.finishedAt !== undefined && { finishedAt: plan.finishedAt }),
      ...(plan.archivedAt !== undefined && { archivedAt: plan.archivedAt }),
      lastAt:
        [
          plan.createdAt,
          plan.startedAt,
          plan.finishedAt,
          ...requests.flatMap((r) => [r.createdAt, r.answer?.at]),
          store.lastOutputAt(plan.id),
          ...store.runMessages(plan.id).map((m) => m.at),
        ]
          .filter((at): at is string => at !== undefined && at !== '')
          .sort()
          .at(-1) ?? plan.createdAt,
      ...(store.getRun(plan.id) && { runId: plan.id }),
      ...(latest?.proposal && { proposedTasks: latest.proposal.rows.length }),
      createdTasks: saved.createdTasks(plan.id).length,
      ...(status === 'waiting' && waitingOn && { waitingOn: planRequestLabel(waitingOn) }),
      ...(waitingOn && { openRequest: true as const }),
      ...(resumable(plan) && { canResume: true }),
      ...(plan.from && {
        fromPlan: {
          id: plan.from.planId,
          title: plan.from.title,
          ...(saved.get(plan.from.planId) === undefined && { deleted: true }),
        },
      }),
      ...fromTaskOf(plan),
      chatAgent: chatAgentView(agentOf(plan), current),
    }
  }

  function fromTaskOf(plan: StoredPlan): { fromTask?: PlanFromTask } {
    const link = plan.fromTask
    if (!link) return {}
    const task = store.getTask(link.taskId)
    const gone = link.gone ?? (task ? (task.archived ? 'archived' : undefined) : 'deleted')
    const fromTask: PlanFromTask = {
      id: link.taskId,
      displayId: task?.displayId ?? link.displayId,
      title: task?.title ?? link.title,
      ...(task && { stage: task.stage }),
      ...(task?.status && { status: task.status }),
      ...(task?.activity !== undefined && { activity: task.activity }),
      ...(gone !== undefined && { gone }),
    }
    return { fromTask }
  }

  function startable(factory: StoredFactory): void {
    if (options.isCloned && !options.isCloned(factory.id)) {
      throw new RequestError(409, `${factory.name} is still cloning. Plan once it’s ready.`)
    }
    if (store.newWorkHold() !== undefined) {
      throw new RequestError(507, 'The disk is full, so Ted isn’t starting new Runs')
    }
  }

  async function plannerFor(
    factory: StoredFactory,
    input: Pick<StartPlanRequest, 'agent' | 'model' | 'effort' | 'agentId'>,
  ): Promise<Pick<StoredPlan, 'agent' | 'model' | 'effort'> & { chatAgent: StoredChatAgent }> {
    const resolved = await workflows.resolve(factory, { fetch: false }).catch(() => undefined)
    const settings = resolved?.workflow.settings
    const chatAgent = resolved
      ? storedAgent(pickAgent(resolved.workflow.agents, 'plan', input.agentId))
      : pickAgent(options.builtInAgents, 'plan', input.agentId)
    const planner = resolveAgentChoices(
      settings,
      options.agents.installedKinds(),
      store.settings().enabledAgents,
      store.agentPauses(),
    ).planner
    const defaultAgent = chatAgent.agent ?? planner.agent
    const agent = input.agent ?? defaultAgent
    const same = agent === defaultAgent
    const defaultModel =
      chatAgent.model ?? (chatAgent.agent === undefined ? planner.model : undefined)
    const model = input.model ?? (same ? defaultModel : undefined)
    const effort: Effort | undefined = input.effort ?? (same ? planner.effort : undefined)
    return {
      agent,
      ...(model !== undefined && { model }),
      ...(effort !== undefined && { effort }),
      chatAgent,
    }
  }

  async function slotsNow(): Promise<RunSlots | undefined> {
    return options.queue.slots().catch(() => undefined)
  }

  function ownPlan(caller: Caller): StoredPlan {
    const plan = caller.kind === 'run' ? saved.get(caller.runId) : undefined
    if (!plan || !factoryOf(plan)) {
      throw new RequestError(403, 'only a Planning Run posts here')
    }
    if (plan.state !== 'started') throw new RequestError(409, 'this planning chat has ended')
    return plan
  }

  async function deliver(plan: StoredPlan, text: string): Promise<void> {
    const run = store.getRun(plan.id)
    if (run && resumable(plan)) {
      store.queueRunMessage({ runId: run.id, text, from: 'ted' })
      return
    }
    if (!run || run.state === 'finished' || plan.state !== 'started') {
      throw new RequestError(409, 'this planning chat has stopped, so it can’t get your answer')
    }
    if (store.newWorkHold() !== undefined) {
      throw new RequestError(507, 'The disk is full, so Ted isn’t sending work to Runs')
    }
    await runs.send(run.id, text)
  }

  async function approve(
    plan: StoredPlan,
    request: PlanRequest,
    answer: Extract<AnswerRequest, { action: 'approve' }>,
  ): Promise<PlanRequest> {
    const proposal = view(plan, request).proposal
    if (!proposal) throw new RequestError(409, 'this proposal has no rows')
    const task = proposal.firstPiece ? linkedTask(plan) : undefined
    const { skip, unlinked, shape } = approvedShape(
      proposal,
      answer.proposal?.skip,
      answer.proposal?.unlink,
    )
    const startUnblocked = answer.proposal?.startUnblocked === true
    const text = answer.text?.trim() ?? ''
    const lead = linkedTask(plan)?.lead
    if (task) await options.stopLeadForChildren?.(task.id)
    const parent =
      task ??
      (await store.createTask({
        title: plan.title,
        description: request.body.trim() || plan.title,
        priority: highestPriority(shape.order.map((row) => proposal.rows[row - 1]?.priority)),
        factoryId: plan.factoryId,
        blockedBy: [],
        startRequested: true,
      }))
    const created = await createProposalTasks(store, proposal, shape, {
      parentId: parent.id,
      factoryId: plan.factoryId,
      fields: (row) => ({ ...(lead && { lead }), plan: { planId: plan.id, row } }),
    })
    const outcome: ProposalCreated = {
      tasks: created,
      skipped: skip,
      ...(unlinked.length > 0 && { unlinked }),
      startUnblocked,
    }
    const answered = saved.answerRequest(request.id, {
      kind: 'approved',
      at: new Date().toISOString(),
      ...(text !== '' && { text }),
      created: outcome,
    })
    if (!task) {
      store.childTasksCreated(
        parent.id,
        created.map((c) => c.id),
        'plan',
      )
    }
    saved.postRequest({
      planId: plan.id,
      runId: plan.id,
      kind: 'note',
      author: 'ted',
      body: planCreatedNote(
        created.map((c) => c.displayId),
        parent.displayId,
      ),
    })
    if (task && options.planApproved) {
      await options
        .planApproved(task.id, {
          planId: plan.id,
          planTitle: plan.title,
          created: outcome,
          text,
        })
        .catch((error: unknown) =>
          console.error(`couldn’t make ${task.displayId} wait for its child Tasks:`, error),
        )
      saved.postRequest({
        planId: plan.id,
        runId: plan.id,
        kind: 'note',
        author: 'ted',
        body: planToldLeadNote(task.displayId),
      })
    }
    const run = store.getRun(plan.id)
    if (run && run.state !== 'finished') {
      await runs.send(run.id, planApprovedMessage(created)).catch(() => undefined)
    }
    saved.ended(plan.id, { outcome: 'finished' })
    if (run && run.state !== 'finished') {
      await runs.stop(run.id).catch((error: unknown) => console.error(error))
    }
    cleanUp(plan.id)
    if (startUnblocked) {
      for (const piece of created) {
        if (!shape.unblocked.includes(piece.row)) continue
        await options.startTask(piece.id).catch((error: unknown) => {
          console.error(`couldn’t start ${piece.displayId}:`, error)
        })
      }
    }
    pump()
    return saved.request(answered.id) ?? answered
  }

  for (const plan of saved.list()) {
    if (plan.state === 'ended') {
      if (plan.checkout.length > 0) void discard(plan.checkout, folderOf(plan.id), options.home)
      continue
    }
    if (plan.state !== 'started' || plan.resume === 'queued') continue
    const run = store.getRun(plan.id)
    if (!run) fail(plan.id, 'Ted stopped before this Run started.')
    else if (run.state === 'finished') {
      ended(run.id, run.ended?.how === 'stopped', run.ended?.errorLines ?? [])
    }
  }

  return {
    async list(factory) {
      const inFactory = factory === undefined ? undefined : factoryByRef(factory)
      const slots = await slotsNow()
      return live()
        .filter((p) => !inFactory || p.factoryId === inFactory.id)
        .map((p) => describe(p, slots))
    },
    async detail(id) {
      const plan = find(id)
      const factory = factoryOf(plan)
      const current = factory && (await agentsNow(factory))
      return {
        plan: describe(plan, await slotsNow(), current),
        requests: saved.requests(plan.id).map((r) => view(plan, r)),
        tasks: createdTasks(plan.id),
      }
    },
    async start(input, caller) {
      refuseRun(caller)
      const factory = factoryByRef(input.factory)
      startable(factory)
      const from = input.from === undefined ? undefined : find(input.from)
      if (from && from.factoryId !== factory.id) {
        throw new RequestError(400, 'plan more from a chat in the same Factory')
      }
      if (from && from.state !== 'ended') {
        throw new RequestError(409, 'plan more only from a planning chat that has ended')
      }
      const message = input.message.trim()
      if (message === '') throw new RequestError(400, 'say what you want to plan')
      if (message.length > maxMessageLength) {
        throw new RequestError(400, `the message is limited to ${maxMessageLength} characters`)
      }
      const plan = saved.start({
        factoryId: factory.id,
        title: planTitle(message) || 'Planning chat',
        message,
        ...(await plannerFor(factory, input)),
        ...(from && {
          from: {
            planId: from.id,
            title: from.title,
            context: earlierPlanContext({
              title: from.title,
              message: from.message,
              requests: saved.requests(from.id),
              tasks: createdTasks(from.id),
            }),
          },
        }),
      })
      pump()
      return describe(saved.get(plan.id) ?? plan, await slotsNow())
    },
    async fromTask({ taskId, sizeCheckId, text }) {
      const task = store.getTask(taskId)
      const factory = task && store.getFactory(task.factoryId)
      if (!task || !factory) throw new RequestError(404, `no Task ${taskId}`)
      const open = live().find(
        (p) => p.fromTask?.taskId === taskId && !p.fromTask.gone && p.state !== 'ended',
      )
      if (open) {
        throw new RequestError(409, `${task.displayId} is already being planned in “${open.title}”`)
      }
      startable(factory)
      const message = [`Plan ${task.displayId}: ${task.title}`, text.trim()]
        .filter((part) => part !== '')
        .join('\n\n')
      const plan = saved.start({
        factoryId: factory.id,
        title: [...`Plan: ${task.title}`].slice(0, maxTitleLength).join(''),
        message: message.slice(0, maxMessageLength),
        ...(await plannerFor(factory, {})),
        fromTask: { taskId, displayId: task.displayId, title: task.title, sizeCheckId },
      })
      pump()
      return describe(saved.get(plan.id) ?? plan, await slotsNow())
    },
    taskGone(taskId, reason) {
      for (const plan of live()) {
        if (plan.fromTask?.taskId !== taskId || plan.fromTask.gone || plan.state === 'ended') {
          continue
        }
        const { displayId } = plan.fromTask
        saved.detachTask(plan.id, reason)
        saved.postRequest({
          planId: plan.id,
          runId: plan.id,
          kind: 'note',
          author: 'ted',
          body: taskDetachedNote(displayId, reason),
        })
        const run = store.getRun(plan.id)
        if (run && run.state !== 'finished' && plan.state === 'started') {
          runs
            .send(run.id, taskDetachedMessage(displayId, reason))
            .catch((error: unknown) => console.error(error))
        }
      }
    },
    async rename(id, title, caller) {
      refuseRun(caller)
      const plan = find(id)
      saved.rename(plan.id, chatTitle(title))
      return describe(saved.get(plan.id) ?? plan, await slotsNow())
    },
    async stop(id, caller) {
      refuseRun(caller)
      const plan = find(id)
      if (plan.state === 'ended')
        throw new RequestError(409, 'this planning chat has already ended')
      await halt(plan, 'stopped')
      pump()
      return describe(saved.get(plan.id) ?? plan, await slotsNow())
    },
    resume: (id, caller, message) => {
      refuseRun(caller)
      return resume(find(id), message)
    },
    async archive(id, caller) {
      refuseRun(caller)
      const plan = find(id)
      if (plan.archivedAt !== undefined) return describe(plan, await slotsNow())
      if (retrying.has(plan.id)) throw new RequestError(409, 'this planning chat is resuming')
      if (plan.state !== 'ended') await halt(plan, 'archived')
      await stopping.get(plan.id)
      saved.archive(plan.id, openRequestIds(plan.id))
      pump()
      return describe(saved.get(plan.id) ?? plan, await slotsNow())
    },
    async unarchive(id, caller) {
      refuseRun(caller)
      const plan = find(id)
      if (plan.archivedAt !== undefined) saved.unarchive(plan.id)
      return describe(saved.get(plan.id) ?? plan, await slotsNow())
    },
    async delete(id, caller) {
      refuseRun(caller)
      await remove(find(id), 'keep')
    },
    async removeFactory(factoryId) {
      for (const plan of saved.list().filter((p) => p.factoryId === factoryId)) {
        await remove(plan, 'remove')
      }
    },
    async inbox() {
      const slots = await slotsNow()
      const plansById = new Map(live().map((p) => [p.id, p]))
      return saved.requests().flatMap((request): PlanInboxItem[] => {
        const plan = plansById.get(request.planId)
        if (!plan || request.kind === 'note' || request.answer !== undefined) return []
        return [{ request: view(plan, request), plan: describe(plan, slots) }]
      })
    },
    async runCommand(caller, name) {
      const plan = ownPlan(caller)
      const factory = factoryOf(plan)
      if (!factory) throw new RequestError(404, `no planning chat ${plan.id}`)
      const agent = agentOf(plan)
      findCommand(agent, name)
      return options.commands.run(
        { chatId: plan.id, runId: plan.id, factory, agent, checkout: plan.checkout },
        name,
      )
    },
    async commandResult(caller, id) {
      return options.commands.wait(ownPlan(caller).id, id)
    },
    post(caller, { round, proposal, supersedes }) {
      const plan = ownPlan(caller)
      if ((round === undefined) === (proposal === undefined)) {
        throw new RequestError(400, 'send a round or a proposal')
      }
      requirePower(agentOf(plan), round ? 'ask' : 'propose_tasks')
      const kind = round ? 'round' : 'proposal'
      const task = linkedTask(plan)
      const requests = saved.requests(plan.id)
      const decided = planPost(requests, { kind, ...(supersedes !== undefined && { supersedes }) })
      const posted = round
        ? saved.postRequest({
            planId: plan.id,
            runId: plan.id,
            kind: 'round',
            author: 'run',
            title: round.title,
            body: round.summary ?? '',
            round: {
              number: decided.roundNumber,
              questions: round.questions,
            },
          })
        : saved.postRequest({
            planId: plan.id,
            runId: plan.id,
            kind: 'proposal',
            author: 'run',
            title: proposal?.title ?? '',
            body: proposal?.summary ?? '',
            proposal: {
              ...(task && { firstPiece: { id: task.id, displayId: task.displayId } }),
              rows: proposalRows(
                proposal?.tasks ?? [],
                (factoryOf(plan)?.repos ?? []).map((r) => r.name),
              ),
            },
          })
      if (decided.supersedes !== undefined) {
        saved.answerRequest(decided.supersedes, {
          kind: 'superseded',
          at: posted.createdAt,
          by: posted.id,
        })
      }
      pump()
      return view(plan, posted)
    },
    async answer(id, request) {
      const found = saved.request(id)
      const plan = found && saved.get(found.planId)
      if (!found || !plan || !factoryOf(plan)) throw new RequestError(404, `no request ${id}`)
      if (found.kind === 'note') throw new RequestError(400, 'a note has nothing to answer')
      answerable(found)
      if (plan.archivedAt !== undefined) {
        throw new RequestError(409, 'this planning chat is archived')
      }
      if (plan.state !== 'started' && !resumable(plan)) {
        throw new RequestError(409, 'this planning chat has ended')
      }
      if (found.kind === 'round') {
        const round = found.round
        if (!round) throw new RequestError(409, 'this round has no questions')
        const answers = roundAnswers(round, request)
        await deliver(plan, roundAnswerMessage(found, answers, planRoundNext))
        const answered = saved.answerRequest(id, {
          kind: 'answered',
          at: new Date().toISOString(),
          answers,
        })
        await resumeAfterAnswer(plan)
        return view(plan, answered)
      }
      if (request.action === 'request-changes') {
        const text = request.text.trim()
        if (text === '') throw new RequestError(400, 'Request changes needs your comment')
        await deliver(plan, planChangesMessage(text))
        const answered = saved.answerRequest(id, {
          kind: 'changes-requested',
          at: new Date().toISOString(),
          text,
        })
        await resumeAfterAnswer(plan)
        return view(plan, answered)
      }
      if (request.action !== 'approve') {
        throw new RequestError(400, 'answer a proposal with Create Tasks or Request changes')
      }
      return approve(plan, found, request)
    },
    isPlanRun: (runId) => saved.get(runId) !== undefined,
    mayRest(runId) {
      const plan = saved.get(runId)
      return plan?.state === 'started' && plan.resume !== 'queued'
    },
    async runEnv(run) {
      const plan = saved.get(run.id)
      const factory = plan && factoryOf(plan)
      if (!plan || !factory) return undefined
      return envFor(plan, factory, (await plannerSetup(factory)).entries)
    },
    close() {
      closed = true
      unsubscribe()
      limits.close()
    },
  }

  async function halt(plan: StoredPlan, outcome: 'stopped' | 'archived'): Promise<void> {
    if (outcome === 'stopped') withdrawUnlessResumable(plan.id)
    saved.ended(plan.id, { outcome: 'stopped' })
    endedWithout(plan, outcome)
    const run = store.getRun(plan.id)
    const done = (async () => {
      if (run && run.state !== 'finished') {
        await runs.stop(run.id).catch((error: unknown) => console.error(error))
      }
      cleanUp(plan.id)
    })()
    stopping.set(plan.id, done)
    try {
      await done
    } finally {
      if (stopping.get(plan.id) === done) stopping.delete(plan.id)
    }
  }

  async function resumeAfterAnswer(plan: StoredPlan): Promise<void> {
    if (plan.state !== 'ended' || retrying.has(plan.id)) return
    await resume(plan).catch((error: unknown) => {
      throw new AnswerSavedError(
        `Your answer is saved, but the planner couldn’t resume: ${messageOf(error)}`,
      )
    })
  }

  async function resume(plan: StoredPlan, message?: string): Promise<Plan> {
    if (!resumable(plan)) {
      throw new RequestError(
        409,
        plan.archivedAt !== undefined
          ? 'this planning chat is archived; unarchive it first'
          : 'only a planning chat whose Run ended can be resumed',
      )
    }
    const factory = factoryOf(plan)
    if (!factory) throw new RequestError(404, `no planning chat ${plan.id}`)
    startable(factory)
    const text = message?.trim() ?? ''
    if (text.length > maxMessageLength) {
      throw new RequestError(400, `the message is limited to ${maxMessageLength} characters`)
    }
    const run = store.getRun(plan.id)
    if (!run) {
      if (text !== '') store.queueRunMessage({ runId: plan.id, text })
      saved.retried(plan.id, { fresh: true, checkout: [] })
    } else {
      if (retrying.has(plan.id)) throw new RequestError(409, 'this planning chat is resuming')
      retrying.add(plan.id)
      try {
        await stopping.get(plan.id)
        await cleaning.get(plan.id)
        const checkout = await prepareFolder(plan, factory, await entriesOf(factory)).catch(
          (error: unknown) => {
            throw new RequestError(409, `Couldn’t check out the repos: ${messageOf(error)}`)
          },
        )
        const current = saved.get(plan.id)
        if (!current || !resumable(current)) {
          await discard(checkout, folderOf(plan.id), options.home)
          throw new RequestError(409, 'only a planning chat whose Run ended can be resumed')
        }
        if (text !== '') store.queueRunMessage({ runId: run.id, text })
        saved.retried(plan.id, { fresh: false, checkout })
      } finally {
        retrying.delete(plan.id)
      }
    }
    pump()
    return describe(saved.get(plan.id) ?? plan, await slotsNow())
  }

  async function remove(plan: StoredPlan, output: 'keep' | 'remove'): Promise<void> {
    options.commands.stop(plan.id)
    const run = store.getRun(plan.id)
    if (plan.state !== 'ended') {
      saved.ended(plan.id, { outcome: 'stopped' })
      endedWithout(plan, 'deleted')
    }
    if (run && run.state !== 'finished') {
      await runs.stop(run.id).catch((error: unknown) => console.error(error))
    }
    saved.delete(plan.id)
    await discard(plan.checkout, folderOf(plan.id), options.home)
    if (output === 'remove') {
      await removeInside(path.join(options.home, 'runs'), plan.id).catch((error: unknown) =>
        console.error(`couldn’t remove the Run files of planning chat ${plan.id}:`, error),
      )
    }
    pump()
  }
}
