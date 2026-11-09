import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import type {
  AnswerRequest,
  Effort,
  Plan,
  PlanDetail,
  PlanInboxItem,
  PlanRequest,
  PlanStatus,
  PlanTask,
  ProposalCreated,
  ProposalInput,
  QueuedForSlot,
  RoundInput,
  RunSlots,
  SlotHolder,
  StartPlanRequest,
} from '@ted/protocol'
import { planProposal, planTitle } from '@ted/protocol'
import type { Agents } from '../agents/index.ts'
import type { Banners } from '../banners.ts'
import { RequestError } from '../errors.ts'
import { ensureClone } from '../factories.ts'
import * as git from '../git.ts'
import type { AgentHealthMonitor } from '../health/agent-health.ts'
import type { RunManager } from '../runs/run-manager.ts'
import type { StoredFactory, TedStore } from '../store/index.ts'
import type { PlanCheckout, StoredPlan } from '../store/plans.ts'
import type { QueueEntry, QueueSource } from '../tasks/queue.ts'
import { type FactoryRepoEntry, factoryRepos } from '../tasks/repos.ts'
import { roundAnswers } from '../tasks/rounds.ts'
import type { Caller } from '../tasks/tasks.ts'
import { copyFiles } from '../tasks/worktree.ts'
import { resolveAgentChoices } from '../workflow/agent-choices.ts'
import type { Workflows } from '../workflow/workflows.ts'
import {
  planApprovedMessage,
  planChangesMessage,
  planCreatedNote,
  plannerInstructions,
  planResumePrompt,
  planRoundAnswerMessage,
} from './prompts.ts'

export interface PlanQueue {
  addQueueSource(source: QueueSource): () => void
  slots(): Promise<RunSlots>
}

export interface PlansOptions {
  home: string
  store: TedStore
  runs: RunManager
  agents: Agents
  health: AgentHealthMonitor
  banners: Banners
  workflows: Workflows
  queue: PlanQueue
  reposDir: string
  isCloned?: (factoryId: string) => boolean
  startTask: (taskId: string) => Promise<unknown>
}

export interface Plans {
  list(factory?: string): Promise<Plan[]>
  detail(id: string): Promise<PlanDetail>
  start(input: StartPlanRequest, caller: Caller): Promise<Plan>
  rename(id: string, title: string, caller: Caller): Promise<Plan>
  stop(id: string, caller: Caller): Promise<Plan>
  delete(id: string, caller: Caller): Promise<void>
  removeFactory(factoryId: string): Promise<void>
  inbox(): Promise<PlanInboxItem[]>
  post(
    caller: Caller,
    input: { round?: RoundInput; proposal?: ProposalInput; supersedes?: string },
  ): PlanRequest
  answer(id: string, request: AnswerRequest): Promise<PlanRequest>
  isPlanRun(runId: string): boolean
  close(): void
}

const maxTitleLength = 200
const maxMessageLength = 100_000

