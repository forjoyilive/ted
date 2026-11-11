import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type {
  AgentKind,
  Effort,
  PermissionMode,
  Run,
  StartSubAgentRequest,
  SubAgent,
  SubAgentState,
  SubAgentWait,
  TaskLead,
  TaskRepo,
} from '@ted/protocol'
import type { Agents } from '../agents/index.ts'
import { RequestError } from '../errors.ts'
import * as git from '../git.ts'
import type { RunManager } from '../runs/run-manager.ts'
import type { ReviewerPurpose, StoredTask, SubAgentRequest, TedStore } from '../store/index.ts'
import { stageTitle, subAgentPrompt, tedSubAgentPrompt } from '../workflow/workflow.ts'
import type { QueueEntry } from './queue.ts'
import type { Caller } from './tasks.ts'

export interface SubAgents {
  request(ref: string, caller: Caller, input: StartSubAgentRequest): Promise<SubAgent>
  requestForTed(
    task: StoredTask,
    input: { name: string; prompt: string; choice: ReviewerChoice; purpose: ReviewerPurpose },
  ): string | undefined
  result(runId: string): Promise<SubAgentWait>
  queued(): QueueEntry[]
  begin(id: string): void
  starting(taskId: string): number
  startingTasks(): string[]
  wait(runId: string, caller: Caller, timeoutMs: number): Promise<SubAgentWait>
  send(runId: string, caller: Caller, text: string): Promise<SubAgent>
  stop(runId: string, caller: Caller): Promise<SubAgent>
  dropFor(taskId: string): void
  ownWorktrees(task: StoredTask): string[]
  close(): void
}

export interface ReviewerChoice {
  lead: TaskLead
  unavailable?: AgentKind
}

export interface SubAgentDeps {
  store: TedStore
  runs: RunManager
  agents: Agents
  find(ref: string): StoredTask
  leadFor(task: StoredTask): Promise<TaskLead>
  reviewerFor(task: StoredTask): Promise<ReviewerChoice>
  envFor(task: StoredTask, repo: TaskRepo): Promise<Record<string, string>>
  permissionsFor(task: StoredTask): Promise<PermissionMode>
  clonePathFor(repo: TaskRepo): string
  runFolder(task: StoredTask): Promise<string | undefined>
  worktreesDir: string
  pump(): void
  inBackground(what: string, work: () => Promise<void>): void
}

const maxNameLength = 60
const lingerMs = 1_000

