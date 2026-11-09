import { mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import type {
  AgentKind,
  AgentStageId,
  Attachment,
  Comment,
  DaemonEvent,
  Outcome,
  RunSlots,
  Task,
  TaskDefaults,
  TaskRepo,
  WorktreeCommandOutcome,
} from '@ted/protocol'
import { clarifyDepths } from '@ted/protocol'
import type { Banners } from '../banners.ts'
import { RequestError } from '../errors.ts'
import { clonePath, ensureClone } from '../factories.ts'
import * as git from '../git.ts'
import type { IdleTimer } from '../idle.ts'
import { redactSecrets } from '../redact.ts'
import type { RunManager } from '../runs/run-manager.ts'
import type { NewTask, RecordedSetup, StoredTask, TedStore } from '../store/index.ts'
import { nextStageMessage, taskLeadPrompt } from '../workflow/workflow.ts'
import type { WorkflowResolution, Workflows } from '../workflow/workflows.ts'
import { type SlotUse, startsNow } from './queue.ts'
import {
  type CommandResult,
  copyFiles,
  outputTail,
  primaryRepoWorktree,
  runWorktreeCommand,
} from './worktree.ts'

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
  moveToBacklog(ref: string): Task
  slots(): Promise<RunSlots>
  subscribe(listener: (event: DaemonEvent) => void): () => void
  comment(ref: string, caller: Caller, body: string): Comment
  setActivity(ref: string, caller: Caller, text: string): Task
  reportOutcome(ref: string, caller: Caller, outcome: Outcome): Promise<Task>
  setupLog(ref: string, repo: string): Promise<string>
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
  defaultLead: () => AgentKind
  attachmentFile: (attachment: Attachment) => string
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
    defaultLead,
    attachmentFile,
  } = options
  const starting = new Set<string>()
  const advancing = new Set<string>()
  const background = new Set<Promise<void>>()
  const stopping = new AbortController()
  const holds = new Map<string, number>()
  const beginning = new Map<string, Promise<void>>()
  const caps = new Map<string, number | undefined>()
  const listeners = new Set<(event: DaemonEvent) => void>()
  let pumping: Promise<void> | undefined
  let again = false
  let closed = false
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
      const runs = task.runs.filter((r) => r.state === 'working').length
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

  async function fill(): Promise<void> {
    const queued = store.queue()
    if (queued.length === 0) return
    const { use } = await slotUse(queued.map((q) => q.factoryId))
    for (const entry of startsNow(store.queue(), use)) {
      if (!holds.has(entry.id)) begin(entry.id)
    }
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
    if (closed || listeners.size === 0) return
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
          store.moveToBacklog(taskId)
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
  ): Promise<void> {
    const prompt = await taskLeadPrompt(
      task,
      resolution.workflow,
      task.stage as AgentStageId,
      attachmentFile,
      setupReport,
    )
    await runs.start({
      agent: task.lead?.agent ?? factoryLead(resolution).agent,
      prompt,
      cwd: repo.worktree,
      taskId: task.id,
      env: { ...env, TED_TASK: task.displayId },
    })
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
    const result = await runWorktreeCommand({
      command: { run: setup.command, timeoutMs: setup.timeoutMs },
      cwd: repo.worktree,
      env: commandEnv(task, setup.env),
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
    if (!repo || task.leadRunId || task.stage === 'backlog' || task.stage === 'done') return
    const factory = factoryOf(task)
    const resolution = await workflows.resolve(factory, { fetch: false })
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

  function factoryLead({ workflow }: WorkflowResolution): TaskDefaults['lead'] {
    const { agent, model, effort } = workflow.settings.lead ?? {}
    return {
      agent: (agent as AgentKind | undefined) ?? defaultLead(),
      ...(model !== undefined && { model }),
      ...(effort !== undefined && {
        effort: effort as NonNullable<TaskDefaults['lead']['effort']>,
      }),
    }
  }

  async function start(ref: string): Promise<Task> {
    const task = find(ref)
    const factory = factoryOf(task)
    if (task.stage !== 'backlog' || starting.has(task.id)) {
      throw new RequestError(409, `${task.displayId} has already started`)
    }
    starting.add(task.id)
    try {
      await ensureClone({ banners, reposDir }, factory)
      const resolution = remember(factory.id, await workflows.resolve(factory, { fetch: false }))
      store.queueTask(task.id, resolution.workflow.next('backlog'))
    } finally {
      starting.delete(task.id)
    }
    await pump()
    await beginning.get(task.id)
    const { worktree: _, startRequested: __, ...current } = find(task.id)
    return current
  }

  async function launchQueued(taskId: string): Promise<void> {
    const task = find(taskId)
    const factory = factoryOf(task)
    {
      const clone = await ensureClone({ banners, reposDir }, factory)
      await git.fetch(clone)
      const resolution = remember(factory.id, await workflows.resolve(factory, { fetch: false }))
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

  for (const task of store.listTasks()) {
    if (task.leadRunId === undefined && task.repos.some((r) => !r.removed)) {
      inBackground(`resume ${task.displayId}`, () => resume(task.id))
    }
  }

  const unsubscribe = store.subscribe((event) => {
    if (
      event.type === 'task-created' ||
      event.type === 'task-updated' ||
      event.type === 'settings-changed'
    ) {
      void pump()
    }
  })
  void pump()

  return {
    async create({ title, factory: key, blockedBy = [], start: startNow, ...fields }) {
      const name = title?.trim() || firstLine(fields.description ?? '')
      if (name === '') throw new RequestError(400, 'a Task needs a title or a description')
      const blockers = [...new Set(blockedBy.map((ref) => find(ref).id))]
      const factory =
        key === undefined ? undefined : store.listFactories().find((f) => f.key === key)
      if (key !== undefined && !factory) throw new RequestError(404, `no Factory with key ${key}`)
      const task = await store.createTask({
        ...fields,
        ...(fields.description !== undefined && { description: fields.description.trim() }),
        title: name,
        blockedBy: blockers,
        startRequested: startNow === true,
        ...(factory && { factoryId: factory.id }),
      })
      if (!factory) return task
      const resolution = await workflows.resolve(factory).catch((error: unknown) => {
        console.error(
          `couldn’t read ${factory.repo}’s Workflow; ${task.displayId} waits in Backlog:`,
          error,
        )
        return undefined
      })
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
        lead: factoryLead(resolution),
        clarifyDepth: clarifyDepths.find((d) => d === depth) ?? 'auto',
      }
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

    slots,

    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

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
      return redactSecrets(await readFile(commandLog(task, 'setup', name), 'utf8').catch(() => ''))
    },

    async close() {
      closed = true
      unsubscribe()
      await pumping
      stopping.abort()
      await Promise.all(background)
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
