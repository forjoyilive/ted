import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import type {
  AgentStageId,
  Attachment,
  Comment,
  Outcome,
  Run,
  Task,
  TaskDefaults,
  TaskLead,
} from '@ted/protocol'
import { clarifyDepths } from '@ted/protocol'
import type { Agents } from '../agents/index.ts'
import type { Banners } from '../banners.ts'
import { RequestError } from '../errors.ts'
import { clonePath, ensureClone } from '../factories.ts'
import * as git from '../git.ts'
import type { RunManager } from '../runs/run-manager.ts'
import type { NewTask, RunFlags, StoredTask, TedStore } from '../store/index.ts'
import { resolveAgentChoices } from '../workflow/agent-choices.ts'
import type { WorkflowSettings } from '../workflow/check.ts'
import { nextStageMessage, taskLeadPrompt } from '../workflow/workflow.ts'
import type { WorkflowResolution, Workflows } from '../workflow/workflows.ts'

export type Caller = { kind: 'daemon' } | { kind: 'run'; runId: string }

export interface CreateTaskInput
  extends Omit<NewTask, 'title' | 'factoryId' | 'startRequested' | 'blockedBy'> {
  title?: string
  factory?: string
  blockedBy?: string[]
  attachments?: Attachment[]
  start?: boolean
}

