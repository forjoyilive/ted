import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import type { Comment, Outcome, Task } from '@ted/protocol'
import { RequestError } from '../errors.ts'
import { clonePath } from '../factories.ts'
import * as git from '../git.ts'
import type { RunManager } from '../runs/run-manager.ts'
import type { StoredTask, TedStore } from '../store/index.ts'
import { firstStage, nextStage, taskLeadPrompt } from '../workflow/workflow.ts'

export type Caller = { kind: 'daemon' } | { kind: 'run'; runId: string }

export interface Tasks {
  create(input: { title: string; factory?: string }): Promise<Task>
  start(ref: string): Promise<Task>
  comment(ref: string, caller: Caller, body: string): Comment
  reportOutcome(ref: string, caller: Caller, outcome: Outcome): Task
  close(): Promise<void>
}

const slugLength = 40

export function createTasks(options: {
  store: TedStore
  runs: RunManager
  reposDir: string
  worktreesDir: string
}): Tasks {
  const { store, runs, reposDir, worktreesDir } = options
  const starting = new Set<string>()
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

  return {
    async create({ title, factory: key }) {
      if (key === undefined) return store.createTask({ title })
      const factory = store.listFactories().find((f) => f.key === key)
      if (!factory) throw new RequestError(404, `no Factory with key ${key}`)
      return store.createTask({ title, factoryId: factory.id })
    },

    async start(ref) {
      const task = find(ref)
      const factory = factoryOf(task)
      if (task.stage !== 'backlog' || starting.has(task.id)) {
        throw new RequestError(409, `${task.displayId} has already started`)
      }
      starting.add(task.id)
      try {
        const clone = clonePath(reposDir, factory)
        await git.fetch(clone)
        const branch = await branchFor(clone, task)
        const worktree = path.join(worktreesDir, task.displayId, factory.name)
        const stage = firstStage()
        const prompt = await taskLeadPrompt(task, stage)
        await mkdir(path.dirname(worktree), { recursive: true })
        await git.addWorktree(clone, {
          path: worktree,
          branch,
          from: `origin/${factory.defaultBranch}`,
        })
        store.startTask({ taskId: task.id, stage, branch, worktree })
        await runs.start({
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
    },

    comment(ref, caller, body) {
      const { task, runId } = ownTask(ref, caller)
      return store.postComment({ taskId: task.id, body, authorRunId: runId })
    },

    reportOutcome(ref, caller, _outcome) {
      const { task, runId } = ownTask(ref, caller)
      if (task.leadRunId !== runId) {
        throw new RequestError(403, 'only the Task Lead reports outcomes')
      }
      if (task.stage === 'backlog' || task.stage === 'done') {
        throw new RequestError(409, `${task.displayId} isn’t in a Stage that has an outcome`)
      }
      const next = nextStage(task.stage)
      const moved = store.changeStage(task.id, next)
      if (next === 'done') {
        const done = finish(task)
          .catch((error: unknown) => console.error(`couldn’t finish ${task.displayId}:`, error))
          .finally(() => finishing.delete(done))
        finishing.add(done)
      }
      return moved
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
