import { mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import type {
  AgentKind,
  AgentStageId,
  Comment,
  Outcome,
  Task,
  TaskRepo,
  WorktreeCommandOutcome,
} from '@ted/protocol'
import { RequestError } from '../errors.ts'
import { clonePath } from '../factories.ts'
import * as git from '../git.ts'
import type { IdleTimer } from '../idle.ts'
import type { RunManager } from '../runs/run-manager.ts'
import type { StoredTask, TedStore } from '../store/index.ts'
import { nextStageMessage, taskLeadPrompt } from '../workflow/workflow.ts'
import type { WorkflowResolution, Workflows } from '../workflow/workflows.ts'
import {
  type CommandResult,
  copyFiles,
  outputTail,
  primaryRepoWorktree,
  type RepoWorktree,
  runWorktreeCommand,
} from './worktree.ts'

export type Caller = { kind: 'daemon' } | { kind: 'run'; runId: string }

export interface Tasks {
  create(input: { title: string; factory?: string }): Promise<Task>
  start(ref: string): Promise<Task>
  comment(ref: string, caller: Caller, body: string): Comment
  reportOutcome(ref: string, caller: Caller, outcome: Outcome): Promise<Task>
  setupLog(ref: string, repo: string): Promise<string>
  close(): Promise<void>
}

const slugLength = 40

export function createTasks(options: {
  store: TedStore
  runs: RunManager
  workflows: Workflows
  reposDir: string
  worktreesDir: string
  logsDir: string
  leadAgent: (task: Task) => AgentKind
  idle?: IdleTimer
}): Tasks {
  const { store, runs, workflows, reposDir, worktreesDir, logsDir, leadAgent } = options
  const starting = new Set<string>()
  const advancing = new Set<string>()
  const background = new Set<Promise<void>>()
  const stopping = new AbortController()

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

  const commandEnv = (task: Task, settings: RepoWorktree): NodeJS.ProcessEnv => ({
    ...process.env,
    ...settings.env,
    TED_TASK: task.displayId,
  })

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
          env: commandEnv(task, settings),
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
    settings: RepoWorktree,
    setupReport?: string,
  ): Promise<void> {
    const prompt = await taskLeadPrompt(
      task,
      resolution.workflow,
      task.stage as AgentStageId,
      setupReport,
    )
    await runs.start({
      agent: leadAgent(task),
      prompt,
      cwd: repo.worktree,
      taskId: task.id,
      env: { ...settings.env, TED_TASK: task.displayId },
    })
  }

  async function setUpAndLaunch(
    task: StoredTask,
    resolution: WorkflowResolution,
    repo: TaskRepo,
    settings: RepoWorktree,
  ): Promise<void> {
    const setup = settings.setup
    if (!setup) return launch(task, resolution, repo, settings)
    store.worktreeSetupStarted(task.id, repo.name, setup.run)
    const log = commandLog(task, 'setup', repo.name)
    const result = await runWorktreeCommand({
      command: setup,
      cwd: repo.worktree,
      env: commandEnv(task, settings),
      log,
      signal: stopping.signal,
    })
    if (result.outcome === 'interrupted') return
    store.worktreeSetupFinished(task.id, repo.name, {
      outcome: result.outcome,
      ...(result.exitCode !== undefined && { exitCode: result.exitCode }),
    })
    const report =
      result.outcome === 'passed'
        ? undefined
        : setupFailure(setup.run, result, await outputTail(log))
    await launch(find(task.id), resolution, repo, settings, report)
  }

  async function resume(taskId: string): Promise<void> {
    const task = find(taskId)
    const repo = task.repos.find((r) => !r.removed)
    if (!repo || task.leadRunId || task.stage === 'backlog' || task.stage === 'done') return
    const factory = factoryOf(task)
    const resolution = await workflows.resolve(factory, { fetch: false })
    const settings = primaryRepoWorktree(resolution.workflow, factory)
    const setup = repo.setup
    if (setup?.state === 'running' || (settings.setup && !setup)) {
      return setUpAndLaunch(task, resolution, repo, settings)
    }
    const report =
      setup && setup.state !== 'passed'
        ? setupFailure(
            setup.command,
            {
              outcome: setup.state,
              ...(setup.exitCode !== undefined && { exitCode: setup.exitCode }),
            },
            await outputTail(commandLog(task, 'setup', repo.name)),
          )
        : undefined
    await launch(task, resolution, repo, settings, report)
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
      const clone = clonePath(reposDir, factory)
      await git.fetch(clone)
      const resolution = await workflows.resolve(factory, { fetch: false })
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
      const copy = await copyFiles(store.localFolder(factory.repo), worktree, settings.copy)
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
      if (settings.setup) {
        inBackground(`set up ${task.displayId}’s worktree`, () =>
          setUpAndLaunch(started, resolution, repo, settings),
        )
      } else {
        await launch(started, resolution, repo, settings)
      }
      const { worktree: _, ...current } = find(task.id)
      return current
    } finally {
      starting.delete(task.id)
    }
  }

  for (const task of store.listTasks()) {
    if (task.leadRunId === undefined && task.repos.some((r) => !r.removed)) {
      inBackground(`resume ${task.displayId}`, () => resume(task.id))
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
          inBackground(`finish ${task.displayId}`, () => finish(task, resolution))
        } else {
          await runs.send(runId, nextStageMessage(resolution.workflow, next))
        }
        return moved
      } finally {
        advancing.delete(task.id)
      }
    },

    async setupLog(ref, name) {
      const task = find(ref)
      if (!task.repos.some((r) => r.name === name)) {
        throw new RequestError(404, `${task.displayId} has no worktree for ${name}`)
      }
      return readFile(commandLog(task, 'setup', name), 'utf8').catch(() => '')
    },

    async close() {
      stopping.abort()
      await Promise.all(background)
    },
  }
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
