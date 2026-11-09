import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import {
  type AgentKind,
  type AnswerAutomationRequest,
  type Automation,
  type AutomationDetail,
  type AutomationNow,
  type AutomationRequest,
  type AutomationRun,
  type AutomationSchedule,
  type AutomationTemplate,
  type AutomationTrigger,
  type CreateAutomationRequest,
  checkSchedule,
  describeSchedule,
  type EditAutomationRequest,
  type Effort,
  nextFirings,
  type QueuedForSlot,
  type RunSlots,
  type SchedulePreview,
  type SlotHolder,
} from '@ted/protocol'
import type { Agents } from '../agents/index.ts'
import type { Banners } from '../banners.ts'
import { RequestError } from '../errors.ts'
import type { AgentHealthMonitor } from '../health/agent-health.ts'
import type { IdleTimer } from '../idle.ts'
import type { RunManager } from '../runs/run-manager.ts'
import type { StoredAutomation, StoredFiring } from '../store/automations.ts'
import type { StoredFactory, TedStore } from '../store/index.ts'
import type { QueueEntry, QueueSource } from '../tasks/queue.ts'
import type { Caller } from '../tasks/tasks.ts'
import { resolveAgentChoices } from '../workflow/agent-choices.ts'
import { stageTitle } from '../workflow/workflow.ts'
import type { Workflows } from '../workflow/workflows.ts'
import { automationTemplates } from './templates.ts'

export interface AutomationQueue {
  addQueueSource(source: QueueSource): () => void
  slots(): Promise<RunSlots>
}

export interface AutomationsOptions {
  home: string
  store: TedStore
  runs: RunManager
  agents: Agents
  health: AgentHealthMonitor
  banners: Banners
  workflows: Workflows
  queue: AutomationQueue
  idle?: IdleTimer
  now?: () => number
  checkEveryMs?: number
  graceMs?: number
}

export interface Automations {
  templates(): readonly AutomationTemplate[]
  preview(schedule: AutomationSchedule, timeZone?: string): SchedulePreview
  list(factory?: string): Promise<Automation[]>
  detail(ref: string, factory?: string): Promise<AutomationDetail>
  create(input: CreateAutomationRequest, caller: Caller): Promise<Automation>
  edit(
    ref: string,
    input: EditAutomationRequest,
    caller: Caller,
    factory?: string,
  ): Promise<Automation>
  setOn(ref: string, on: boolean, caller: Caller, factory?: string): Promise<Automation>
  runNow(ref: string, caller: Caller, factory?: string): Promise<AutomationRun>
  retry(firingId: string, caller: Caller): Promise<AutomationRun>
  delete(ref: string, caller: Caller, factory?: string): Promise<void>
  removeFactory(factoryId: string): Promise<void>
  requests(): AutomationRequest[]
  comment(caller: Caller, input: { body: string; choices?: string[] }): AutomationRequest
  answer(id: string, input: AnswerAutomationRequest): Promise<AutomationRequest>
  runOf(runId: string): { automation: StoredAutomation; firing: StoredFiring } | undefined
  check(): void
  close(): void
}

export const automationFailingProblem = 'automation-failing'

const maxNameLength = 100
const failuresForBanner = 3
const recentTasksShown = 100

const refuseRun = (caller: Caller) => {
  if (caller.kind === 'run') throw new RequestError(403, 'Ask the human to change Automations')
}

const systemZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

