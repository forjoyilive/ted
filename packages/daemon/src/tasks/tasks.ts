import { mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import type {
  AgentKind,
  AgentStageId,
  AnswerRequest,
  Attachment,
  Comment,
  CommentAnswer,
  InboxItem,
  OutcomeResult,
  ReportOutcomeRequest,
  StageId,
  Task,
  TaskBrief,
  TaskDefaults,
  TaskRepo,
  WorktreeCommandOutcome,
} from '@ted/protocol'
import { briefHeadings, clarifyDepths, priorities } from '@ted/protocol'
import type { Banners } from '../banners.ts'
import { RequestError } from '../errors.ts'
import { clonePath, ensureClone } from '../factories.ts'
import * as git from '../git.ts'
import type { IdleTimer } from '../idle.ts'
import { redactSecrets } from '../redact.ts'
import type { RunManager } from '../runs/run-manager.ts'
import type { NewTask, RecordedSetup, StoredTask, TedStore } from '../store/index.ts'
import type { ResolvedWorkflow } from '../workflow/resolve.ts'
import {
  backStageMessage,
  nextStageMessage,
  stageTitle,
  taskLeadPrompt,
} from '../workflow/workflow.ts'
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
  comment(ref: string, caller: Caller, input: { body: string; choices?: string[] }): Comment
  setActivity(ref: string, caller: Caller, text: string): Task
  reportOutcome(ref: string, caller: Caller, outcome: ReportOutcomeRequest): Promise<OutcomeResult>
  answer(commentId: string, answer: AnswerRequest): Promise<Comment>
  writeBrief(ref: string, caller: Caller, text: string): TaskBrief
  brief(ref: string): TaskBrief
  inbox(): InboxItem[]
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

  async function deliver(task: Task, text: string): Promise<void> {
    const runId = find(task.id).leadRunId
    const run = runId === undefined ? undefined : store.getRun(runId)
    if (!run || run.state === 'finished') return
    await runs.send(run.id, text)
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

  for (const task of store.listTasks()) {
    if (task.leadRunId === undefined && task.repos.some((r) => !r.removed)) {
      inBackground(`resume ${task.displayId}`, () => resume(task.id))
    }
  }

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

    comment(ref, caller, { body, choices = [] }) {
      const { task, runId } = ownTask(ref, caller)
      return store.postComment({
        taskId: task.id,
        body,
        author: { kind: 'run', runId },
        ...(choices.length > 0 && { kind: 'question', choices }),
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

    brief(ref) {
      const task = find(ref)
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
          return task ? [{ request, task }] : []
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
        if (current?.answer) throw new RequestError(409, 'this request has already been answered')
        const at = new Date().toISOString()
        if (request.action === 'request-changes') {
          const answered = answerRequest(task, comment, { kind: 'changes-requested', at, text })
          await deliver(
            task,
            [
              `The human asked for changes at the ${gateName(comment)}:`,
              text,
              `The Task stays in ${stageTitle(comment.stage ?? '')}. Make the changes, write the Task brief again with \`ted brief write\`, then run \`ted outcome advance\`.`,
            ].join('\n\n'),
          )
          return answered
        }
        if (request.action === 'approve') {
          const answered = answerRequest(task, comment, {
            kind: 'approved',
            at,
            ...(text !== '' && { text }),
          })
          const now = find(task.id)
          const resolution = await workflows.resolve(factoryOf(now))
          const next = resolution.workflow.next(now.stage) as AgentStageId | 'done'
          await move(
            now,
            resolution,
            next,
            next === 'done'
              ? undefined
              : `The human approved the ${gateName(comment)}. ${nextStageMessage(resolution.workflow, next)}`,
          )
          return answered
        }
        const choice = request.choice
        const answered = answerRequest(task, comment, {
          kind: 'answered',
          at,
          ...(choice !== undefined && { choice }),
          ...(text !== '' && { text }),
        })
        await deliver(
          task,
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
            message: 'Asked the human. TED sends you their answer.',
            request,
          }
        }
        const resolution = await workflows.resolve(factoryOf(current))
        const { workflow } = resolution
        if (outcome.outcome === 'back') return sendBack(current, resolution, stage, outcome)
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

    async setupLog(ref, name) {
      const task = find(ref)
      if (!task.repos.some((r) => r.name === name)) {
        throw new RequestError(404, `${task.displayId} has no worktree for ${name}`)
      }
      return redactSecrets(await readFile(commandLog(task, 'setup', name), 'utf8').catch(() => ''))
    },

    async close() {
      stopping.abort()
      await Promise.all(background)
    },
  }
}

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