export interface Tasks {
  create(input: CreateTaskInput): Promise<Task>
  defaults(factoryId: string): Promise<TaskDefaults>
  start(ref: string): Promise<Task>
  comment(ref: string, caller: Caller, body: string): Comment
  reportOutcome(ref: string, caller: Caller, outcome: Outcome): Promise<Task>
  setLead(ref: string, lead: TaskLead): Task
  useDefaultModel(ref: string): Promise<Task>
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
  agents: Agents
  attachmentFile: (attachment: Attachment) => string
}): Tasks {
  const { store, runs, workflows, banners, reposDir, worktreesDir, agents, attachmentFile } =
    options
  const starting = new Set<string>()
  const advancing = new Set<string>()
  const applying = new Set<string>()
  const asked = new Set<string>()
  const finishing = new Set<Promise<void>>()

  const leadFrom = (settings?: WorkflowSettings) =>
    resolveAgentChoices(settings, {
      claude: agents.installed('claude'),
      codex: agents.installed('codex'),
    }).lead

  function background(work: () => Promise<unknown>, what: string): void {
    const done = work()
      .then(() => undefined)
      .catch((error: unknown) => console.error(`couldn’t ${what}:`, error))
      .finally(() => finishing.delete(done))
    finishing.add(done)
  }

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
      if (lead.agent !== run.agent) await freshLead(task, lead, run)
      else {
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

  async function freshLead(task: StoredTask, lead: TaskLead, run: Run): Promise<void> {
    const stage = task.stage as AgentStageId
    const resolution = await workflows.resolve(factoryOf(task), { fetch: false })
    const prompt = await taskLeadPrompt(task, resolution.workflow, stage, attachmentFile)
    await runs.stop(run.id)
    await runs.start({
      agent: lead.agent,
      prompt,
      cwd: run.cwd,
      taskId: task.id,
      env: { TED_TASK: task.displayId },
      ...(lead.model !== undefined && { model: lead.model }),
      ...(lead.effort !== undefined && { effort: lead.effort }),
    })
  }

  function askAboutModel(run: Run): void {
    if (run.problem !== 'model-unavailable') return void asked.delete(run.id)
    const task = run.taskId === undefined ? undefined : store.getTask(run.taskId)
    if (!task || task.leadRunId !== run.id || asked.has(run.id)) return
    asked.add(run.id)
    store.postTedComment({
      taskId: task.id,
      kind: 'question',
      body: `The Task Lead asked for the model “${run.model}”, which your plan doesn’t include. TED won’t switch models on its own, so the Run is waiting. Choose Use the default model to run this Run on the CLI’s default model, or Change setting to pick another model in the Task Lead field.`,
    })
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
        background(() => applyLead(taskId), 'apply the Task Lead setting')
      }
    })
  })
  for (const task of store.listTasks()) {
    background(() => applyLead(task.id), 'apply the Task Lead setting')
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

  async function branchFor(clone: string, task: Task): Promise<string> {
    const base = ['ted/', task.displayId.toLowerCase(), slug(task.title)].join('')
    for (let n = 1; ; n++) {
      const branch = n === 1 ? base : `${base}-${n}`
      if (!(await git.branchExists(clone, branch))) return branch
    }
  }

  async function finish(task: StoredTask): Promise<void> {
    if (task.leadRunId) await runs.stop(task.leadRunId)
    if (task.worktree) {
      await git.removeWorktree(clonePath(reposDir, factoryOf(task)), task.worktree)
      await rm(path.join(worktreesDir, task.displayId), { recursive: true, force: true })
    }
  }

  function entryFor({ workflow, layers }: WorkflowResolution, stage: AgentStageId | 'done') {
    const file = stage === 'done' ? undefined : workflow.stageFile(stage)
    return { ...(file && { stageFile: { layer: file.layer, path: file.path } }), layers }
  }

  async function start(ref: string): Promise<Task> {
    const task = find(ref)
    const factory = factoryOf(task)
    if (task.stage !== 'backlog' || starting.has(task.id)) {
      throw new RequestError(409, `${task.displayId} has already started`)
    }
    starting.add(task.id)
    try {
      const clone = await ensureClone({ banners, reposDir }, factory)
      await git.fetch(clone)
      const resolution = await workflows.resolve(factory, { fetch: false })
      const lead =
        task.lead ?? store.setTaskLead(task.id, leadFrom(resolution.workflow.settings)).lead
      if (!lead) throw new Error(`${task.displayId} has no Task Lead`)
      const stage = resolution.workflow.next('backlog') as AgentStageId
      const branch = await branchFor(clone, task)
      const worktree = path.join(worktreesDir, task.displayId, factory.name)
      const prompt = await taskLeadPrompt(task, resolution.workflow, stage, attachmentFile)
      await mkdir(path.dirname(worktree), { recursive: true })
      await git.addWorktree(clone, {
        path: worktree,
        branch,
        from: `origin/${factory.defaultBranch}`,
      })
      store.startTask({
        taskId: task.id,
        stage,
        branch,
        worktree,
        entry: entryFor(resolution, stage),
      })
      await runs.start({
        agent: lead.agent,
        prompt,
        cwd: worktree,
        taskId: task.id,
        env: { TED_TASK: task.displayId },
        ...(lead.model !== undefined && { model: lead.model }),
        ...(lead.effort !== undefined && { effort: lead.effort }),
      })
      const { worktree: _, ...current } = find(task.id)
      return current
    } finally {
      starting.delete(task.id)
    }
  }

  return {
    async create({ title, factory: key, blockedBy = [], start: startNow, lead, ...fields }) {
      const name = title?.trim() || firstLine(fields.description ?? '')
      if (name === '') throw new RequestError(400, 'a Task needs a title or a description')
      const blockers = [...new Set(blockedBy.map((ref) => find(ref).id))]
      const factory =
        key === undefined ? undefined : store.listFactories().find((f) => f.key === key)
      if (key !== undefined && !factory) throw new RequestError(404, `no Factory with key ${key}`)
      let failure: unknown
      const resolution = factory
        ? await workflows.resolve(factory).catch((error: unknown) => {
            failure = error
            return undefined
          })
        : undefined
      const task = await store.createTask({
        ...fields,
        ...(fields.description !== undefined && { description: fields.description.trim() }),
        title: name,
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
      if (!resolution || blockers.length > 0) return task
      const hasBacklog = resolution.workflow.stages.includes('backlog')
      return hasBacklog && startNow !== true ? task : start(task.id)
    },

    async defaults(factoryId) {
      const factory = store.getFactory(factoryId)
      if (!factory) throw new RequestError(404, `no Factory ${factoryId}`)
      const resolution = await workflows.resolve(factory, { fetch: false })
      const depth = resolution.workflow.settings.stages.clarify?.depth
      return {
        lead: leadFrom(resolution.workflow.settings),
        clarifyDepth: clarifyDepths.find((d) => d === depth) ?? 'auto',
      }
    },

    start,

    comment(ref, caller, body) {
      const { task, runId } = ownTask(ref, caller)
      return store.postComment({ taskId: task.id, body, authorRunId: runId })
    },

    async reportOutcome(ref, caller, _outcome) {
      const { task, runId } = ownTask(ref, caller)
      if (task.leadRunId !== runId) {
        throw new RequestError(403, 'only the Task Lead reports outcomes')
      }
      if (task.stage === 'backlog' || task.stage === 'done' || advancing.has(task.id)) {
        throw new RequestError(409, `${task.displayId} isn’t in a Stage that has an outcome`)
      }
      advancing.add(task.id)
      try {
        const resolution = await workflows.resolve(factoryOf(task))
        const next = resolution.workflow.next(task.stage) as AgentStageId | 'done'
        const moved = store.changeStage(task.id, next, entryFor(resolution, next))
        if (next === 'done') {
          const done = finish(task)
            .catch((error: unknown) => console.error(`couldn’t finish ${task.displayId}:`, error))
            .finally(() => finishing.delete(done))
          finishing.add(done)
        } else {
          await runs.send(runId, nextStageMessage(resolution.workflow, next))
        }
        return moved
      } finally {
        advancing.delete(task.id)
      }
    },

    setLead(ref, lead) {
      const task = store.setTaskLead(find(ref).id, lead)
      background(() => applyLead(task.id), 'apply the Task Lead setting')
      return task
    },

    async useDefaultModel(ref) {
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
      const { worktree: _, ...current } = find(task.id)
      return current
    },

    async close() {
      closed = true
      unsubscribe()
      while (finishing.size > 0) await Promise.all(finishing)
    },
  }
}

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '') ?? ''
  )
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