function firstLine(text: string, max = 300): string {
  const line = text.split('\n').find((l) => l.trim() !== '') ?? ''
  const trimmed = line.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

export function createAutomations(options: AutomationsOptions): Automations {
  const { store, runs, agents, health, banners, workflows } = options
  const saved = store.automations
  const now = options.now ?? Date.now
  const checkEveryMs = options.checkEveryMs ?? 60_000
  const graceMs = options.graceMs ?? 2 * 60_000
  const iso = (ms: number) => new Date(ms).toISOString()
  const starting = new Set<string>()
  const limited = new Set<string>()
  let timer: NodeJS.Timeout | undefined
  let releaseIdle: (() => void) | undefined
  let closed = false

  const factoryOf = (automation: StoredAutomation) => store.getFactory(automation.factoryId)
  const live = () => saved.list().filter((a) => factoryOf(a) !== undefined)

  function find(ref: string, factory?: string): StoredAutomation {
    const inFactory = factory === undefined ? undefined : factoryByRef(factory)
    const candidates = live().filter((a) => !inFactory || a.factoryId === inFactory.id)
    const exact = candidates.find((a) => a.id === ref)
    if (exact) return exact
    const byPrefix = ref.length >= 6 ? candidates.filter((a) => a.id.startsWith(ref)) : []
    if (byPrefix.length === 1 && byPrefix[0]) return byPrefix[0]
    const byName = candidates.filter((a) => a.name.toLowerCase() === ref.toLowerCase())
    if (byName.length === 1 && byName[0]) return byName[0]
    if (byName.length > 1) {
      throw new RequestError(409, `more than one Automation is called “${ref}”; use its ID`)
    }
    throw new RequestError(404, `no Automation “${ref}”`)
  }

  function factoryByRef(ref: string): StoredFactory {
    const found = store
      .listFactories()
      .find((f) => f.key.toLowerCase() === ref.toLowerCase() || f.id === ref)
    if (!found) throw new RequestError(404, `no Factory with key ${ref}`)
    return found
  }

  function factoryFor(ref: string | undefined, caller: Caller): StoredFactory {
    if (ref !== undefined) return factoryByRef(ref)
    if (caller.kind === 'run') {
      const own = runOf(caller.runId)
      const factory = own && factoryOf(own.automation)
      if (factory) return factory
    }
    const all = store.listFactories()
    if (all.length === 1 && all[0]) return all[0]
    throw new RequestError(400, 'name the Factory with --factory <key>')
  }

  function runOf(runId: string) {
    const firing = saved.firing(runId)
    const automation = firing && saved.get(firing.automationId)
    return firing && automation ? { automation, firing } : undefined
  }

  const openQuestion = (firingId: string) =>
    saved
      .comments()
      .some((c) => c.firingId === firingId && c.kind === 'question' && c.answer === undefined)

  type Status = 'queued' | 'working' | 'waiting' | 'paused' | 'idle' | 'ended'

  function statusOf(firing: StoredFiring): Status {
    if (firing.state === 'queued') return 'queued'
    if (firing.state !== 'started') return 'ended'
    if (firing.resume === 'queued') return 'queued'
    const run = store.getRun(firing.id)
    if (!run) return 'queued'
    if (run.state === 'finished') return 'ended'
    if (run.state === 'waiting' || openQuestion(firing.id)) return 'waiting'
    if (limited.has(run.id) || store.agentPauses()[run.agent] !== undefined) return 'paused'
    return run.state
  }

  function previousRun(automationId: string): StoredFiring | undefined {
    return saved
      .firings(automationId)
      .findLast((f) => f.state === 'queued' || f.state === 'started')
  }

  function agentOf(firing: StoredFiring): AgentKind | undefined {
    return store.getRun(firing.id)?.agent ?? saved.get(firing.automationId)?.agent
  }

  function queuedFirings(): StoredFiring[] {
    const automationIds = new Set(live().map((a) => a.id))
    return saved
      .firings()
      .filter(
        (f) =>
          automationIds.has(f.automationId) &&
          !starting.has(f.id) &&
          (f.state === 'queued' || (f.state === 'started' && f.resume === 'queued')),
      )
  }

  const source: QueueSource = {
    queued() {
      return queuedFirings().flatMap((f): QueueEntry[] => {
        const automation = saved.get(f.automationId)
        return automation
          ? [
              {
                id: f.id,
                kind: 'automation',
                rank: Date.parse(f.at),
                factoryId: automation.factoryId,
              },
            ]
          : []
      })
    },
    runnable(id) {
      const firing = saved.firing(id)
      const agent = firing && agentOf(firing)
      return agent !== undefined && store.agentPauses()[agent] === undefined
    },
    begin(id) {
      if (starting.has(id)) return
      starting.add(id)
      launch(id)
        .catch((error: unknown) => console.error(`couldn’t start Automation Run ${id}:`, error))
        .finally(() => {
          starting.delete(id)
          pump()
        })
    },
    holders() {
      return saved.firings().flatMap((f): SlotHolder[] => {
        const automation = saved.get(f.automationId)
        if (!automation || !factoryOf(automation)) return []
        const run = store.getRun(f.id)
        const holds =
          starting.has(f.id) ||
          (f.state === 'started' && run?.state === 'working' && statusOf(f) === 'working')
        if (!holds) return []
        return [
          {
            kind: 'automation',
            runId: f.id,
            automationId: automation.id,
            name: automation.name,
            factoryId: automation.factoryId,
            runs: 1,
          },
        ]
      })
    },
    describe(id, place): QueuedForSlot | undefined {
      const firing = saved.firing(id)
      const automation = firing && saved.get(firing.automationId)
      if (!automation) return undefined
      return {
        kind: 'automation',
        place,
        runId: id,
        automationId: automation.id,
        name: automation.name,
        factoryId: automation.factoryId,
      }
    },
  }

  const pump = options.queue.addQueueSource(source)

  async function launch(id: string): Promise<void> {
    const firing = saved.firing(id)
    const automation = firing && saved.get(firing.automationId)
    const factory = automation && factoryOf(automation)
    if (!firing || !automation || !factory) {
      if (firing?.state === 'queued') saved.dropFiring(id)
      return
    }
    const env = { TED_AUTOMATION: automation.id, TED_FACTORY: factory.key }
    if (firing.state === 'started' && firing.resume === 'queued') {
      try {
        await runs.revive(id, {
          prompt:
            'Your process stopped before you finished, so TED resumed your session. Check where you were, then carry on with your instructions.',
          env,
        })
        saved.revived(id)
      } catch (error) {
        saved.revived(id)
        fail(firing, `Couldn’t resume: ${messageOf(error)}`)
      }
      return
    }
    if (firing.state !== 'queued') return
    try {
      const settings = (await workflows.resolve(factory, { fetch: false }).catch(() => undefined))
        ?.workflow.settings
      const cwd = path.join(options.home, 'automations', automation.id)
      await mkdir(cwd, { recursive: true, mode: 0o700 })
      const prompt = runPrompt(automation, factory, firing)
      saved.began(id)
      await runs.start({
        id,
        agent: automation.agent,
        prompt,
        cwd,
        name: automation.name,
        permissions: settings?.permissions === 'bypass' ? 'bypass' : 'auto',
        env,
        ...(automation.model !== undefined && { model: automation.model }),
        ...(automation.effort !== undefined && { effort: automation.effort }),
      })
    } catch (error) {
      const current = saved.firing(id)
      if (current?.state === 'started' && !store.getRun(id)) {
        fail(current, `Couldn’t start: ${messageOf(error)}`)
      } else if (current?.state === 'queued') {
        saved.began(id)
        fail(current, `Couldn’t start: ${messageOf(error)}`)
      }
    }
  }

  function runPrompt(
    automation: StoredAutomation,
    factory: StoredFactory,
    firing: StoredFiring,
  ): string {
    const repos = factory.repos.map((r) => r.repo)
    const why: Record<AutomationTrigger, string> = {
      scheduled: 'on its schedule',
      'made-up': `to make up firings missed while TED wasn’t running (the last was ${firing.slotAt ?? firing.at})`,
      'run-now': 'because the human chose Run now',
      retry: 'because the human chose Retry after a failed Run',
    }
    const tasks = store.listTasks()
    const created = saved
      .createdTasks(automation.id)
      .flatMap((link) => {
        const task = tasks.find((t) => t.id === link.taskId)
        return task ? [task] : []
      })
      .slice(-recentTasksShown)
    const lines = created.map((task) => {
      const state = task.archived
        ? 'archived'
        : task.stage === 'done'
          ? 'Done'
          : `open, in ${stageTitle(task.stage)}`
      const source = task.source?.url === undefined ? '' : ` · source ${task.source.url}`
      return `- ${task.displayId} · ${task.title.replace(/\s*\n\s*/g, ' ')} · ${state}${source}`
    })
    return [
      `# You are an Automation Run in TED`,
      [
        `You are “${automation.name}”, an Automation in the ${factory.name} Factory (repos: ${repos.join(', ')}). TED started this Run ${why[firing.trigger]}. You run outside any Task, usually to bring new work in as Tasks.`,
        '',
        '- Create a Task with `ted task create --source <URL of the item it came from> "<title>"`. Every Task you create needs `--source`. Add `--description "<text>"` for context, and `--start` only if your instructions say new Tasks should start; otherwise they wait in Backlog.',
        '- TED refuses a source it already tracks and says why. Leave those, except a Done Task whose problem came back: your instructions say when to create a Follow-up with `ted task create --follow-up <Task ID> --source <URL> "<title>"`.',
        '- `ted task list` lists the Tasks. `ted automation list`, `show` and `history` read Automations; you can’t change them.',
        '- To ask the human something, run `ted comment --choice "<answer>" … "<question>"` and end your turn; TED sends you their answer. `ted comment "<text>"` posts a note.',
        '- When you are done, end your turn with a short final message whose first line says what you did. TED stops this Run when you go idle with no open question.',
      ].join('\n'),
      `## Tasks this Automation has created\n\n${lines.length > 0 ? lines.join('\n') : 'None yet.'}`,
      `## Your instructions\n\n${automation.prompt.trim()}`,
    ].join('\n\n')
  }

  function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  function finalMessage(runId: string): string | undefined {
    const run = store.getRun(runId)
    if (!run) return undefined
    const entries = agents.get(run.agent).chat(store.conversation(run.id), run.cwd)
    const text = entries.findLast((e) => e.kind === 'agent')?.text
    return text === undefined ? undefined : firstLine(text) || undefined
  }

  function failuresInARow(automationId: string): number {
    let count = 0
    for (const firing of saved.firings(automationId).reverse()) {
      if (firing.outcome === 'failed') count++
      else if (firing.outcome === 'finished') break
    }
    return count
  }

  function noteFailures(automation: StoredAutomation): void {
    const ref = {
      problem: automationFailingProblem,
      factoryId: automation.factoryId,
      subject: automation.id,
    }
    const count = failuresInARow(automation.id)
    if (count >= failuresForBanner) {
      const error = saved.firings(automation.id).findLast((f) => f.outcome === 'failed')?.error
      banners.raise({
        ...ref,
        severity: 'warning',
        text: `Automation “${automation.name}” failed ${count} times in a row${error ? ` · last error: ${firstLine(error, 200)}` : ''}`,
        action: {
          label: 'Open the Automation',
          opens: {
            kind: 'automation',
            automationId: automation.id,
            factoryId: automation.factoryId,
          },
        },
      })
    } else banners.clear(ref)
  }

  function fail(firing: StoredFiring, error: string): void {
    saved.ended(firing.id, { outcome: 'failed', error: firstLine(error, 500) })
    const automation = saved.get(firing.automationId)
    if (automation) noteFailures(automation)
  }

  function settle(runId: string): void {
    if (closed) return
    const own = runOf(runId)
    if (own?.firing.state !== 'started') return
    const run = store.getRun(runId)
    if (run?.state !== 'idle') return
    if (limited.has(runId) || store.agentPauses()[run.agent] !== undefined) return
    if (openQuestion(own.firing.id)) return
    const message = finalMessage(runId)
    saved.ended(own.firing.id, { outcome: 'finished', ...(message !== undefined && { message }) })
    noteFailures(own.automation)
    runs.stop(runId).catch((error: unknown) => console.error(`couldn’t stop Run ${runId}:`, error))
  }

  function ended(runId: string, stopped: boolean, lastLines: readonly string[]): void {
    if (closed) return
    const own = runOf(runId)
    if (own?.firing.state !== 'started') return
    limited.delete(runId)
    const message = finalMessage(runId)
    if (stopped) {
      saved.ended(runId, { outcome: 'stopped', ...(message !== undefined && { message }) })
      return
    }
    const error =
      lastLines.findLast((l) => l.trim() !== '') ??
      'The agent’s process ended before it finished its turn.'
    const run = store.getRun(runId)
    if (own.firing.resume === undefined && run?.sessionId !== undefined) {
      saved.resumeQueued(runId, firstLine(error, 500))
      pump()
      return
    }
    fail(own.firing, error)
  }

  runs.observe({
    usage(run, signal) {
      if (!closed && signal.limited && runOf(run.id)) limited.add(run.id)
    },
    authFailed(run) {
      if (!closed && runOf(run.id)) limited.add(run.id)
    },
    settled(run) {
      setImmediate(() => settle(run.id))
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
    if (event.type === 'run-updated' && event.run.state === 'working') limited.delete(event.run.id)
    if (event.type === 'run-updated' && event.run.state === 'idle' && saved.firing(event.run.id)) {
      const runId = event.run.id
      setImmediate(() => settle(runId))
    }
    if (event.type === 'factory-added' || event.type === 'factory-updated') {
      setImmediate(() => {
        if (!closed) changed()
      })
    }
  })

  function dueSlots(automation: StoredAutomation, at: number): { count: number; last: number } {
    let after = Date.parse(automation.handledUntil)
    let count = 0
    let last = 0
    for (let batch = 0; batch < 50; batch++) {
      const next = nextFirings(automation.schedule, automation.timeZone, after, 500)
      const due = next.filter((t) => t <= at)
      count += due.length
      last = due.at(-1) ?? last
      if (due.length < next.length || next.length === 0) break
      after = last
    }
    return { count, last }
  }

  function check(): void {
    if (closed) return
    const at = now()
    let fired = false
    if (store.newWorkHold() === undefined) {
      for (const automation of live()) {
        if (!automation.on) continue
        const { count, last } = dueSlots(automation, at)
        if (count === 0) continue
        const trigger: AutomationTrigger =
          count === 1 && at - last <= graceMs ? 'scheduled' : 'made-up'
        const previous = previousRun(automation.id)
        const status = previous && statusOf(previous)
        saved.fire({
          automationId: automation.id,
          trigger,
          slotAt: iso(last),
          skipped: status === 'queued' || status === 'working' || status === 'paused',
          at: iso(at),
        })
        fired = true
      }
    }
    if (fired) pump()
    arm()
  }

  function arm(): void {
    clearTimeout(timer)
    timer = undefined
    if (closed) return
    const at = now()
    const next = live()
      .filter((a) => a.on)
      .flatMap((a) =>
        nextFirings(a.schedule, a.timeZone, Math.max(Date.parse(a.handledUntil), at - 1), 1),
      )
    if (next.length === 0) return
    const delay = Math.min(Math.max(Math.min(...next) - at, 0), checkEveryMs)
    timer = setTimeout(check, delay)
    timer.unref()
  }

  function holdIdle(): void {
    const want = live().some((a) => a.on)
    if (want && !releaseIdle) releaseIdle = options.idle?.hold()
    if (!want && releaseIdle) {
      releaseIdle()
      releaseIdle = undefined
    }
  }

  function changed(): void {
    holdIdle()
    arm()
  }

  function nowOf(
    firing: StoredFiring | undefined,
    place: (id: string) => number,
  ): AutomationNow | undefined {
    if (!firing) return undefined
    const status = statusOf(firing)
    if (status === 'queued') {
      const agent = agentOf(firing)
      const reason = agent === undefined ? undefined : store.agentPauses()[agent]
      return reason !== undefined
        ? { kind: 'paused', reason }
        : { kind: 'queued', place: place(firing.id) }
    }
    if (status === 'working' || status === 'idle') return { kind: 'working' }
    if (status === 'waiting') return { kind: 'waiting' }
    if (status === 'paused') {
      const agent = agentOf(firing)
      return {
        kind: 'paused',
        reason: (agent && store.agentPauses()[agent]) ?? 'usage limit',
      }
    }
    return undefined
  }

  function historyRow(firing: StoredFiring): AutomationRun {
    const tasks = store.listTasks()
    const created = saved
      .createdTasks(firing.automationId)
      .filter((link) => link.firingId === firing.id)
      .flatMap((link) => {
        const task = tasks.find((t) => t.id === link.taskId)
        return task
          ? [
              {
                id: task.id,
                displayId: task.displayId,
                title: task.title,
                stage: task.stage,
                ...(task.source?.url !== undefined && { source: task.source.url }),
              },
            ]
          : []
      })
    const result = ((): AutomationRun['result'] => {
      if (firing.state === 'skipped') return { kind: 'skipped' }
      if (firing.state === 'dropped') return { kind: 'dropped' }
      if (firing.state === 'queued') return { kind: 'queued' }
      if (firing.state === 'started') return { kind: 'running' }
      if (firing.outcome === 'failed') return { kind: 'failed', error: firing.error ?? '' }
      if (firing.outcome === 'stopped') return { kind: 'stopped' }
      return created.length > 0 ? { kind: 'created', tasks: created } : { kind: 'no-new-tasks' }
    })()
    return {
      id: firing.id,
      automationId: firing.automationId,
      trigger: firing.trigger,
      at: firing.at,
      result,
      ...(firing.slotAt !== undefined && { slotAt: firing.slotAt }),
      ...(firing.retryOf !== undefined && { retryOf: firing.retryOf }),
      ...(firing.retriedAt !== undefined && { retriedAt: firing.retriedAt }),
      ...(firing.startedAt !== undefined && { startedAt: firing.startedAt }),
      ...(firing.finishedAt !== undefined && { finishedAt: firing.finishedAt }),
      ...(created.length > 0 && { created }),
      ...(firing.message !== undefined && { message: firing.message }),
      ...(store.getRun(firing.id) && { runId: firing.id }),
    }
  }

  function describe(automation: StoredAutomation, slots: RunSlots | undefined): Automation {
    const factory = factoryOf(automation)
    const firings = saved.firings(automation.id)
    const last = firings.findLast((f) => f.state === 'ended' || f.state === 'skipped')
    const place = (id: string) =>
      slots?.queue.find((q) => q.kind === 'automation' && q.runId === id)?.place ?? 0
    const current = nowOf(previousRun(automation.id), place)
    const at = now()
    return {
      id: automation.id,
      factoryId: automation.factoryId,
      factoryKey: factory?.key ?? '',
      name: automation.name,
      prompt: automation.prompt,
      schedule: automation.schedule,
      timeZone: automation.timeZone,
      scheduleText: describeSchedule(automation.schedule, automation.timeZone),
      agent: automation.agent,
      ...(automation.model !== undefined && { model: automation.model }),
      ...(automation.effort !== undefined && { effort: automation.effort }),
      on: automation.on,
      ...(automation.template !== undefined && { template: automation.template }),
      createdAt: automation.createdAt,
      nextFirings: automation.on
        ? nextFirings(
            automation.schedule,
            automation.timeZone,
            Math.max(Date.parse(automation.handledUntil), at),
            3,
          ).map(iso)
        : [],
      ...(current && { now: current }),
      ...(last && { last: historyRow(last) }),
      failuresInARow: failuresInARow(automation.id),
      totals: {
        runs: firings.filter((f) => f.state === 'started' || f.state === 'ended').length,
        tasksCreated: saved.createdTasks(automation.id).length,
      },
    }
  }

  function toRequest(id: string): AutomationRequest {
    const comment = saved.comment(id)
    const automation = comment && saved.get(comment.automationId)
    if (!comment || !automation) throw new RequestError(404, `no request ${id}`)
    return {
      id: comment.id,
      automationId: automation.id,
      automationName: automation.name,
      factoryId: automation.factoryId,
      runId: comment.firingId,
      kind: comment.kind,
      body: comment.body,
      ...(comment.choices && { choices: comment.choices }),
      ...(comment.answer && { answer: comment.answer }),
      createdAt: comment.createdAt,
    }
  }

  function scheduleError(schedule: AutomationSchedule, timeZone: string): void {
    const error = checkSchedule(schedule, timeZone, now())
    if (error !== undefined) throw new RequestError(400, error)
  }

  function cleanName(name: string): string {
    const trimmed = name.trim()
    if (trimmed === '') throw new RequestError(400, 'an Automation needs a name')
    if (trimmed.length > maxNameLength) {
      throw new RequestError(400, `names are at most ${maxNameLength} characters`)
    }
    return trimmed
  }

  function cleanPrompt(prompt: string): string {
    if (prompt.trim() === '') throw new RequestError(400, 'an Automation needs a prompt')
    return prompt
  }

  async function defaultLead(factory: StoredFactory) {
    const settings = (await workflows.resolve(factory, { fetch: false }).catch(() => undefined))
      ?.workflow.settings
    return resolveAgentChoices(settings, {
      claude: agents.installed('claude'),
      codex: agents.installed('codex'),
    }).lead
  }

  function fireByHand(
    automation: StoredAutomation,
    trigger: AutomationTrigger,
    retryOf?: string,
  ): StoredFiring {
    if (store.newWorkHold() !== undefined) {
      throw new RequestError(409, 'New work is held while the disk is full')
    }
    const previous = previousRun(automation.id)
    const status = previous && statusOf(previous)
    if (status === 'queued' || status === 'working' || status === 'paused') {
      throw new RequestError(409, `“${automation.name}” is already running`)
    }
    const firing = saved.fire({
      automationId: automation.id,
      trigger,
      ...(retryOf !== undefined && { retryOf }),
      at: iso(now()),
    })
    pump()
    return firing
  }

  async function slotsNow(): Promise<RunSlots | undefined> {
    return options.queue.slots().catch(() => undefined)
  }

  for (const firing of saved.firings()) {
    if (firing.state !== 'started' || firing.resume === 'queued') continue
    const run = store.getRun(firing.id)
    if (!run) {
      fail(firing, 'TED stopped before this Run started.')
    } else if (run.state === 'finished') {
      ended(run.id, run.ended?.how === 'stopped', run.ended?.errorLines ?? [])
    } else if (run.state === 'idle') {
      setImmediate(() => settle(run.id))
    }
  }
  holdIdle()
  setImmediate(check)

  return {
    templates: () => automationTemplates,
    preview(schedule, timeZone = systemZone()) {
      const error = checkSchedule(schedule, timeZone, now())
      return {
        text: describeSchedule(schedule, timeZone),
        nextFirings: error === undefined ? nextFirings(schedule, timeZone, now(), 3).map(iso) : [],
        ...(error !== undefined && { error }),
      }
    },
    async list(factory) {
      const inFactory = factory === undefined ? undefined : factoryByRef(factory)
      const slots = await slotsNow()
      return live()
        .filter((a) => !inFactory || a.factoryId === inFactory.id)
        .map((a) => describe(a, slots))
    },
    async detail(ref, factory) {
      const automation = find(ref, factory)
      const slots = await slotsNow()
      return {
        automation: describe(automation, slots),
        history: saved
          .firings(automation.id)
          .map(historyRow)
          .sort((a, b) => b.at.localeCompare(a.at)),
        requests: saved.comments(automation.id).map((c) => toRequest(c.id)),
      }
    },
    async create(input, caller) {
      refuseRun(caller)
      const factory = factoryFor(input.factory, caller)
      const timeZone = input.timeZone ?? systemZone()
      scheduleError(input.schedule, timeZone)
      const lead = await defaultLead(factory)
      const agent = input.agent ?? lead.agent
      const same = agent === lead.agent
      const model = input.model ?? (same ? lead.model : undefined)
      const effort: Effort | undefined = input.effort ?? (same ? lead.effort : undefined)
      const automation = saved.create(
        {
          factoryId: factory.id,
          name: cleanName(input.name),
          prompt: cleanPrompt(input.prompt),
          schedule: input.schedule,
          timeZone,
          agent,
          ...(model !== undefined && { model }),
          ...(effort !== undefined && { effort }),
          on: input.on !== false,
          ...(input.template !== undefined && { template: input.template }),
        },
        iso(now()),
      )
      changed()
      if (input.runNow === true) fireByHand(automation, 'run-now')
      return describe(saved.get(automation.id) ?? automation, await slotsNow())
    },
    async edit(ref, input, caller, factory) {
      refuseRun(caller)
      const automation = find(ref, factory)
      const schedule = input.schedule ?? automation.schedule
      const timeZone = input.timeZone ?? automation.timeZone
      if (input.schedule !== undefined || input.timeZone !== undefined) {
        scheduleError(schedule, timeZone)
      }
      const agent = input.agent ?? automation.agent
      const keep = agent === automation.agent
      const model =
        input.model === null ? undefined : (input.model ?? (keep ? automation.model : undefined))
      const effort =
        input.effort === null ? undefined : (input.effort ?? (keep ? automation.effort : undefined))
      saved.edit(
        automation.id,
        {
          name: input.name === undefined ? automation.name : cleanName(input.name),
          prompt: input.prompt === undefined ? automation.prompt : cleanPrompt(input.prompt),
          schedule,
          timeZone,
          agent,
          ...(model !== undefined && { model }),
          ...(effort !== undefined && { effort }),
        },
        iso(now()),
      )
      if (input.on !== undefined && input.on !== automation.on) {
        switchOn(automation, input.on)
      }
      changed()
      return describe(saved.get(automation.id) ?? automation, await slotsNow())
    },
    async setOn(ref, on, caller, factory) {
      refuseRun(caller)
      const automation = find(ref, factory)
      if (automation.on !== on) switchOn(automation, on)
      changed()
      return describe(saved.get(automation.id) ?? automation, await slotsNow())
    },
    async runNow(ref, caller, factory) {
      refuseRun(caller)
      const automation = find(ref, factory)
      return historyRow(fireByHand(automation, 'run-now'))
    },
    async retry(firingId, caller) {
      refuseRun(caller)
      const firing = saved.firing(firingId)
      const automation = firing && saved.get(firing.automationId)
      if (!firing || !automation || !factoryOf(automation)) {
        throw new RequestError(404, `no Automation Run ${firingId}`)
      }
      const newestFailed = saved.firings(automation.id).findLast((f) => f.outcome === 'failed')
      if (firing.outcome !== 'failed' || newestFailed?.id !== firing.id) {
        throw new RequestError(409, 'only the newest failed Run can be retried')
      }
      if (firing.retriedAt !== undefined) {
        throw new RequestError(409, `this Run was already retried at ${firing.retriedAt}`)
      }
      return historyRow(fireByHand(automation, 'retry', firing.id))
    },
    async delete(ref, caller, factory) {
      refuseRun(caller)
      await remove(find(ref, factory))
    },
    async removeFactory(factoryId) {
      for (const automation of saved.list().filter((a) => a.factoryId === factoryId)) {
        await remove(automation)
      }
    },
    requests() {
      const ids = new Set(live().map((a) => a.id))
      return saved
        .comments()
        .filter((c) => ids.has(c.automationId) && c.kind === 'question' && c.answer === undefined)
        .map((c) => toRequest(c.id))
    },
    comment(caller, { body, choices }) {
      const own = caller.kind === 'run' ? runOf(caller.runId) : undefined
      if (!own) throw new RequestError(403, 'only an Automation Run can post here')
      if (own.firing.state !== 'started') throw new RequestError(409, 'this Run has finished')
      const comment = saved.postComment({
        automationId: own.automation.id,
        firingId: own.firing.id,
        kind: choices && choices.length > 0 ? 'question' : 'note',
        body,
        ...(choices && choices.length > 0 && { choices }),
      })
      return toRequest(comment.id)
    },
    async answer(id, { choice, text }) {
      const comment = saved.comment(id)
      if (comment?.kind !== 'question') throw new RequestError(404, `no question ${id}`)
      if (comment.answer) throw new RequestError(409, 'this question was already answered')
      if (choice !== undefined && !comment.choices?.includes(choice)) {
        throw new RequestError(400, `“${choice}” isn’t one of the choices`)
      }
      const answer = [choice, text?.trim()].filter((s) => s !== undefined && s !== '').join('\n\n')
      if (answer === '') throw new RequestError(400, 'give an answer: a choice or text')
      const run = store.getRun(comment.firingId)
      if (!run || run.state === 'finished') {
        throw new RequestError(409, 'this Run has stopped, so it can’t get your answer')
      }
      await runs.send(
        run.id,
        `The human answered your question “${firstLine(comment.body, 200)}”:\n\n${answer}`,
      )
      saved.answerComment(id, answer)
      return toRequest(id)
    },
    runOf,
    check,
    close() {
      closed = true
      clearTimeout(timer)
      unsubscribe()
      releaseIdle?.()
      releaseIdle = undefined
    },
  }

  async function remove(automation: StoredAutomation): Promise<void> {
    const open = saved
      .firings(automation.id)
      .filter((f) => f.state === 'started' && store.getRun(f.id)?.state !== 'finished')
    saved.delete(automation.id)
    banners.clear({
      problem: automationFailingProblem,
      factoryId: automation.factoryId,
      subject: automation.id,
    })
    for (const firing of open) {
      await runs.stop(firing.id).catch((error: unknown) => console.error(error))
    }
    changed()
    pump()
  }

  function switchOn(automation: StoredAutomation, on: boolean): void {
    saved.switch(automation.id, on, iso(now()))
    if (on) return
    for (const firing of saved.firings(automation.id)) {
      if (firing.state === 'queued' && !starting.has(firing.id)) saved.dropFiring(firing.id)
    }
  }
}