export function createSubAgents(deps: SubAgentDeps): SubAgents {
  const { store, runs, agents, find } = deps
  const startingNow = new Map<string, string>()
  const waits = new Map<string, number>()
  const lingering = new Map<string, NodeJS.Timeout>()
  const wakers = new Map<string, Set<() => void>>()
  const awaitingTurn = new Map<string, number>()
  const ended = new Set<string>()
  const cancelled = new Set<string>()
  let allocating: Promise<unknown> = Promise.resolve()
  let closed = false

  function drop(id: string): void {
    if (startingNow.has(id)) cancelled.add(id)
    store.dropSubAgentRequest(id)
    wake(id)
  }

  function lead(ref: string, caller: Caller): { task: StoredTask; leadRun: Run } {
    if (caller.kind !== 'run') {
      throw new RequestError(403, 'only a Task Lead can start and steer sub-agents')
    }
    const task = find(ref)
    const run = store.getRun(caller.runId)
    if (run?.taskId !== task.id) {
      throw new RequestError(403, `this Run doesn’t belong to ${task.displayId}`)
    }
    if (task.leadRunId !== run.id || run.parentRunId !== undefined) {
      throw new RequestError(403, 'only the Task Lead can start and steer sub-agents')
    }
    return { task, leadRun: run }
  }

  function ownSubAgent(runId: string, caller: Caller): { run?: Run; request?: SubAgentRequest } {
    if (caller.kind !== 'run') {
      throw new RequestError(403, 'only a Task Lead can start and steer sub-agents')
    }
    const run = store.getRun(runId)
    const request = run ? undefined : store.subAgentRequests().find((r) => r.id === runId)
    const parent = run?.parentRunId ?? request?.parentRunId
    if (!run && !request) throw new RequestError(404, `no sub-agent ${runId}`)
    if (parent !== caller.runId) {
      throw new RequestError(403, `sub-agent ${runId} wasn’t started by this Run`)
    }
    const callerRun = store.getRun(caller.runId)
    const task = callerRun?.taskId === undefined ? undefined : store.getTask(callerRun.taskId)
    if (task?.leadRunId !== caller.runId) {
      throw new RequestError(403, 'only the Task Lead can start and steer sub-agents')
    }
    return { ...(run && { run }), ...(request && { request }) }
  }

  function stateOf(run: Run): SubAgentState {
    if (run.state === 'finished') return run.failure !== undefined ? 'failed' : 'stopped'
    return run.state
  }

  function describe(run: Run): SubAgent {
    return { id: run.id, name: run.name ?? 'Sub-agent', agent: run.agent, state: stateOf(run) }
  }

  function describeRequest(request: SubAgentRequest): SubAgent {
    return { id: request.id, name: request.name, agent: request.agent, state: 'queued' }
  }

  function turnEndedSinceSend(run: Run): boolean {
    const since = awaitingTurn.get(run.id) ?? 0
    const agent = agents.get(run.agent)
    let started = false
    const ended = runs.output.entries(run.id).some((e) => {
      if (e.offset < since) return false
      const state = agent.stateFrom(e.line)
      if (state === 'working' || state === 'waiting' || agent.acceptedTextFrom(e.line)) {
        started = true
      }
      return started && state === 'idle'
    })
    if (ended) awaitingTurn.delete(run.id)
    return ended
  }

  function wake(runId: string): void {
    for (const waker of wakers.get(runId) ?? []) waker()
  }

  function finalMessage(run: Run): string | undefined {
    const entries = agents.get(run.agent).chat(runs.output.entries(run.id), run.cwd)
    return entries.findLast((e) => e.kind === 'agent')?.text
  }

  function ownWorktree(task: StoredTask, repo: TaskRepo, name: string): Promise<string> {
    const next = allocating.then(() => addOwnWorktree(task, repo, name))
    allocating = next.catch(() => undefined)
    return next
  }

  async function addOwnWorktree(task: StoredTask, repo: TaskRepo, name: string): Promise<string> {
    const clone = deps.clonePathFor(repo)
    const base = `${task.branch ?? `ted/${task.displayId.toLowerCase()}`}-${slug(name)}`
    let branch = base
    for (let n = 2; await git.branchExists(clone, branch); n++) branch = `${base}-${n}`
    const dir = path.join(
      deps.worktreesDir,
      task.displayId,
      'sub-agents',
      branch.split('/').at(-1) ?? 'sub-agent',
    )
    await mkdir(path.dirname(dir), { recursive: true })
    const head = await git.revParse(repo.worktree, 'HEAD')
    await git.addWorktree(clone, { path: dir, branch, from: head })
    return dir
  }

  async function launch(request: SubAgentRequest): Promise<void> {
    const task = find(request.taskId)
    const parent = store.getRun(request.parentRunId)
    const repo = task.repos.find((r) => !r.removed)
    if (!parent || parent.state === 'finished' || !repo || task.archived) {
      drop(request.id)
      return
    }
    const shared = (await deps.runFolder(task)) ?? repo.worktree
    const cwd = request.ownWorktree ? await ownWorktree(task, repo, request.name) : shared
    const prompt =
      store.reviewerOf(request.id)?.purpose === 'loop-check'
        ? await tedSubAgentPrompt(request.prompt)
        : await subAgentPrompt(task.displayId, request.prompt)
    const env = { ...(await deps.envFor(task, repo)), TED_TASK: task.displayId }
    const permissions = await deps.permissionsFor(task)
    if (cancelled.has(request.id)) {
      if (cwd !== shared) {
        await git.removeWorktree(deps.clonePathFor(repo), cwd).catch(() => undefined)
      }
      return
    }
    await runs.start({
      id: request.id,
      agent: request.agent,
      prompt,
      cwd,
      taskId: task.id,
      parentRunId: request.parentRunId,
      name: request.name,
      env,
      permissions,
      ...(request.model !== undefined && { model: request.model }),
      ...(request.effort !== undefined && { effort: request.effort }),
    })
    if (cancelled.has(request.id)) await runs.stop(request.id)
  }

  function setWaiting(leadRunId: string, delta: 1 | -1): void {
    const count = (waits.get(leadRunId) ?? 0) + delta
    if (count > 0) {
      waits.set(leadRunId, count)
      clearTimeout(lingering.get(leadRunId))
      lingering.delete(leadRunId)
      store.setOnSubAgents(leadRunId, true)
      return
    }
    waits.delete(leadRunId)
    if (closed) return
    lingering.set(
      leadRunId,
      setTimeout(() => {
        lingering.delete(leadRunId)
        if (!waits.has(leadRunId)) store.setOnSubAgents(leadRunId, false)
        deps.pump()
      }, lingerMs),
    )
  }

  async function waitFor(
    runId: string,
    timeoutMs: number,
    waiting?: { start(): void; end(): void },
  ): Promise<SubAgentWait> {
    const endedBefore = store.getRun(runId)?.state === 'finished'
    const check = (): SubAgentWait | undefined => {
      const run = store.getRun(runId)
      if (!run) {
        const request = store.subAgentRequests().find((r) => r.id === runId)
        if (request) return undefined
        return {
          id: runId,
          name: 'Sub-agent',
          agent: 'claude',
          state: 'stopped',
          done: true,
          error: 'The sub-agent never started: its request was dropped.',
        }
      }
      if (run.state === 'working' || run.state === 'waiting') return undefined
      if (run.state === 'finished' && !endedBefore && !ended.has(run.id)) return undefined
      if (run.state === 'idle' && !turnEndedSinceSend(run)) return undefined
      const message = finalMessage(run)
      return {
        ...describe(run),
        done: true,
        ...(message !== undefined && { message }),
        ...(run.failure !== undefined && { error: run.failure }),
      }
    }
    const now = check()
    if (now) return now
    waiting?.start()
    try {
      return await new Promise<SubAgentWait>((resolve) => {
        const set = wakers.get(runId) ?? new Set()
        wakers.set(runId, set)
        const finish = (result: SubAgentWait) => {
          clearTimeout(timer)
          set.delete(waker)
          if (set.size === 0) wakers.delete(runId)
          resolve(result)
        }
        const pending = (): SubAgentWait => {
          const run = store.getRun(runId)
          const request = store.subAgentRequests().find((r) => r.id === runId)
          const current = run ? describe(run) : request ? describeRequest(request) : undefined
          return {
            ...(current ?? { id: runId, name: 'Sub-agent', agent: 'claude', state: 'queued' }),
            done: false,
          }
        }
        const waker = () => {
          const result = closed ? pending() : check()
          if (result) finish(result)
        }
        const timer = setTimeout(() => finish(pending()), timeoutMs)
        set.add(waker)
      })
    } finally {
      waiting?.end()
    }
  }

  const unsubscribe = store.subscribe((event) => {
    if (event.type === 'run-output') wake(event.runId)
    if (event.type === 'run-updated' && event.run.state !== 'finished') wake(event.run.id)
    if (event.type === 'run-updated' && event.run.state === 'finished') {
      const parentId = event.run.id
      setImmediate(() => {
        if (closed) return
        for (const request of store.subAgentRequests()) {
          if (request.parentRunId === parentId) drop(request.id)
        }
        for (const child of store.listRuns()) {
          if (child.parentRunId === parentId && child.state !== 'finished') {
            deps.inBackground('stop a sub-agent whose Task Lead stopped', () => runs.stop(child.id))
          }
        }
      })
    }
  })

  runs.observe({
    finished(run, ending) {
      try {
        ended.add(run.id)
        subAgentFinished(run, ending)
      } finally {
        wake(run.id)
      }
    },
  })

  function subAgentFinished(
    run: Run,
    { stopped, lastLines }: { stopped: boolean; lastLines: string[] },
  ) {
    if (run.parentRunId === undefined || stopped || closed) return
    const error = [
      'The sub-agent’s process ended before it finished its turn.',
      ...lastLines.slice(-10),
    ].join('\n')
    store.failRun(run.id, error)
    const parent = store.getRun(run.parentRunId)
    if (parent && parent.state !== 'finished' && !waits.has(parent.id)) {
      deps.inBackground('tell the Task Lead a sub-agent failed', () =>
        runs.send(
          parent.id,
          `Your sub-agent “${run.name ?? 'Sub-agent'}” (Run ${run.id}) failed: its process ended before it finished. Decide what to do next; \`ted run wait ${run.id}\` shows its last message.`,
        ),
      )
    }
  }

  for (const request of store.subAgentRequests()) {
    const parent = store.getRun(request.parentRunId)
    if (!parent || parent.state === 'finished') store.dropSubAgentRequest(request.id)
  }

  return {
    async request(ref, caller, input) {
      const { task, leadRun } = lead(ref, caller)
      if (task.stage === 'backlog' || task.stage === 'done' || task.archived) {
        throw new RequestError(409, `${task.displayId} isn’t running`)
      }
      if (input.reviewer === true) {
        if (input.agent !== undefined || input.model !== undefined || input.effort !== undefined) {
          throw new RequestError(
            400,
            'the reviewer’s agent, model and effort come from the `reviewer` setting; leave them out',
          )
        }
        const choice = await deps.reviewerFor(task)
        const id = crypto.randomUUID()
        const request = store.requestSubAgent({
          id,
          taskId: task.id,
          parentRunId: leadRun.id,
          name: `Reviewer · ${stageTitle(task.stage)}`,
          agent: choice.lead.agent,
          ...(choice.lead.model !== undefined && { model: choice.lead.model }),
          ...(choice.lead.effort !== undefined && { effort: choice.lead.effort }),
          prompt: input.prompt,
          ownWorktree: input.ownWorktree === true,
        })
        store.chooseReviewer({
          runId: id,
          taskId: task.id,
          stage: task.stage,
          purpose: 'review',
          agent: choice.lead.agent,
          ...(choice.unavailable !== undefined && { unavailable: choice.unavailable }),
        })
        deps.pump()
        const started = store.getRun(request.id)
        return started ? describe(started) : describeRequest(request)
      }
      const fallback = await deps.leadFor(task)
      const agent: AgentKind = input.agent ?? fallback.agent
      const sameAgent = agent === fallback.agent
      const model = input.model ?? (sameAgent ? fallback.model : undefined)
      const effort: Effort | undefined = input.effort ?? (sameAgent ? fallback.effort : undefined)
      const name = (input.name?.trim() || firstHeading(input.prompt) || 'Sub-agent').slice(
        0,
        maxNameLength,
      )
      const request = store.requestSubAgent({
        id: crypto.randomUUID(),
        taskId: task.id,
        parentRunId: leadRun.id,
        name,
        agent,
        ...(model !== undefined && { model }),
        ...(effort !== undefined && { effort }),
        prompt: input.prompt,
        ownWorktree: input.ownWorktree === true,
      })
      deps.pump()
      const started = store.getRun(request.id)
      return started ? describe(started) : describeRequest(request)
    },
    queued() {
      return store.subAgentRequests().flatMap((request, i) => {
        if (startingNow.has(request.id)) return []
        const task = store.getTask(request.taskId)
        return task
          ? [{ id: request.id, kind: 'sub-agent' as const, rank: i, factoryId: task.factoryId }]
          : []
      })
    },
    begin(id) {
      const request = store.subAgentRequests().find((r) => r.id === id)
      if (!request || startingNow.has(id)) return
      startingNow.set(id, request.taskId)
      deps.inBackground(`start sub-agent “${request.name}”`, async () => {
        try {
          await launch(request)
        } catch (error) {
          store.dropSubAgentRequest(id)
          throw error
        } finally {
          startingNow.delete(id)
          cancelled.delete(id)
          wake(id)
          deps.pump()
        }
      })
    },
    starting(taskId) {
      return [...startingNow.values()].filter((id) => id === taskId).length
    },
    startingTasks: () => [...startingNow.values()],
    async wait(runId, caller, timeoutMs) {
      ownSubAgent(runId, caller)
      const leadRunId = caller.kind === 'run' ? caller.runId : ''
      return waitFor(runId, timeoutMs, {
        start: () => {
          setWaiting(leadRunId, 1)
          deps.pump()
        },
        end: () => setWaiting(leadRunId, -1),
      })
    },
    async result(runId) {
      for (;;) {
        const result = await waitFor(runId, 60_000)
        if (result.done || closed) return result
      }
    },
    requestForTed(task, { name, prompt, choice, purpose }) {
      const leadRunId = task.leadRunId
      const leadRun = leadRunId === undefined ? undefined : store.getRun(leadRunId)
      if (!leadRun || leadRun.state === 'finished' || task.archived) return undefined
      const id = crypto.randomUUID()
      store.requestSubAgent({
        id,
        taskId: task.id,
        parentRunId: leadRun.id,
        name,
        agent: choice.lead.agent,
        ...(choice.lead.model !== undefined && { model: choice.lead.model }),
        ...(choice.lead.effort !== undefined && { effort: choice.lead.effort }),
        prompt,
        ownWorktree: false,
      })
      store.chooseReviewer({
        runId: id,
        taskId: task.id,
        stage: task.stage,
        purpose,
        agent: choice.lead.agent,
        ...(choice.unavailable !== undefined && { unavailable: choice.unavailable }),
      })
      deps.pump()
      return id
    },
    async send(runId, caller, text) {
      const { run, request } = ownSubAgent(runId, caller)
      if (!run) {
        throw new RequestError(
          409,
          `sub-agent “${request?.name}” hasn’t started yet; wait for it first`,
        )
      }
      if (run.state === 'finished') {
        throw new RequestError(409, `sub-agent “${run.name ?? 'Sub-agent'}” has stopped`)
      }
      awaitingTurn.set(run.id, store.runReadOffset(run.id))
      await runs.send(run.id, text).catch((error: unknown) => {
        awaitingTurn.delete(run.id)
        throw error
      })
      return describe(store.getRun(run.id) ?? run)
    },
    async stop(runId, caller) {
      const { run, request } = ownSubAgent(runId, caller)
      if (request) {
        drop(request.id)
        return { ...describeRequest(request), state: 'stopped' }
      }
      if (!run) throw new RequestError(404, `no sub-agent ${runId}`)
      await runs.stop(run.id)
      return describe(store.getRun(run.id) ?? run)
    },
    dropFor(taskId) {
      for (const request of store.subAgentRequests(taskId)) drop(request.id)
    },
    ownWorktrees(task) {
      const own = path.join(deps.worktreesDir, task.displayId, 'sub-agents') + path.sep
      return store
        .taskRunList(task.id)
        .filter((r) => r.parentRunId !== undefined && r.cwd.startsWith(own))
        .map((r) => r.cwd)
    },
    close() {
      closed = true
      unsubscribe()
      for (const timer of lingering.values()) clearTimeout(timer)
      lingering.clear()
      for (const set of wakers.values()) for (const waker of set) waker()
    },
  }
}

export function firstHeading(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const match = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line.trim())
    if (match?.[1]) return match[1]
  }
  return undefined
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30)
      .replace(/-+$/, '') || 'sub-agent'
  )
}
