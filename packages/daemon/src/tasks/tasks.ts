import { mkdir, readFile, rm } from 'node:fs/promises'
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
  TaskRepo,
  WorktreeCommandOutcome,
} from '@ted/protocol'
import { clarifyDepths } from '@ted/protocol'
import type { Agents } from '../agents/index.ts'
import type { Banners } from '../banners.ts'
import { RequestError } from '../errors.ts'
import { clonePath, ensureClone } from '../factories.ts'
import * as git from '../git.ts'
import type { AgentHealthMonitor } from '../health/agent-health.ts'
import type { IdleTimer } from '../idle.ts'
import { redactSecrets } from '../redact.ts'
import type { RunManager } from '../runs/run-manager.ts'
import type { NewTask, RecordedSetup, RunFlags, StoredTask, TedStore } from '../store/index.ts'
import { resolveAgentChoices } from '../workflow/agent-choices.ts'
import type { WorkflowSettings } from '../workflow/check.ts'
import { nextStageMessage, taskLeadPrompt } from '../workflow/workflow.ts'
import type { WorkflowResolution, Workflows } from '../workflow/workflows.ts'
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
  comment(ref: string, caller: Caller, body: string): Comment
  setActivity(ref: string, caller: Caller, text: string): Task
  reportOutcome(ref: string, caller: Caller, outcome: Outcome): Promise<Task>
  setLead(ref: string, lead: TaskLead): Task
  useDefaultModel(ref: string): Promise<Task>
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
  agents: Agents
  health: AgentHealthMonitor
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
    agents,
    health,
    attachmentFile,
  } = options
  const starting = new Set<string>()
  const relaunching = new Set<string>()
  const interrupted = new Set<string>()
  const advancing = new Set<string>()
  const applying = new Set<string>()
  const asked = new Set<string>()
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
      if (lead.agent !== run.agent) await freshLead(task, run)
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

  async function freshLead(task: StoredTask, run: Run): Promise<void> {
    const factory = factoryOf(task)
    const repo = task.repos.find((r) => !r.removed)
    if (!repo) throw new Error(`${task.displayId} has no worktree`)
    const resolution = await workflows.resolve(factory, { fetch: false })
    const env =
      store.recordedSetup(task.id, repo.name)?.env ??
      primaryRepoWorktree(resolution.workflow, factory).env
    await runs.stop(run.id)
    await launch(task, resolution, repo, env)
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
    resumeSession?: string,
  ): Promise<void> {
    const lead = task.lead ?? leadFrom(resolution.workflow.settings)
    const agent = lead.agent
    if (!(await health.ready(agent))) {
      store.holdTaskRun({
        taskId: task.id,
        agent,
        ...(resumeSession !== undefined && { sessionId: resumeSession }),
      })
      return
    }
    const prompt =
      resumeSession === undefined
        ? await taskLeadPrompt(
            task,
            resolution.workflow,
            task.stage as AgentStageId,
            attachmentFile,
            setupReport,
          )
        : continueMessage
    await runs.start({
      agent,
      prompt,
      cwd: repo.worktree,
      taskId: task.id,
      env: { ...env, TED_TASK: task.displayId },
      ...(resumeSession !== undefined && { resume: resumeSession }),
      ...(lead.model !== undefined && { model: lead.model }),
      ...(lead.effort !== undefined && { effort: lead.effort }),
    })
    store.releaseTaskRun(task.id)
  }

  async function setUpAndLaunch(
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
    const task = find(taskId)
    const repo = task.repos.find((r) => !r.removed)
    const held = store.heldRuns().find((h) => h.taskId === taskId)
    const leadLive = task.runs.some((r) => r.id === task.leadRunId)
    if (!repo || task.stage === 'backlog' || task.stage === 'done') {
      if (held) store.releaseTaskRun(taskId)
      return
    }
    if (held ? leadLive : task.leadRunId) return
    if (held?.sessionId !== undefined && (task.lead?.agent ?? held.agent) === held.agent) {
      const resolution = await workflows.resolve(factoryOf(task), { fetch: false })
      const env = store.recordedSetup(task.id, repo.name)?.env ?? {}
      return launch(task, resolution, repo, env, undefined, held.sessionId)
    }
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
      const { worktree: _, ...current } = find(task.id)
      return current
    } finally {
      starting.delete(task.id)
    }
  }

  function relaunch(taskId: string): void {
    if (relaunching.has(taskId)) return
    relaunching.add(taskId)
    inBackground(`continue ${taskId}`, () =>
      resume(taskId).finally(() => relaunching.delete(taskId)),
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
    if (!now || now.leadRunId !== run.id || now.stage === 'done') return
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
    finished(run) {
      interrupted.delete(run.id)
      inBackground(`check why Run ${run.id} stopped`, () => leadStopped(run))
    },
  })

  health.onReady((agent) => {
    for (const held of store.heldRuns()) if (held.agent === agent) relaunch(held.taskId)
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
    if (heldAtStart.has(task.id)) relaunch(task.id)
    else if (task.leadRunId === undefined && task.repos.some((r) => !r.removed)) {
      inBackground(`resume ${task.displayId}`, () => resume(task.id))
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

    setLead(ref, lead) {
      const task = store.setTaskLead(find(ref).id, lead)
      inBackground('apply the Task Lead setting', () => applyLead(task.id))
      const held = store.heldRuns().find((h) => h.taskId === task.id)
      if (held && held.agent !== lead.agent) relaunch(task.id)
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
      stopping.abort()
      await Promise.all(background)
    },
  }
}

const continueMessage =
  'TED paused you because your agent couldn’t run (signed out, not installed or too old). It can run again now. Carry on where you left off.'

function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line !== '') ?? ''
  )
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
