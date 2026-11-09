import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import {
  type AgentKind,
  type AgentStageId,
  agentStageIds,
  type Comment,
  type Outcome,
  type Task,
} from '@ted/protocol'
import { RequestError } from '../errors.ts'
import { clonePath } from '../factories.ts'
import * as git from '../git.ts'
import type { RunManager } from '../runs/run-manager.ts'
import type { StoredTask, TedStore } from '../store/index.ts'
import { nextStageMessage, taskLeadPrompt } from '../workflow/workflow.ts'
import type { WorkflowResolution, Workflows } from '../workflow/workflows.ts'

export type Caller = { kind: 'daemon' } | { kind: 'run'; runId: string }

export interface Tasks {
  create(input: { title: string; factory?: string }): Promise<Task>
  start(ref: string): Promise<Task>
  comment(ref: string, caller: Caller, body: string): Comment
  setActivity(ref: string, caller: Caller, text: string): Task
  reportOutcome(ref: string, caller: Caller, outcome: Outcome): Promise<Task>
  close(): Promise<void>
}

const slugLength = 40

export function createTasks(options: {
  store: TedStore
  runs: RunManager
  workflows: Workflows
  reposDir: string
  worktreesDir: string
  leadAgent: (task: Task) => AgentKind
}): Tasks {
  const { store, runs, workflows, reposDir, worktreesDir, leadAgent } = options
  const starting = new Set<string>()
  const advancing = new Set<string>()
  const finishing = new Set<Promise<void>>()

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
    const order = workflow.stages.filter((id): id is AgentStageId =>
      (agentStageIds as readonly string[]).includes(id),
    )
    return { ...(file && { stageFile: { layer: file.layer, path: file.path } }), layers, order }
  }

  async function start(ref: string): Promise<Task> {
    const task = find(ref)
    const factory = factoryOf(task)
    if (task.stage !== 'backlog' || starting.has(task.id)) {
      throw new RequestError(409, `${task.displayId} has already started`)
    }
    starting.add(task.id)
    try {
      const clone = clonePath(reposDir, factory)
      await git.fetch(clone)
      const resolution = await workflows.resolve(factory, { fetch: false })
      const stage = resolution.workflow.next('backlog') as AgentStageId
      const branch = await branchFor(clone, task)
      const worktree = path.join(worktreesDir, task.displayId, factory.name)
      const prompt = await taskLeadPrompt(task, resolution.workflow, stage)
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
        agent: leadAgent(task),
        prompt,
        cwd: worktree,
        taskId: task.id,
        env: { TED_TASK: task.displayId },
      })
      const { worktree: _, ...current } = find(task.id)
      return current
    } finally {
      starting.delete(task.id)
    }
  }

  return {
    async create({ title, factory: key }) {
      if (key === undefined) return store.createTask({ title })
      const factory = store.listFactories().find((f) => f.key === key)
      if (!factory) throw new RequestError(404, `no Factory with key ${key}`)
      const task = await store.createTask({ title, factoryId: factory.id })
      const resolution = await workflows.resolve(factory).catch((error: unknown) => {
        console.error(
          `couldn’t read ${factory.repo}’s Workflow; ${task.displayId} waits in Backlog:`,
          error,
        )
        return undefined
      })
      return !resolution || resolution.workflow.stages.includes('backlog') ? task : start(task.id)
    },

    start,

    comment(ref, caller, body) {
      const { task, runId } = ownTask(ref, caller)
      return store.postComment({ taskId: task.id, body, authorRunId: runId })
    },

    setActivity(ref, caller, text) {
      const { task, runId } = ownTask(ref, caller)
      return store.setActivity(task.id, text, runId)
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

    async close() {
      await Promise.all(finishing)
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