const refuseRun = (caller: Caller) => {
  if (caller.kind !== 'app') throw new RequestError(403, 'Only the human changes planning chats')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
  const saved = store.plans
  const starting = new Set<string>()
  const limited = new Set<string>()
  let closed = false

  const plansDir = path.join(options.home, 'plans')
  const folderOf = (id: string) => path.join(plansDir, id)
  const factoryOf = (plan: StoredPlan) => store.getFactory(plan.factoryId)
  const live = () => saved.list().filter((p) => factoryOf(p) !== undefined)

  function find(id: string): StoredPlan {
    const plan = saved.get(id)
    if (!plan || !factoryOf(plan)) throw new RequestError(404, `no planning chat ${id}`)
    return plan
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
    if (!run) return 'queued'
    if (run.state === 'finished') return 'stopped'
    if (openRequest(plan.id) || run.state === 'waiting') return 'waiting'
    if (limited.has(run.id) || store.agentPauses()[run.agent] !== undefined) return 'paused'
    return run.state === 'working' ? 'working' : 'idle'
  }

  const queuedPlans = () =>
    live().filter(
      (p) =>
        !starting.has(p.id) &&
        (p.state === 'queued' || (p.state === 'started' && p.resume === 'queued')),
    )

  const source: QueueSource = {
    queued: () =>
      queuedPlans().map(
        (p): QueueEntry => ({
          id: p.id,
          kind: 'planning',
          rank: Date.parse(p.createdAt),
          factoryId: p.factoryId,
        }),
      ),
    runnable(id) {
      const plan = saved.get(id)
      return plan !== undefined && store.agentPauses()[plan.agent] === undefined
    },
    begin(id) {
      if (starting.has(id)) return
      starting.add(id)
      launch(id)
        .catch((error: unknown) => console.error(`couldn’t start Planning Run ${id}:`, error))
        .finally(() => {
          starting.delete(id)
          pump()
        })
    },
    holders() {
      return live().flatMap((plan): SlotHolder[] => {
        const holds =
          starting.has(plan.id) || (plan.state === 'started' && statusOf(plan) === 'working')
        return holds
          ? [
              {
                kind: 'planning',
                runId: plan.id,
                planId: plan.id,
                name: plan.title,
                factoryId: plan.factoryId,
                runs: 1,
              },
            ]
          : []
      })
    },
    describe(id, place): QueuedForSlot | undefined {
      const plan = saved.get(id)
      if (!plan) return undefined
      return {
        kind: 'planning',
        place,
        runId: plan.id,
        planId: plan.id,
        name: plan.title,
        factoryId: plan.factoryId,
      }
    },
  }

  const pump = options.queue.addQueueSource(source)

  async function entriesOf(factory: StoredFactory): Promise<FactoryRepoEntry[]> {
    const { workflow } = await workflows.resolve(factory, { fetch: false })
    return factoryRepos(workflow, factory)
  }

  async function checkOut(
    plan: StoredPlan,
    factory: StoredFactory,
    entries: readonly FactoryRepoEntry[],
  ): Promise<PlanCheckout[]> {
    const folder = folderOf(plan.id)
    await rm(folder, { recursive: true, force: true })
    await mkdir(folder, { recursive: true, mode: 0o700 })
    const made: PlanCheckout[] = []
    try {
      for (const entry of entries) {
        const clone = await ensureClone(
          { banners, reposDir: options.reposDir },
          entry.primary ? factory : { ...factory, repo: entry.repo, cloneUrl: entry.cloneUrl },
        )
        await git.fetch(clone)
        const base = entry.baseBranch ?? (await git.defaultBranch(clone))
        const worktree = path.join(folder, entry.name)
        await git.addScratchWorktree(clone, worktree, `origin/${base}`)
        made.push({ clone, worktree })
        await copyFiles(store.localFolder(entry.repo), worktree, entry.copy)
      }
    } catch (error) {
      await discard(made, folder)
      throw error
    }
    return made
  }

  async function discard(checkout: readonly PlanCheckout[], folder: string): Promise<void> {
    for (const { clone, worktree } of checkout) {
      await git.removeWorktree(clone, worktree).catch(() => undefined)
    }
    await rm(folder, { recursive: true, force: true }).catch((error: unknown) =>
      console.error(`couldn’t remove ${folder}:`, error),
    )
  }

  function cleanUp(id: string): void {
    const plan = saved.get(id)
    void discard(plan?.checkout ?? [], folderOf(id))
  }

  function envFor(plan: StoredPlan, factory: StoredFactory, entries: FactoryRepoEntry[]) {
    return { ...(entries[0]?.env ?? {}), TED_PLAN: plan.id, TED_FACTORY: factory.key }
  }

  async function launch(id: string): Promise<void> {
    const plan = saved.get(id)
    const factory = plan && factoryOf(plan)
    if (!plan || !factory) return
    if (plan.state === 'started' && plan.resume === 'queued') {
      try {
        const entries = await entriesOf(factory)
        await runs.revive(id, {
          prompt: planResumePrompt,
          env: envFor(plan, factory, entries),
        })
        saved.revived(id)
      } catch (error) {
        saved.revived(id)
        fail(id, `Couldn’t resume: ${messageOf(error)}`)
      }
      return
    }
    if (plan.state !== 'queued') return
    try {
      const entries = await entriesOf(factory)
      const checkout = await checkOut(plan, factory, entries)
      if (saved.get(id)?.state !== 'queued') {
        await discard(checkout, folderOf(id))
        return
      }
      saved.began(id, checkout)
      const single = entries.length === 1 ? checkout[0]?.worktree : undefined
      await runs.start({
        id,
        agent: plan.agent,
        prompt: `${plannerInstructions({ factory, entries, folder: folderOf(id) })}\n\n${plan.message}`,
        cwd: single ?? folderOf(id),
        name: 'Planner',
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
      const current = saved.get(id)
      if (current?.state === 'queued') saved.began(id, [])
      if (!store.getRun(id)) fail(id, `Couldn’t start: ${messageOf(error)}`)
    }
  }

  function fail(id: string, error: string): void {
    const plan = saved.get(id)
    if (!plan || plan.state === 'ended') return
    withdrawOpen(id)
    saved.ended(id, { outcome: 'failed', error: firstLine(error) })
    cleanUp(id)
  }

  function withdrawOpen(planId: string): void {
    const at = new Date().toISOString()
    for (const request of saved.requests(planId)) {
      if (request.kind !== 'note' && request.answer === undefined) {
        saved.answerRequest(request.id, { kind: 'withdrawn', at, runStopped: true })
      }
    }
  }

  function ended(runId: string, stopped: boolean, lastLines: readonly string[]): void {
    if (closed) return
    limited.delete(runId)
    const plan = saved.get(runId)
    if (plan?.state !== 'started') return
    if (stopped) {
      withdrawOpen(plan.id)
      saved.ended(plan.id, { outcome: 'stopped' })
      cleanUp(plan.id)
      return
    }
    const error =
      lastLines.findLast((l) => l.trim() !== '') ??
      'The agent’s process ended before it finished its turn.'
    const run = store.getRun(runId)
    if (plan.resume === undefined && run?.sessionId !== undefined) {
      saved.resumeQueued(plan.id, firstLine(error))
      pump()
      return
    }
    fail(plan.id, error)
  }

  runs.observe({
    usage(run, signal) {
      if (!closed && signal.limited && saved.get(run.id)) limited.add(run.id)
    },
    authFailed(run) {
      if (!closed && saved.get(run.id)) limited.add(run.id)
    },
    finished(run, { stopped, lastLines }) {
      setImmediate(() => ended(run.id, stopped, lastLines))
    },
  })

  health.onReady(() => {
    if (closed) return
    for (const runId of [...limited]) {
      const run = store.getRun(runId)
      if (!run || store.agentPauses()[run.agent] === undefined) limited.delete(runId)
    }
    pump()
  })

  const unsubscribe = store.subscribe((event) => {
    if (closed) return
    if (event.type === 'run-updated' && saved.get(event.run.id)) {
      if (event.run.state === 'working') limited.delete(event.run.id)
      pump()
    }
  })

  function createdTasks(planId: string): PlanTask[] {
    const tasks = store.listTasks()
    return saved.createdTasks(planId).flatMap((link): PlanTask[] => {
      const task = tasks.find((t) => t.id === link.taskId)
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

  function describe(plan: StoredPlan, slots: RunSlots | undefined): Plan {
    const factory = factoryOf(plan)
    const status = statusOf(plan)
    const place = slots?.queue.find((q) => q.kind === 'planning' && q.planId === plan.id)?.place
    const latest = saved.requests(plan.id).findLast((r) => r.kind === 'proposal')
    const paused =
      status === 'paused' ? (store.agentPauses()[plan.agent] ?? 'usage limit') : undefined
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
      ...(store.getRun(plan.id) && { runId: plan.id }),
      ...(latest?.proposal && { proposedTasks: latest.proposal.rows.length }),
      createdTasks: saved.createdTasks(plan.id).length,
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
    if (!run || run.state === 'finished' || plan.state !== 'started') {
      throw new RequestError(409, 'this planning chat has stopped, so it can’t get your answer')
    }
    await runs.send(run.id, text)
  }

  async function approve(
    plan: StoredPlan,
    request: PlanRequest,
    answer: Extract<AnswerRequest, { action: 'approve' }>,
  ): Promise<PlanRequest> {
    const proposal = request.proposal
    if (!proposal) throw new RequestError(409, 'this proposal has no rows')
    const skip = [...(answer.proposal?.skip ?? [])].sort((a, b) => a - b)
    const outside = skip.find((row) => row < 1 || row > proposal.rows.length)
    if (outside !== undefined) throw new RequestError(400, `the proposal has no row ${outside}`)
    const shape = planProposal(proposal, skip)
    if (shape.creates === 0) throw new RequestError(400, 'check at least one row to create')
    const startUnblocked = answer.proposal?.startUnblocked === true
    const text = answer.text?.trim() ?? ''
    const ids = new Map<number, string>()
    const created: ProposalCreated['tasks'] = []
    for (const row of shape.order) {
      const planned = shape.rows[row - 1]
      const piece = proposal.rows[row - 1]
      if (!planned || !piece) continue
      const blockedBy = planned.blockedBy.flatMap((b) => {
        const id = ids.get(b)
        return id === undefined ? [] : [id]
      })
      const made = await store.createTask({
        title: piece.title,
        description: piece.description ?? piece.scope,
        priority: piece.priority,
        factoryId: plan.factoryId,
        blockedBy,
        startRequested: blockedBy.length > 0,
        plan: { planId: plan.id, row },
      })
      ids.set(row, made.id)
      created.push({ row, id: made.id, displayId: made.displayId })
    }
    created.sort((a, b) => a.row - b.row)
    const outcome: ProposalCreated = { tasks: created, skipped: skip, startUnblocked }
    const answered = saved.answerRequest(request.id, {
      kind: 'approved',
      at: new Date().toISOString(),
      ...(text !== '' && { text }),
      created: outcome,
    })
    saved.postRequest({
      planId: plan.id,
      runId: plan.id,
      kind: 'note',
      author: 'ted',
      body: planCreatedNote(created.map((c) => c.displayId)),
    })
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
      if (plan.checkout.length > 0) void discard(plan.checkout, folderOf(plan.id))
      continue
    }
    if (plan.state !== 'started' || plan.resume === 'queued') continue
    const run = store.getRun(plan.id)
    if (!run) fail(plan.id, 'TED stopped before this Run started.')
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
      return {
        plan: describe(plan, await slotsNow()),
        requests: saved.requests(plan.id),
        tasks: createdTasks(plan.id),
      }
    },
    async start(input, caller) {
      refuseRun(caller)
      const factory = factoryByRef(input.factory)
      if (options.isCloned && !options.isCloned(factory.id)) {
        throw new RequestError(409, `${factory.name} is still cloning. Plan once it’s ready.`)
      }
      if (store.newWorkHold() !== undefined) {
        throw new RequestError(507, 'The disk is full, so TED isn’t starting new Runs')
      }
      const message = input.message.trim()
      if (message === '') throw new RequestError(400, 'say what you want to plan')
      if (message.length > maxMessageLength) {
        throw new RequestError(400, `the message is limited to ${maxMessageLength} characters`)
      }
      const settings = (await workflows.resolve(factory, { fetch: false }).catch(() => undefined))
        ?.workflow.settings
      const planner = resolveAgentChoices(settings, {
        claude: options.agents.installed('claude'),
        codex: options.agents.installed('codex'),
      }).planner
      const agent = input.agent ?? planner.agent
      const same = agent === planner.agent
      const model = input.model ?? (same ? planner.model : undefined)
      const effort: Effort | undefined = input.effort ?? (same ? planner.effort : undefined)
      const plan = saved.start({
        factoryId: factory.id,
        title: planTitle(message) || 'Planning chat',
        message,
        agent,
        ...(model !== undefined && { model }),
        ...(effort !== undefined && { effort }),
      })
      pump()
      return describe(saved.get(plan.id) ?? plan, await slotsNow())
    },
    async rename(id, title, caller) {
      refuseRun(caller)
      const plan = find(id)
      const name = title.trim().replace(/\s+/g, ' ')
      if (name === '') throw new RequestError(400, 'a planning chat needs a title')
      if ([...name].length > maxTitleLength) {
        throw new RequestError(400, `titles are at most ${maxTitleLength} characters`)
      }
      saved.rename(plan.id, name)
      return describe(saved.get(plan.id) ?? plan, await slotsNow())
    },
    async stop(id, caller) {
      refuseRun(caller)
      const plan = find(id)
      if (plan.state === 'ended')
        throw new RequestError(409, 'this planning chat has already ended')
      withdrawOpen(plan.id)
      saved.ended(plan.id, { outcome: 'stopped' })
      const run = store.getRun(plan.id)
      if (run && run.state !== 'finished') {
        await runs.stop(run.id).catch((error: unknown) => console.error(error))
      }
      cleanUp(plan.id)
      pump()
      return describe(saved.get(plan.id) ?? plan, await slotsNow())
    },
    async delete(id, caller) {
      refuseRun(caller)
      await remove(find(id))
    },
    async removeFactory(factoryId) {
      for (const plan of saved.list().filter((p) => p.factoryId === factoryId)) {
        await remove(plan)
      }
    },
    async inbox() {
      const slots = await slotsNow()
      const plansById = new Map(live().map((p) => [p.id, p]))
      return saved.requests().flatMap((request): PlanInboxItem[] => {
        const plan = plansById.get(request.planId)
        if (!plan || request.kind === 'note' || request.answer !== undefined) return []
        return [{ request, plan: describe(plan, slots) }]
      })
    },
    post(caller, { round, proposal, supersedes }) {
      const plan = ownPlan(caller)
      if ((round === undefined) === (proposal === undefined)) {
        throw new RequestError(400, 'send a round or a proposal')
      }
      const kind = round ? 'round' : 'proposal'
      const requests = saved.requests(plan.id)
      if (supersedes !== undefined) {
        const old = requests.find((r) => r.id === supersedes)
        if (!old) throw new RequestError(404, `no request ${supersedes} in this planning chat`)
        if (old.kind !== kind) throw new RequestError(400, `a ${kind} can replace only a ${kind}`)
        if (old.answer) throw new RequestError(409, 'that request has already been answered')
      }
      const open = requests.findLast((r) => r.kind !== 'note' && r.answer === undefined)
      if (open && open.id !== supersedes && open.kind !== kind) {
        throw new RequestError(
          409,
          `your ${open.kind} is still waiting on the human; wait for their answer first`,
        )
      }
      if (open && open.id !== supersedes && kind === 'round') {
        throw new RequestError(
          409,
          `Round ${open.round?.number ?? ''} is still waiting on the human; if it’s out of date, replace it with \`ted ask --supersedes ${open.id} --round <file>\``,
        )
      }
      const posted = round
        ? saved.postRequest({
            planId: plan.id,
            runId: plan.id,
            kind: 'round',
            author: 'run',
            title: round.title,
            body: round.summary ?? '',
            round: {
              number:
                requests.filter((r) => r.kind === 'round' && r.answer?.kind !== 'superseded')
                  .length + (supersedes === undefined ? 1 : 0),
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
              rows: (proposal?.tasks ?? []).map((row) => ({
                title: row.title,
                scope: row.scope,
                ...(row.description !== undefined && { description: row.description }),
                priority: row.priority ?? 'none',
                blockedBy: row.blockedBy ?? [],
              })),
            },
          })
      const replaced = supersedes ?? (open && open.kind === 'proposal' ? open.id : undefined)
      if (replaced !== undefined) {
        saved.answerRequest(replaced, {
          kind: 'superseded',
          at: posted.createdAt,
          by: posted.id,
        })
      }
      pump()
      return posted
    },
    async answer(id, request) {
      const found = saved.request(id)
      const plan = found && saved.get(found.planId)
      if (!found || !plan || !factoryOf(plan)) throw new RequestError(404, `no request ${id}`)
      if (found.kind === 'note') throw new RequestError(400, 'a note has nothing to answer')
      if (found.answer?.kind === 'superseded') {
        throw new RequestError(409, 'this request was replaced by a newer one')
      }
      if (found.answer) throw new RequestError(409, 'this request has already been answered')
      if (plan.state !== 'started') {
        throw new RequestError(409, 'this planning chat has ended')
      }
      if (found.kind === 'round') {
        const round = found.round
        if (!round) throw new RequestError(409, 'this round has no questions')
        const answers = roundAnswers(round, request)
        await deliver(plan, planRoundAnswerMessage(found, answers))
        return saved.answerRequest(id, {
          kind: 'answered',
          at: new Date().toISOString(),
          answers,
        })
      }
      if (request.action === 'request-changes') {
        const text = request.text.trim()
        if (text === '') throw new RequestError(400, 'Request changes needs your comment')
        await deliver(plan, planChangesMessage(text))
        return saved.answerRequest(id, {
          kind: 'changes-requested',
          at: new Date().toISOString(),
          text,
        })
      }
      if (request.action !== 'approve') {
        throw new RequestError(400, 'answer a proposal with Create Tasks or Request changes')
      }
      return approve(plan, found, request)
    },
    isPlanRun: (runId) => saved.get(runId) !== undefined,
    close() {
      closed = true
      unsubscribe()
    },
  }

  async function remove(plan: StoredPlan): Promise<void> {
    const run = store.getRun(plan.id)
    if (plan.state !== 'ended') saved.ended(plan.id, { outcome: 'stopped' })
    saved.delete(plan.id)
    if (run && run.state !== 'finished') {
      await runs.stop(run.id).catch((error: unknown) => console.error(error))
    }
    await discard(plan.checkout, folderOf(plan.id))
    pump()
  }
}
