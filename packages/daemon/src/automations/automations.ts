import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import {
  type AgentKind,
  type AnswerAutomationRequest,
  type Attachment,
  type Automation,
  type AutomationCheck,
  type AutomationCheckInput,
  type AutomationCheckRun,
  type AutomationDetail,
  type AutomationNow,
  type AutomationRequest,
  type AutomationRun,
  type AutomationRunOutput,
  type AutomationRunRow,
  type AutomationRunState,
  type AutomationSchedule,
  type AutomationTaskLink,
  type AutomationTemplate,
  type AutomationTrigger,
  type CheckAgentRun,
  type CreateAutomationRequest,
  checkSchedule,
  describeSchedule,
  type EditAutomationRequest,
  type Effort,
  effectiveTimeZone,
  isCommitId,
  nextFirings,
  type RunSlots,
  recentAutomationRunsMs,
  type SchedulePreview,
  systemTimeZone,
} from '@ted/protocol'
import { AgentDisabledError, agentStartHold } from '../agent-eligibility.ts'
import type { Agents } from '../agents/index.ts'
import type { Banners } from '../banners.ts'
import { type Clock, systemClock, type Timer } from '../clock.ts'
import { RequestError } from '../errors.ts'
import { promptGuidance } from '../guidance.ts'
import type { AgentHealthMonitor } from '../health/agent-health.ts'
import type { IdleTimer } from '../idle.ts'
import type { MemoryWatch } from '../memory-kills.ts'
import { redactSecrets } from '../redact.ts'
import type { RunManager } from '../runs/run-manager.ts'
import type { Sandbox } from '../sandbox.ts'
import type {
  AutomationTaskRecord,
  StoredAutomation,
  StoredAutomationComment,
  StoredCheckResult,
  StoredFiring,
} from '../store/automations.ts'
import type { StoredFactory, TedStore } from '../store/index.ts'
import type { CheckSlots } from '../tasks/check-slots.ts'
import { intakeLines } from '../tasks/intake.ts'
import {
  afterProcessEnded,
  queuedRunStatus,
  queuedRuns,
  type RunQueue,
  runLimits,
  startGuard,
} from '../tasks/queued-runs.ts'
import type { Caller, CheckFailureInput, Tasks } from '../tasks/tasks.ts'
import { messageOf } from '../text.ts'
import { resolveAgentChoices } from '../workflow/agent-choices.ts'
import { stageTitle } from '../workflow/workflow.ts'
import type { Workflows } from '../workflow/workflows.ts'
import { agentRunsAfter, checkAgentPrompt } from './check-agent.ts'
import {
  checkFailureText,
  failingTestFiles,
  planCheckFailures,
  sandboxSkipped,
} from './check-failures.ts'
import { createCheckouts } from './checkout.ts'
import { createAutomationDrafts } from './drafts.ts'
import {
  createScheduledChecks,
  memoryStopMessage,
  type ScheduledCheckResult,
} from './scheduled-checks.ts'
import { automationTemplates } from './templates.ts'

interface AutomationRecord {
  factoryKey: string
  firings: StoredFiring[]
  links: AutomationTaskRecord[]
}

export interface AutomationsOptions {
  home: string
  store: TedStore
  runs: RunManager
  agents: Agents
  health: AgentHealthMonitor
  banners: Banners
  workflows: Workflows
  queue: RunQueue
  apps: Pick<Tasks, 'setRunAppOwner' | 'stopRunApps'>
  reposDir: string
  sandbox: Sandbox
  env: () => NodeJS.ProcessEnv
  idle?: IdleTimer
  systemTimeZone?: () => string
  clock?: Clock
  now?: () => number
  checkEveryMs?: number
  draftTimeoutMs?: number
  graceMs?: number
  checkSlots?: CheckSlots
  libraryDir?: string
  checkFailed?: (
    input: CheckFailureInput,
  ) => Promise<{ created: readonly string[]; updated: readonly string[] }>
  busy?: () => Promise<boolean>
  memory?: MemoryWatch
  busyCheckEveryMs?: number
}

export interface Automations {
  drafts: ReturnType<typeof createAutomationDrafts>
  templates(): readonly AutomationTemplate[]
  preview(schedule: AutomationSchedule): SchedulePreview
  list(caller: Caller, factory?: string): Promise<Automation[]>
  detail(ref: string, caller: Caller, factory?: string): Promise<AutomationDetail>
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
  runList(caller: Caller): Promise<AutomationRunRow[]>
  startNow(firingId: string, caller: Caller): Promise<AutomationRunRow>
  stopRun(firingId: string, caller: Caller): Promise<AutomationRunRow>
  output(firingId: string, caller?: Caller): Promise<AutomationRunOutput>
  report(caller: Caller, summary: string): { reported: true }
  delete(ref: string, caller: Caller, factory?: string): Promise<void>
  removeFactory(factoryId: string): Promise<void>
  requests(): AutomationRequest[]
  comment(caller: Caller, input: { body: string; choices?: string[] }): AutomationRequest
  answer(id: string, input: AnswerAutomationRequest): Promise<AutomationRequest>
  runOf(runId: string): { automation: StoredAutomation; firing: StoredFiring } | undefined
  check(): void
  close(): Promise<void>
}

export const automationFailingProblem = 'automation-failing'

const maxNameLength = 100
export const defaultCheckTimeout = '2h'
export const defaultQuietWaitMs = 4 * 60 * 60_000

export function quietDeadline(
  firedAt: number,
  runBy: string | undefined,
  timeZone: string,
): number {
  if (runBy === undefined) return firedAt + defaultQuietWaitMs
  return (
    nextFirings({ kind: 'daily', at: runBy }, timeZone, firedAt, 1)[0] ??
    firedAt + defaultQuietWaitMs
  )
}

function clockText(iso: string, timeZone: string | undefined): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      ...(timeZone !== undefined && { timeZone }),
    }).format(new Date(iso))
  } catch {
    return iso
  }
}

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}
const failuresForBanner = 3
const recentTasksShown = 100

function checkoutPrompt(repos: readonly string[], commit: string | undefined): string {
  const at = commit === undefined ? '' : ` at ${commit.slice(0, 7)}`
  return [
    '## Your checkout',
    '',
    `Ted made a fresh copy of the default branch${at} for this Run (${repos.join(', ')}), copied the Factory’s local files into it and ran its setup. You work inside it. Edit files there if it helps, but never commit or push: Ted removes the copy and your changes when this Run ends.`,
    '',
    '- `ted run-app [<App>] [--repo <name>]` starts one of the Factory’s Apps from this copy and prints its URL. An iOS simulator App waits until a simulator slot is free, however long that takes.',
    '- `ted app list` shows the Apps and their state; `ted app log <App>` prints an App’s output.',
    '- `ted browser open <App> [--repo <name>]` opens a running web App you started in your own headless browser, which stays on that App’s address. Then `ted browser snapshot` prints the page and element references; `ted browser click <ref>`, `fill <ref> <text>`, `press <key>`, `navigate <path>`, `back`, `forward` and `reload` act on it. Take a new snapshot after each action; old references expire.',
    '- `ted browser resize <width>x<height>` sets the window size (such as 390x844) and `ted browser color-scheme light|dark` switches the page’s colour mode. `ted browser screenshot` saves the page on this Run, shows it on the Run page and prints a local PNG path you can pass to `ted task create --attach`.',
    '- Ted stops every App and closes the browser when this Run ends.',
  ].join('\n')
}

const refuseRun = (caller: Caller) => {
  if (caller.kind === 'run') throw new RequestError(403, 'Ask the human to change Automations')
}

function firstLine(text: string, max = 300): string {
  const line = text.split('\n').find((l) => l.trim() !== '') ?? ''
  const trimmed = line.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

export function createAutomations(options: AutomationsOptions): Automations {
  const { store, runs, agents, health, banners, workflows } = options
  const drafts = createAutomationDrafts(options)
  const saved = store.automations
  const clock = options.clock ?? systemClock
  const now = options.now ?? (() => clock.now())
  const checkEveryMs = options.checkEveryMs ?? 60_000
  const graceMs = options.graceMs ?? 2 * 60_000
  const iso = (ms: number) => new Date(ms).toISOString()
  const busy = options.busy ?? (async () => false)
  const busyCheckEveryMs = options.busyCheckEveryMs ?? 15_000
  type CheckPhase = 'quiet' | 'slot' | 'running'
  const checkRuns = new Map<
    string,
    { abort: AbortController; phase: CheckPhase; until?: string; done: Promise<void> }
  >()
  const checkOf = (automationId: string) => saved.check(automationId)
  const reportChecks = () => {
    const entries = [...checkRuns.values()]
    store.setScheduledChecks({
      running: entries.filter((e) => e.phase === 'running').length,
      waiting: entries.filter((e) => e.phase !== 'running').length,
    })
  }
  const unread = new Map<string, string[]>()
  let timer: Timer | undefined
  let releaseIdle: (() => void) | undefined
  let closed = false
  const limits = runLimits({
    store,
    runs,
    health,
    owns: (runId) => runOf(runId) !== undefined,
    isClosed: () => closed,
    ready: () => pump(),
  })
  const checkouts = createCheckouts({
    home: options.home,
    reposDir: options.reposDir,
    store,
    banners,
    workflows,
    sandbox: options.sandbox,
    env: options.env,
    stopApps: (runId) => options.apps.stopRunApps(runId),
  })
  const scheduledChecks =
    options.checkSlots && options.libraryDir !== undefined
      ? createScheduledChecks({
          home: options.home,
          store,
          checkSlots: options.checkSlots,
          checkouts,
          sandbox: options.sandbox,
          banners,
          libraryDir: options.libraryDir,
          env: options.env,
          ...(options.memory && { memory: options.memory }),
        })
      : undefined
  const checkoutLive = (runId: string) => saved.firing(runId)?.state === 'started'
  const release = (runId: string) => {
    void checkouts.release(runId)
  }
  const reattached = (async () => {
    for (const firing of saved.firings()) {
      if (firing.state !== 'started') continue
      const automation = saved.get(firing.automationId)
      const factory = automation && store.getFactory(automation.factoryId)
      const agentCheckout = automation?.check !== undefined && firing.agentPhase === 'started'
      if (!(automation?.checkout || agentCheckout) || !factory || !automation) continue
      await checkouts.restore({
        runId: firing.id,
        automationId: automation.id,
        name: automation.name,
        factory,
      })
    }
    await checkouts.sweep(checkoutLive)
  })().catch((error: unknown) => console.error('couldn’t reattach Automation checkouts:', error))
  options.apps.setRunAppOwner({
    ready: reattached,
    owns: (runId) => checkouts.get(runId) !== undefined,
    live: (runId) => checkoutLive(runId) && store.getRun(runId)?.state !== 'finished',
    appTask: (runId) => checkouts.appTask(runId),
  })

  const factoryOf = (automation: StoredAutomation) => store.getFactory(automation.factoryId)
  const live = () => {
    const factoryIds = new Set(store.listFactories().map((f) => f.id))
    return saved.list().filter((a) => factoryIds.has(a.factoryId))
  }

  const effectiveZone = () =>
    effectiveTimeZone(store.settings(), (options.systemTimeZone ?? systemTimeZone)())

  function reconcileZones(): StoredAutomation[] {
    const timeZone = effectiveZone()
    const all = live()
    const stale = all.filter((a) => a.timeZone !== timeZone)
    if (stale.length === 0) return all
    const at = iso(now())
    for (const automation of stale) {
      const { name, prompt, schedule, agent, model, effort, checkout } = automation
      saved.edit(
        automation.id,
        {
          name,
          prompt,
          schedule,
          agent,
          checkout,
          timeZone,
          ...(model !== undefined && { model }),
          ...(effort !== undefined && { effort }),
        },
        at,
      )
    }
    return live()
  }

  function find(ref: string, factory?: string): StoredAutomation {
    const all = reconcileZones()
    const inFactory = factory === undefined ? undefined : factoryByRef(factory)
    const candidates = all.filter((a) => !inFactory || a.factoryId === inFactory.id)
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

  function readScope(caller: Caller, factory: string | undefined): string | undefined {
    if (caller.kind !== 'run') return factory
    const own = runOf(caller.runId)?.automation.factoryId ?? taskFactoryOf(caller.runId)
    if (own === undefined) throw new RequestError(403, 'this Run can’t read Automations')
    if (factory !== undefined) {
      const named = store
        .listFactories()
        .find((f) => f.key.toLowerCase() === factory.toLowerCase() || f.id === factory)
      if (named?.id !== own) {
        throw new RequestError(403, 'a Run reads only its own Factory’s Automations')
      }
    }
    return own
  }

  function taskFactoryOf(runId: string): string | undefined {
    let run = store.getRun(runId)
    while (run && run.taskId === undefined && run.parentRunId !== undefined) {
      run = store.getRun(run.parentRunId)
    }
    return run?.taskId === undefined ? undefined : store.getTask(run.taskId)?.factoryId
  }

  function runOf(runId: string) {
    const firing = saved.firing(runId)
    const automation = firing && saved.get(firing.automationId)
    return firing && automation ? { automation, firing } : undefined
  }

  const openQuestion = (firing: StoredFiring) =>
    saved
      .comments(firing.automationId)
      .some((c) => c.firingId === firing.id && c.kind === 'question' && c.answer === undefined)

  type Status = 'queued' | 'working' | 'waiting' | 'paused' | 'idle' | 'ended'

  function statusOf(firing: StoredFiring): Status {
    if (firing.state === 'queued') return 'queued'
    if (firing.state !== 'started') return 'ended'
    if (checkOf(firing.automationId)) {
      if (checkRuns.has(firing.id)) return 'working'
      if (firing.agentPhase === undefined) return 'ended'
      if (firing.agentPhase === 'queued') return 'queued'
    }
    if (firing.resume === 'queued') return 'queued'
    const run = store.getRun(firing.id)
    const shared = queuedRunStatus(run, { waiting: openQuestion(firing), limits })
    if (shared !== undefined) return shared
    return run?.state === 'working' ? 'working' : 'idle'
  }

  function previousRun(
    automationId: string,
    firings: readonly StoredFiring[] = saved.firings(automationId),
  ): StoredFiring | undefined {
    return firings.findLast((f) => f.state === 'queued' || f.state === 'started')
  }

  const inQueue = (f: StoredFiring) => {
    if (starting.has(f.id) || (f.state !== 'queued' && f.state !== 'started')) return false
    if (!checkOf(f.automationId)) return f.state === 'queued' || f.resume === 'queued'
    return (
      f.state === 'started' &&
      (f.agentPhase === 'queued' || (f.agentPhase === 'started' && f.resume === 'queued'))
    )
  }

  function agentOf(firing: StoredFiring): AgentKind | undefined {
    return store.getRun(firing.id)?.agent ?? saved.get(firing.automationId)?.agent
  }

  function queuedFirings(): StoredFiring[] {
    const automationIds = new Set(live().map((a) => a.id))
    return saved.firings().filter((f) => automationIds.has(f.automationId) && inQueue(f))
  }

  const starting = startGuard('Automation Run')
  const startNow = new Set<string>()
  const { pump } = queuedRuns(options.queue, {
    kind: 'automation',
    starting,
    what: 'Automation Run',
    waiting() {
      return queuedFirings().flatMap((f) => {
        const automation = saved.get(f.automationId)
        return automation
          ? [
              {
                id: f.id,
                rank: Date.parse(f.at),
                factoryId: automation.factoryId,
                priority: automation.priority,
                ...(f.resume === 'queued' && { skipsBusy: true as const }),
                ...(startNow.has(f.id) && { pastLimits: true as const }),
              },
            ]
          : []
      })
    },
    runnable(id) {
      const firing = saved.firing(id)
      const agent = firing && agentOf(firing)
      const hold =
        agent === undefined
          ? 'its Provider is unknown'
          : (agentStartHold(store, agent, id) ?? store.agentPauses()[agent])
      if (hold !== undefined && firing?.agentPhase === 'queued' && !store.getRun(id)) {
        setImmediate(() => {
          void endCheckAgent(id, { why: `The agent Run couldn’t start: ${hold}` })
        })
      }
      return hold === undefined
    },
    launch(id) {
      startNow.delete(id)
      return launch(id)
    },
    candidates() {
      const shown = new Set(live().map((a) => a.id))
      return saved
        .firings()
        .filter((f) => shown.has(f.automationId))
        .map((f) => f.id)
    },
    holds(id) {
      const firing = saved.firing(id)
      return (
        firing?.state === 'started' &&
        store.getRun(id)?.state === 'working' &&
        statusOf(firing) === 'working'
      )
    },
    slot(id) {
      const firing = saved.firing(id)
      const automation = firing && saved.get(firing.automationId)
      return (
        automation && {
          runId: id,
          automationId: automation.id,
          name: automation.name,
          factoryId: automation.factoryId,
        }
      )
    },
  })

  async function launch(id: string): Promise<void> {
    reconcileZones()
    await store.persisted()
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
        if ((automation.checkout || automation.check) && !checkouts.get(id)) {
          await checkouts.restore({
            runId: id,
            automationId: automation.id,
            name: automation.name,
            factory,
          })
        }
        await runs.revive(id, {
          prompt:
            'Your process stopped before you finished, so Ted resumed your session. Check where you were, then carry on with your instructions.',
          env,
        })
        saved.revived(id)
      } catch (error) {
        saved.revived(id)
        fail(firing, `Couldn’t resume: ${messageOf(error)}`)
      }
      return
    }
    if (firing.state === 'started' && firing.agentPhase === 'queued') {
      await launchCheckAgent(firing, automation, factory, env)
      return
    }
    if (firing.state !== 'queued') return
    try {
      let cwd = path.join(options.home, 'automations', automation.id)
      let runEnv: Record<string, string> = env
      let checkoutLine: string | undefined
      if (automation.checkout) {
        const checkout = await checkouts.make({
          runId: id,
          automationId: automation.id,
          name: automation.name,
          factory,
        })
        cwd = checkout.cwd
        runEnv = { ...checkout.env, ...env }
        checkoutLine = checkoutPrompt(
          checkout.repos.map((r) => r.name),
          checkout.commit,
        )
      } else {
        await mkdir(cwd, { recursive: true, mode: 0o700 })
      }
      const prompt = runPrompt(automation, factory, firing, checkoutLine)
      await runs.start({
        onStarting: () => saved.began(id),
        id,
        agent: automation.agent,
        prompt,
        cwd,
        name: automation.name,
        permissions: 'auto',
        env: runEnv,
        ...(automation.model !== undefined && { model: automation.model }),
        ...(automation.effort !== undefined && { effort: automation.effort }),
      })
    } catch (error) {
      if (error instanceof AgentDisabledError) {
        release(id)
        return
      }
      const current = saved.firing(id)
      if (current?.state === 'started' && !store.getRun(id)) {
        fail(current, `Couldn’t start: ${messageOf(error)}`)
      } else if (current?.state === 'queued') {
        saved.began(id)
        fail(current, `Couldn’t start: ${messageOf(error)}`)
      }
    }
  }

  async function launchCheckAgent(
    firing: StoredFiring,
    automation: StoredAutomation,
    factory: StoredFactory,
    env: Record<string, string>,
  ): Promise<void> {
    const id = firing.id
    const check = automation.check
    const result = saved.checkResults([id]).get(id)
    if (!check || !result || !scheduledChecks) {
      await endCheckAgent(id, { why: 'Ted lost the check’s result before the agent Run started' })
      return
    }
    const held = store.newWorkHold()
    if (held !== undefined) {
      await endCheckAgent(id, { why: `The agent Run couldn’t start: ${held}` })
      return
    }
    try {
      const commit =
        result.agentCommit !== undefined && isCommitId(result.agentCommit)
          ? result.agentCommit
          : undefined
      const checkout = await checkouts.make({
        runId: id,
        automationId: automation.id,
        name: automation.name,
        factory,
        ...(commit !== undefined && { commit }),
      })
      const { log, tail } = await scheduledChecks.saved(automation.id, id)
      const tasks = createdBy(automation.id)
      const openTasks = saved.createdTasks(automation.id).flatMap((link) => {
        const task = tasks.get(link.taskId)
        return task && !task.archived && task.stage !== 'done' ? [task] : []
      })
      const prompt = checkAgentPrompt({
        name: automation.name,
        factoryName: factory.name,
        repos: checkout.repos.map((r) => r.name),
        command: check.command,
        timeout: check.timeout,
        state: checkOutcome(result),
        ...(result.exitCode !== undefined && { exitCode: result.exitCode }),
        duration: duration(result.durationMs),
        ranWhileBusy: result.ranWhileBusy,
        skipped: result.skipped,
        failing: result.failing,
        ...(commit !== undefined && { commit }),
        tail,
        log,
        startTasks: check.startTasks,
        openTasks: openTasks.slice(-recentTasksShown),
        instructions: automation.prompt,
        guidance: promptGuidance(store.settings()),
      })
      await runs.start({
        onStarting: () => saved.checkAgentStarted(id),
        id,
        agent: automation.agent,
        prompt,
        cwd: checkout.cwd,
        name: automation.name,
        permissions: 'auto',
        env: { ...checkout.env, ...env },
        ...(automation.model !== undefined && { model: automation.model }),
        ...(automation.effort !== undefined && { effort: automation.effort }),
      })
    } catch (error) {
      if (!store.getRun(id)) {
        await endCheckAgent(id, { why: `The agent Run couldn’t start: ${messageOf(error)}` })
      }
    }
  }

  function checkOutcome(result: StoredCheckResult): 'passed' | 'failed' | 'timed-out' {
    return result.state === 'passed' || result.state === 'timed-out' ? result.state : 'failed'
  }

  function checkAgentHold(automation: StoredAutomation): string | undefined {
    return (
      store.newWorkHold() ??
      agentStartHold(store, automation.agent) ??
      store.agentPauses()[automation.agent]
    )
  }

  async function mechanicalTasks(
    automation: StoredAutomation,
    firingId: string,
    result: {
      state: 'failed' | 'timed-out'
      exitCode?: number
      commit?: string
      failing: readonly string[]
      tail: string
      log: string
    },
  ): Promise<{ created: readonly string[]; updated: readonly string[] }> {
    const check = automation.check
    if (!check) return { created: [], updated: [] }
    const at = iso(now())
    const failures = planCheckFailures(automation.name, result.failing).map((plan) => {
      const text = checkFailureText({
        name: automation.name,
        command: check.command,
        state: result.state,
        ...(result.exitCode !== undefined && { exitCode: result.exitCode }),
        ...(result.commit !== undefined && { commit: result.commit }),
        plan,
        failing: result.failing,
        tail: result.tail,
        log: result.log,
        at,
      })
      return {
        key: plan.key,
        title: plan.title,
        description: text,
        note: `It failed again.\n\n${text}`,
      }
    })
    return (
      (await options.checkFailed?.({
        automationId: automation.id,
        firingId,
        factoryId: automation.factoryId,
        failures,
      })) ?? { created: [], updated: [] }
    )
  }

  const endingAgents = new Set<string>()

  async function endCheckAgent(
    firingId: string,
    end: { why?: string; stopped?: boolean },
  ): Promise<void> {
    if (closed || endingAgents.has(firingId)) return
    endingAgents.add(firingId)
    try {
      const own = runOf(firingId)
      if (own?.firing.state !== 'started') return
      const result = saved.checkResults([firingId]).get(firingId)
      const agentLine = store.getRun(firingId) ? finalMessage(firingId) : undefined
      let fallback: string | undefined
      if (result && result.agentReport === undefined && result.state !== 'passed') {
        fallback = end.why ?? 'The agent Run ended without reporting'
        const files = scheduledChecks
          ? await scheduledChecks.saved(own.automation.id, firingId)
          : { log: '', tail: '' }
        const recorded = await mechanicalTasks(own.automation, firingId, {
          state: result.state === 'timed-out' ? 'timed-out' : 'failed',
          ...(result.exitCode !== undefined && { exitCode: result.exitCode }),
          ...(result.agentCommit !== undefined && { commit: result.agentCommit }),
          failing: result.failing,
          tail: files.tail,
          log: files.log,
        })
        if (closed) return
        saved.checkFallbackApplied(firingId, firstLine(fallback, 500), recorded.updated)
      }
      const report = saved.checkResults([firingId]).get(firingId)?.agentReport
      const message =
        report !== undefined
          ? firstLine(report)
          : fallback !== undefined
            ? `${firstLine(fallback, 200)}, so Ted made its usual Tasks`
            : agentLine
      saved.ended(firingId, {
        outcome: end.stopped && fallback === undefined ? 'stopped' : 'finished',
        ...(message !== undefined && message !== '' && { message }),
      })
      release(firingId)
      noteFailures(own.automation)
    } finally {
      endingAgents.delete(firingId)
    }
  }

  function runPrompt(
    automation: StoredAutomation,
    factory: StoredFactory,
    firing: StoredFiring,
    checkout?: string,
  ): string {
    const repos = factory.repos.map((r) => r.repo)
    const why: Record<AutomationTrigger, string> = {
      scheduled: 'on its schedule',
      'made-up': `to make up firings missed while Ted wasn’t running (the last was ${firing.slotAt ?? firing.at})`,
      'run-now': 'because the human chose Run now',
      retry: 'because the human chose Retry after a failed Run',
    }
    const tasks = createdBy(automation.id)
    const created = saved
      .createdTasks(automation.id)
      .flatMap((link) => {
        const task = tasks.get(link.taskId)
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
    const [intake, githubIntake] = intakeLines(store, factory.id)
    return automationRunPrompt({
      name: automation.name,
      factoryName: factory.name,
      repos,
      why: why[firing.trigger],
      ...(checkout !== undefined && { checkout }),
      taskLines: lines,
      intake,
      githubIntake,
      instructions: automation.prompt,
      guidance: promptGuidance(store.settings()),
    })
  }

  function finalMessage(runId: string): string | undefined {
    const run = store.getRun(runId)
    if (!run) return undefined
    const entries = agents.get(run.agent).chat(runs.output.entries(run.id), run.cwd)
    const text = entries.findLast((e) => e.kind === 'agent')?.text
    return text === undefined ? undefined : firstLine(text) || undefined
  }

  function failuresInARow(
    automationId: string,
    firings: readonly StoredFiring[] = saved.firings(automationId),
  ): number {
    let count = 0
    for (const firing of firings.toReversed()) {
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
    if (firing.agentPhase !== undefined && checkOf(firing.automationId)) {
      void endCheckAgent(firing.id, { why: `The agent Run failed: ${firstLine(error, 300)}` })
      return
    }
    saved.ended(firing.id, { outcome: 'failed', error: firstLine(error, 500) })
    release(firing.id)
    const automation = saved.get(firing.automationId)
    if (automation) noteFailures(automation)
  }

  function settle(runId: string): void {
    if (closed) return
    const own = runOf(runId)
    if (own?.firing.state !== 'started') return
    const run = store.getRun(runId)
    if (run?.state !== 'idle') return
    if (limits.paused(run)) return
    if (openQuestion(own.firing)) return
    if ((unread.get(runId)?.length ?? 0) > 0) return
    if (own.automation.check) {
      void endCheckAgent(runId, {}).then(() =>
        runs
          .stop(runId)
          .catch((error: unknown) => console.error(`couldn’t stop Run ${runId}:`, error)),
      )
      return
    }
    const message = finalMessage(runId)
    saved.ended(own.firing.id, { outcome: 'finished', ...(message !== undefined && { message }) })
    release(own.firing.id)
    noteFailures(own.automation)
    runs.stop(runId).catch((error: unknown) => console.error(`couldn’t stop Run ${runId}:`, error))
  }

  function ended(runId: string, stopped: boolean, lastLines: readonly string[]): void {
    if (closed) return
    unread.delete(runId)
    const own = runOf(runId)
    if (own?.firing.state !== 'started') return
    limits.clear(runId)
    const message = finalMessage(runId)
    if (stopped && own.automation.check) {
      void endCheckAgent(runId, {
        stopped: true,
        why: 'The agent Run was stopped before it reported',
      })
      return
    }
    if (stopped) {
      saved.ended(runId, { outcome: 'stopped', ...(message !== undefined && { message }) })
      release(runId)
      return
    }
    const next = afterProcessEnded({
      stopped: false,
      run: store.getRun(runId),
      resumedBefore: own.firing.resume !== undefined,
      lastLines,
    })
    if ('resume' in next) {
      saved.resumeQueued(runId, firstLine(next.resume, 500))
      pump()
    } else if ('fail' in next) fail(own.firing, next.fail)
  }

  runs.observe({
    accepted(run, texts) {
      const waiting = unread.get(run.id)
      if (!waiting) return
      for (const text of texts) {
        const at = waiting.indexOf(text.trim())
        if (at !== -1) waiting.splice(at, 1)
      }
      if (waiting.length === 0) unread.delete(run.id)
    },
    settled(run) {
      setImmediate(() => settle(run.id))
    },
    finished(run, { stopped, lastLines }) {
      setImmediate(() => ended(run.id, stopped, lastLines))
    },
  })

  const unsubscribe = store.subscribe((event) => {
    if (closed) return
    if (event.type === 'settings-changed') {
      reconcileZones()
      changed()
    }
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
    reconcileZones()
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
    if (fired) {
      pump()
      startChecks()
    }
    arm()
  }

  function arm(): void {
    timer?.cancel()
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
    timer = clock.timeout(check, delay)
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

  function pause(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve()
      const timer = clock.timeout(() => {
        signal.removeEventListener('abort', stop)
        resolve()
      }, ms)
      timer.unref()
      const stop = () => {
        timer.cancel()
        resolve()
      }
      signal.addEventListener('abort', stop, { once: true })
    })
  }

  async function waitForQuiet(
    firing: StoredFiring,
    check: AutomationCheck,
    timeZone: string,
    entry: { abort: AbortController; phase: CheckPhase; until?: string },
  ): Promise<boolean> {
    if (firing.trigger === 'run-now' || firing.trigger === 'retry') return false
    const deadline = quietDeadline(Date.parse(firing.slotAt ?? firing.at), check.runBy, timeZone)
    while (!entry.abort.signal.aborted && !closed) {
      if (!(await busy())) return false
      const left = deadline - now()
      if (left <= 0) return true
      if (entry.phase !== 'quiet' || entry.until === undefined) {
        entry.phase = 'quiet'
        entry.until = iso(deadline)
        saved.touched(firing.automationId)
      }
      await pause(Math.min(busyCheckEveryMs, left), entry.abort.signal)
    }
    return false
  }

  function startChecks(): void {
    if (closed || !scheduledChecks) return
    for (const firing of saved.firings()) {
      if (firing.state !== 'queued' || checkRuns.has(firing.id)) continue
      const check = checkOf(firing.automationId)
      if (!check) continue
      const automation = saved.get(firing.automationId)
      const factory = automation && factoryOf(automation)
      if (!automation || !factory) {
        saved.dropFiring(firing.id)
        continue
      }
      const entry = {
        abort: new AbortController(),
        phase: 'quiet' as CheckPhase,
        done: Promise.resolve(),
      }
      checkRuns.set(firing.id, entry)
      reportChecks()
      const releaseIdle = options.idle?.hold()
      entry.done = runCheck(automation, factory, check, firing, entry)
        .catch((error: unknown) => {
          console.error(`a scheduled check of ${automation.name} failed:`, error)
          const current = saved.firing(firing.id)
          if (!closed && current && current.state !== 'dropped' && current.state !== 'ended') {
            fail(current, `Ted couldn’t run the check: ${messageOf(error)}`)
          }
        })
        .finally(() => {
          checkRuns.delete(firing.id)
          releaseIdle?.()
          reportChecks()
          if (!closed) saved.touched(firing.automationId)
        })
    }
  }

  async function runCheck(
    automation: StoredAutomation,
    factory: StoredFactory,
    check: AutomationCheck,
    firing: StoredFiring,
    entry: { abort: AbortController; phase: CheckPhase; until?: string },
  ): Promise<void> {
    const checks = scheduledChecks
    if (!checks) return
    const ranWhileBusy = await waitForQuiet(firing, check, automation.timeZone, entry)
    if (entry.abort.signal.aborted || closed || saved.firing(firing.id)?.state !== 'queued') return
    const held = store.newWorkHold()
    if (held !== undefined) {
      fail(firing, `Ted isn’t starting new work right now: ${held}`)
      return
    }
    entry.phase = 'slot'
    delete entry.until
    const result = await checks.run({
      automationId: automation.id,
      name: automation.name,
      factory,
      check,
      firingId: firing.id,
      signal: entry.abort.signal,
      onWaiting: (waiting) => {
        entry.phase = waiting ? 'slot' : 'running'
        reportChecks()
        saved.touched(automation.id)
      },
      onStarted: () => {
        entry.phase = 'running'
        reportChecks()
        saved.began(firing.id)
      },
    })
    if (closed) return
    await finishCheck(automation, check, firing.id, result, ranWhileBusy)
  }

  async function finishCheck(
    automation: StoredAutomation,
    check: AutomationCheck,
    firingId: string,
    result: ScheduledCheckResult,
    ranWhileBusy: boolean,
  ): Promise<void> {
    const firing = saved.firing(firingId)
    if (!firing || firing.state === 'dropped' || firing.state === 'ended') return
    if (firing.state === 'queued') saved.began(firingId)
    if (result.state === 'stopped') {
      saved.checkEnded(firingId, {
        outcome: 'stopped',
        ...(result.outOfMemory && { message: memoryStopMessage }),
      })
      return
    }
    const skipped = sandboxSkipped(result.output)
    const base = {
      state: result.state,
      ...(result.exitCode !== undefined && { exitCode: result.exitCode }),
      durationMs: result.durationMs,
      ranWhileBusy,
      skipped,
    }
    if (agentRunsAfter(check, result.state)) {
      const failing = result.state === 'passed' ? [] : failingTestFiles(result.output)
      saved.checkAgentQueued(firingId, { ...base, failing, updatedTaskIds: [] }, result.commit)
      const hold = checkAgentHold(automation)
      if (hold !== undefined) {
        await endCheckAgent(firingId, { why: `The agent Run couldn’t start: ${hold}` })
        return
      }
      pump()
      return
    }
    if (result.state === 'passed') {
      saved.checkEnded(
        firingId,
        { outcome: 'finished', message: `Passed in ${duration(result.durationMs)}` },
        { ...base, failing: [], updatedTaskIds: [] },
      )
      noteFailures(automation)
      return
    }
    if (result.state === 'setup-failed') {
      saved.checkEnded(
        firingId,
        {
          outcome: 'failed',
          error: `Couldn’t set up the worktree: ${firstLine(result.tail.split('\n').findLast((l) => l.trim() !== '') ?? 'see the output', 300)}`,
        },
        { ...base, failing: [], updatedTaskIds: [] },
      )
      noteFailures(automation)
      return
    }
    const failing = failingTestFiles(result.output)
    const recorded = await mechanicalTasks(automation, firingId, {
      state: result.state === 'timed-out' ? 'timed-out' : 'failed',
      ...(result.exitCode !== undefined && { exitCode: result.exitCode }),
      ...(result.commit !== undefined && { commit: result.commit }),
      failing,
      tail: result.tail,
      log: result.log,
    })
    if (closed) return
    saved.checkEnded(
      firingId,
      {
        outcome: 'finished',
        message: `${result.state === 'timed-out' ? `Timed out after ${check.timeout}` : 'Failed'} after ${duration(result.durationMs)}`,
      },
      { ...base, failing, updatedTaskIds: [...recorded.updated] },
    )
    noteFailures(automation)
  }

  function stopChecks(automationId: string): Promise<void>[] {
    const waits: Promise<void>[] = []
    for (const [firingId, entry] of checkRuns) {
      if (saved.firing(firingId)?.automationId !== automationId) continue
      entry.abort.abort()
      waits.push(entry.done)
    }
    return waits
  }

  function checkInput(given: AutomationCheckInput, before?: AutomationCheck): AutomationCheck {
    const runBy = given.runBy === null ? undefined : (given.runBy ?? before?.runBy)
    return {
      command: given.command,
      timeout: given.timeout ?? before?.timeout ?? defaultCheckTimeout,
      ...(runBy !== undefined && { runBy }),
      agentStep: given.agentStep ?? before?.agentStep ?? 'on-failure',
      startTasks: given.startTasks ?? before?.startTasks ?? false,
    }
  }

  function nowOf(
    firing: StoredFiring | undefined,
    place: (id: string) => number,
  ): AutomationNow | undefined {
    if (!firing) return undefined
    const status = statusOf(firing)
    const run = checkRuns.get(firing.id)
    if (run?.phase === 'quiet') {
      return {
        kind: 'paused',
        reason: `the computer is busy; runs anyway at ${run.until === undefined ? 'its cutoff' : clockText(run.until, saved.get(firing.automationId)?.timeZone)}`,
      }
    }
    if (run?.phase === 'slot') return { kind: 'paused', reason: 'waiting for a free check slot' }
    if (checkOf(firing.automationId) && firing.agentPhase === undefined) {
      if (status === 'queued') return { kind: 'queued', place: 1 }
      return status === 'working' ? { kind: 'working' } : undefined
    }
    if (status === 'queued') {
      const agent = agentOf(firing)
      const reason =
        agent === undefined
          ? undefined
          : (agentStartHold(store, agent, firing.id) ?? store.agentPauses()[agent])
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

  function createdBy(automationId: string) {
    const links = saved.createdTasks(automationId)
    const tasks = store.tasksIn(new Set(links.map((link) => link.taskId)))
    return new Map(tasks.map((task) => [task.id, task]))
  }

  function recordsOf(automations: readonly StoredAutomation[]): AutomationRecord[] {
    const keys = new Map(store.listFactories().map((f) => [f.id, f.key]))
    return automations.map((automation) => ({
      factoryKey: keys.get(automation.factoryId) ?? '',
      firings: saved.firings(automation.id),
      links: saved.createdTasks(automation.id),
    }))
  }

  function shownFiring(firingId: string): StoredFiring {
    const firing = saved.firing(firingId)
    const automation = firing && saved.get(firing.automationId)
    if (!firing || !automation || !factoryOf(automation)) {
      throw new RequestError(404, `no Automation Run ${firingId}`)
    }
    return firing
  }

  async function stopStarted(firingId: string): Promise<void> {
    const run = store.getRun(firingId)
    if (run && run.state !== 'finished') {
      await runs.stop(firingId)
      return
    }
    if (checkOf(saved.firing(firingId)?.automationId ?? '')) {
      await endCheckAgent(firingId, { stopped: true, why: 'The user stopped the agent Run' })
      return
    }
    saved.ended(firingId, { outcome: 'stopped' })
    release(firingId)
  }

  async function currentSlots(): Promise<RunSlots | undefined> {
    return options.queue.publishedSlots?.() ?? (await options.queue.slots().catch(() => undefined))
  }

  async function rowOf(firingId: string): Promise<AutomationRunRow> {
    const [row] = runRows(await currentSlots(), (f) => f.id === firingId, true)
    if (!row) throw new RequestError(404, `no Automation Run ${firingId}`)
    return row
  }

  function runRows(
    slots: RunSlots | undefined,
    wanted: (firing: StoredFiring) => boolean,
    anyAge = false,
  ): AutomationRunRow[] {
    const since = now() - recentAutomationRunsMs
    const automations = live()
    const records = recordsOf(automations)
    return automations.flatMap((automation, i) => {
      const record = records[i]
      if (!record) return []
      const firings = record.firings.filter(
        (f) =>
          wanted(f) &&
          (anyAge ||
            f.state === 'queued' ||
            f.state === 'started' ||
            Date.parse(f.finishedAt ?? f.at) >= since),
      )
      const rows = historyRows(firings, record.links)
      return firings.flatMap((firing, at) => {
        const run = rows[at]
        return run ? [runRow(automation, firing, run, slots)] : []
      })
    })
  }

  function runRow(
    automation: StoredAutomation,
    firing: StoredFiring,
    run: AutomationRun,
    slots: RunSlots | undefined,
  ): AutomationRunRow {
    const status = statusOf(firing)
    const check = checkRuns.get(firing.id)
    const scheduledCheck = automation.check !== undefined
    const current = nowOf(firing, (id) =>
      slots?.queue.find((q) => q.kind === 'automation' && q.runId === id)?.place ?? 0,
    )
    const state: AutomationRunState =
      check !== undefined && check.phase !== 'running'
        ? 'queued'
        : status === 'queued'
          ? 'queued'
          : status === 'waiting'
            ? 'waiting'
            : status === 'paused'
              ? 'paused'
              : firing.state === 'started'
                ? 'running'
                : 'ended'
    return {
      run,
      automationName: automation.name,
      factoryId: automation.factoryId,
      priority: automation.priority,
      state,
      ...(scheduledCheck && { scheduledCheck: true as const }),
      ...(check?.phase === 'running' && { checking: true as const }),
      ...(current?.kind === 'queued' && current.place > 0 && { place: current.place }),
      ...(current?.kind === 'paused' && { reason: current.reason }),
      ...(inQueue(firing) && { canStartNow: true as const }),
    }
  }

  function historyRows(
    firings: readonly StoredFiring[],
    links: readonly AutomationTaskRecord[],
  ): AutomationRun[] {
    const shown = new Set(firings.map((f) => f.id))
    const theirs = links.filter((link) => shown.has(link.firingId))
    const results = saved.checkResults(firings.map((f) => f.id))
    const actions = saved.taskActions(firings.map((f) => f.id))
    const tasks = saved.taskLinks([
      ...theirs.map((link) => link.taskId),
      ...[...results.values()].flatMap((r) => r.updatedTaskIds),
      ...[...actions.values()].flatMap((a) => [...a.noted, ...a.started]),
    ])
    const linksOf = (ids: readonly string[]) =>
      ids.flatMap((id) => {
        const task = tasks.get(id)
        return task ? [task] : []
      })
    const ran = saved.firingsWithRun(firings.map((f) => f.id))
    const screenshots = saved.browserCaptures(firings.map((f) => f.id))
    const created = new Map<string, AutomationTaskLink[]>()
    for (const link of theirs) {
      const task = tasks.get(link.taskId)
      if (!task) continue
      const known = created.get(link.firingId)
      if (known) known.push(task)
      else created.set(link.firingId, [task])
    }
    return firings.map((firing) => {
      const result = results.get(firing.id)
      const check: AutomationCheckRun | undefined = result && {
        state: result.state,
        ...(result.exitCode !== undefined && { exitCode: result.exitCode }),
        durationMs: result.durationMs,
        ...(result.ranWhileBusy && { ranWhileBusy: true as const }),
        ...(result.skipped.length > 0 && { skipped: result.skipped }),
        failing: result.failing,
        ...(result.updatedTaskIds.length > 0 && { updated: linksOf(result.updatedTaskIds) }),
        ...(firing.agentPhase !== undefined && {
          agent: agentOfFiring(firing, result, actions.get(firing.id), linksOf),
        }),
      }
      return historyRow(
        firing,
        created.get(firing.id) ?? [],
        ran.has(firing.id),
        check,
        screenshots.get(firing.id),
      )
    })
  }

  function agentOfFiring(
    firing: StoredFiring,
    result: StoredCheckResult,
    actions: { noted: string[]; started: string[] } | undefined,
    linksOf: (ids: readonly string[]) => AutomationTaskLink[],
  ): CheckAgentRun {
    const state: CheckAgentRun['state'] =
      firing.agentPhase === 'queued' && firing.state === 'started'
        ? 'queued'
        : firing.state === 'started'
          ? 'running'
          : result.agentReport !== undefined
            ? 'reported'
            : result.fallbackReason !== undefined
              ? 'fallback'
              : 'ended'
    const noted = linksOf(actions?.noted ?? [])
    const started = linksOf(actions?.started ?? [])
    return {
      state,
      ...(result.agentReport !== undefined && { report: result.agentReport }),
      ...(result.fallbackReason !== undefined && { fallback: result.fallbackReason }),
      ...(noted.length > 0 && { noted }),
      ...(started.length > 0 && { started }),
    }
  }

  function historyRowOf(firing: StoredFiring): AutomationRun {
    const [row] = historyRows([firing], saved.createdTasks(firing.automationId))
    return row ?? historyRow(firing, [], false)
  }

  function historyRow(
    firing: StoredFiring,
    created: AutomationTaskLink[],
    ran: boolean,
    check?: AutomationCheckRun,
    screenshots: Attachment[] = [],
  ): AutomationRun {
    const result = ((): AutomationRun['result'] => {
      if (firing.state === 'skipped') return { kind: 'skipped' }
      if (firing.state === 'dropped') return { kind: 'dropped' }
      if (firing.state === 'queued') return { kind: 'queued' }
      if (firing.state === 'started') return { kind: 'running' }
      if (firing.outcome === 'failed') return { kind: 'failed', error: firing.error ?? '' }
      if (firing.outcome === 'stopped') return { kind: 'stopped' }
      if (check?.state === 'passed') return { kind: 'passed' }
      if (check) return { kind: 'check-failed', tasks: created }
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
      ...(ran && { runId: firing.id }),
      ...(check && { check }),
      ...(screenshots.length > 0 && { screenshots }),
    }
  }

  function describe(
    automation: StoredAutomation,
    slots: RunSlots | undefined,
    { factoryKey, firings, links }: AutomationRecord,
  ): Automation {
    const last = firings.findLast((f) => f.state === 'ended' || f.state === 'skipped')
    const lastRow = last && historyRows([last], links)[0]
    const place = (id: string) =>
      slots?.queue.find((q) => q.kind === 'automation' && q.runId === id)?.place ?? 0
    const current = nowOf(previousRun(automation.id, firings), place)
    const at = now()
    const check = checkOf(automation.id)
    return {
      id: automation.id,
      factoryId: automation.factoryId,
      factoryKey,
      name: automation.name,
      prompt: automation.prompt,
      schedule: automation.schedule,
      timeZone: automation.timeZone,
      scheduleText: describeSchedule(
        automation.schedule,
        automation.timeZone,
        store.settings().timeFormat,
      ),
      agent: automation.agent,
      ...(automation.model !== undefined && { model: automation.model }),
      ...(automation.effort !== undefined && { effort: automation.effort }),
      on: automation.on,
      ...(automation.checkout && { checkout: true as const }),
      priority: automation.priority,
      ...(automation.template !== undefined && { template: automation.template }),
      ...(check !== undefined && { check }),
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
      ...(lastRow && { last: lastRow }),
      failuresInARow: failuresInARow(automation.id, firings),
      totals: {
        runs: firings.filter((f) => f.state === 'started' || f.state === 'ended').length,
        tasksCreated: links.length,
      },
    }
  }

  async function described(
    read: () => readonly StoredAutomation[],
  ): Promise<{ automation: Automation; record: AutomationRecord }[]> {
    const load = () => {
      const automations = read()
      return { automations, records: recordsOf(automations) }
    }
    let loaded = load()
    const queued = loaded.records.flatMap(({ firings }, i) => {
      const automation = loaded.automations[i]
      const current = automation && previousRun(automation.id, firings)
      return current && inQueue(current) ? [current.id] : []
    })
    let slots: RunSlots | undefined
    if (queued.length > 0) {
      const published = options.queue.publishedSlots?.()
      const lists = (id: string) =>
        published?.queue.some((q) => q.kind === 'automation' && q.runId === id) === true
      if (queued.every(lists)) slots = published
      else {
        slots = await options.queue.slots().catch(() => undefined)
        loaded = load()
      }
    }
    return loaded.automations.flatMap((automation, i) => {
      const record = loaded.records[i]
      return record ? [{ automation: describe(automation, slots, record), record }] : []
    })
  }

  async function describedOne(automation: StoredAutomation): Promise<Automation> {
    const [found] = await described(() => [saved.get(automation.id) ?? automation])
    if (!found) throw new RequestError(404, `no Automation “${automation.id}”`)
    return found.automation
  }

  function toRequest(
    comment: StoredAutomationComment,
    automation: StoredAutomation,
  ): AutomationRequest {
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

  function requestOf(id: string): AutomationRequest {
    const comment = saved.comment(id)
    const automation = comment && saved.get(comment.automationId)
    if (!comment || !automation) throw new RequestError(404, `no request ${id}`)
    return toRequest(comment, automation)
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
    return resolveAgentChoices(
      settings,
      {
        claude: agents.installed('claude'),
        antigravity: agents.installed('antigravity'),
        codex: agents.installed('codex'),
      },
      store.settings().enabledAgents,
    ).lead
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
    startChecks()
    return firing
  }

  for (const firing of saved.firings()) {
    if (firing.state !== 'started' || firing.resume === 'queued') continue
    if (checkOf(firing.automationId) && firing.agentPhase === undefined) {
      fail(firing, 'Ted stopped while this check ran.')
      continue
    }
    if (firing.agentPhase === 'queued') continue
    const run = store.getRun(firing.id)
    if (!run) {
      fail(firing, 'Ted stopped before this Run started.')
    } else if (run.state === 'finished') {
      ended(run.id, run.ended?.how === 'stopped', run.ended?.errorLines ?? [])
    } else if (run.state === 'idle') {
      setImmediate(() => settle(run.id))
    }
  }
  holdIdle()
  setImmediate(check)
  setImmediate(startChecks)

  return {
    templates: () => automationTemplates,
    preview(schedule) {
      reconcileZones()
      const timeZone = effectiveZone()
      const error = checkSchedule(schedule, timeZone, now())
      return {
        text: describeSchedule(schedule, timeZone, store.settings().timeFormat),
        nextFirings: error === undefined ? nextFirings(schedule, timeZone, now(), 3).map(iso) : [],
        ...(error !== undefined && { error }),
      }
    },
    async list(caller, given) {
      let reconciled: StoredAutomation[] | undefined = reconcileZones()
      const factory = readScope(caller, given)
      const inFactory = factory === undefined ? undefined : factoryByRef(factory)
      const shown = await described(() => {
        const all = reconciled ?? live()
        reconciled = undefined
        return all.filter((a) => !inFactory || a.factoryId === inFactory.id)
      })
      return shown.map(({ automation }) => automation)
    },
    async detail(ref, caller, factory) {
      const found = find(ref, readScope(caller, factory))
      let first: StoredAutomation | undefined = found
      const [shown] = await described(() => {
        const automation = first ?? saved.get(found.id) ?? found
        first = undefined
        return [automation]
      })
      if (!shown) throw new RequestError(404, `no Automation “${ref}”`)
      const { firings, links } = shown.record
      return {
        automation: shown.automation,
        history: historyRows(firings, links).sort((a, b) => b.at.localeCompare(a.at)),
        requests: saved.comments(found.id).map((c) => toRequest(c, found)),
      }
    },
    async create(input, caller) {
      refuseRun(caller)
      const factory = factoryFor(input.factory, caller)
      const lead = await defaultLead(factory)
      const timeZone = effectiveZone()
      scheduleError(input.schedule, timeZone)
      const agent = input.agent ?? lead.agent
      const same = agent === lead.agent
      const model = input.model ?? (same ? lead.model : undefined)
      const effort: Effort | undefined = input.effort ?? (same ? lead.effort : undefined)
      const check = input.check && checkInput(input.check)
      const automation = saved.create(
        {
          factoryId: factory.id,
          name: cleanName(input.name),
          prompt: check ? input.prompt : cleanPrompt(input.prompt),
          schedule: input.schedule,
          timeZone,
          agent,
          ...(model !== undefined && { model }),
          ...(effort !== undefined && { effort }),
          on: input.on !== false,
          checkout: input.checkout === true && !check,
          ...(input.priority !== undefined && { priority: input.priority }),
          ...(input.template !== undefined && !check && { template: input.template }),
        },
        iso(now()),
        check,
      )
      changed()
      if (input.runNow === true) fireByHand(automation, 'run-now')
      return describedOne(automation)
    },
    async edit(ref, input, caller, factory) {
      refuseRun(caller)
      const automation = find(ref, factory)
      const schedule = input.schedule ?? automation.schedule
      const timeZone = effectiveZone()
      if (input.schedule !== undefined) {
        scheduleError(schedule, timeZone)
      }
      const agent = input.agent ?? automation.agent
      const keep = agent === automation.agent
      const model =
        input.model === null ? undefined : (input.model ?? (keep ? automation.model : undefined))
      const effort =
        input.effort === null ? undefined : (input.effort ?? (keep ? automation.effort : undefined))
      const before = checkOf(automation.id)
      if (input.check !== undefined && !before) {
        throw new RequestError(400, 'an agent Automation can’t become a scheduled check')
      }
      const check = before && input.check ? checkInput(input.check, before) : undefined
      saved.edit(
        automation.id,
        {
          name: input.name === undefined ? automation.name : cleanName(input.name),
          prompt:
            input.prompt === undefined
              ? automation.prompt
              : before
                ? input.prompt
                : cleanPrompt(input.prompt),
          schedule,
          timeZone,
          agent,
          checkout: input.checkout ?? automation.checkout,
          ...(input.priority !== undefined && { priority: input.priority }),
          ...(model !== undefined && { model }),
          ...(effort !== undefined && { effort }),
        },
        iso(now()),
        check,
      )
      if (input.on !== undefined && input.on !== automation.on) {
        switchOn(automation, input.on)
      }
      changed()
      return describedOne(automation)
    },
    async setOn(ref, on, caller, factory) {
      refuseRun(caller)
      const automation = find(ref, factory)
      if (automation.on !== on) switchOn(automation, on)
      changed()
      return describedOne(automation)
    },
    async runNow(ref, caller, factory) {
      refuseRun(caller)
      const automation = find(ref, factory)
      return historyRowOf(fireByHand(automation, 'run-now'))
    },
    async runList(caller) {
      refuseRun(caller)
      return runRows(await currentSlots(), () => true)
    },
    async startNow(firingId, caller) {
      refuseRun(caller)
      const firing = shownFiring(firingId)
      if (!inQueue(firing)) throw new RequestError(409, 'this Run isn’t waiting for a slot')
      startNow.add(firing.id)
      pump()
      return rowOf(firing.id)
    },
    async stopRun(firingId, caller) {
      refuseRun(caller)
      const firing = shownFiring(firingId)
      const check = checkRuns.get(firing.id)
      const run = store.getRun(firing.id)
      if (check) {
        check.abort.abort()
        await check.done
      } else if (firing.state === 'queued') {
        startNow.delete(firing.id)
        if (!starting.has(firing.id)) saved.dropFiring(firing.id)
        else await starting.wait(firing.id)
        if (saved.firing(firing.id)?.state === 'started') await stopStarted(firing.id)
      } else if (firing.state === 'started') {
        startNow.delete(firing.id)
        if (firing.agentPhase === 'queued' && !run) {
          await endCheckAgent(firing.id, {
            stopped: true,
            why: 'The user stopped the agent Run before it started',
          })
        } else await stopStarted(firing.id)
      } else throw new RequestError(409, 'this Run has already ended')
      pump()
      return rowOf(firing.id)
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
      return historyRowOf(fireByHand(automation, 'retry', firing.id))
    },
    async output(firingId, caller = { kind: 'app' }) {
      if (caller.kind === 'run' && caller.runId !== firingId) {
        throw new RequestError(403, 'a Run reads only its own check output')
      }
      const firing = saved.firing(firingId)
      const automation = firing && saved.get(firing.automationId)
      if (!firing || !automation || !checkOf(automation.id) || !scheduledChecks) {
        throw new RequestError(404, `no scheduled check Run ${firingId}`)
      }
      return scheduledChecks.output(automation.id, firing.id)
    },
    async delete(ref, caller, factory) {
      refuseRun(caller)
      await remove(find(ref, factory))
    },
    async removeFactory(factoryId) {
      await drafts.removeFactory(factoryId)
      for (const automation of saved.list().filter((a) => a.factoryId === factoryId)) {
        await remove(automation)
      }
    },
    report(caller, summary) {
      const own = caller.kind === 'run' ? runOf(caller.runId) : undefined
      if (!own?.automation.check || own.firing.agentPhase === undefined) {
        throw new RequestError(403, 'only a scheduled check’s agent Run reports')
      }
      if (own.firing.state !== 'started') throw new RequestError(409, 'this Run has finished')
      saved.checkAgentReported(own.firing.id, redactSecrets(summary))
      return { reported: true }
    },
    requests() {
      const shown = new Map(live().map((a) => [a.id, a]))
      return saved.comments().flatMap((c) => {
        const automation = shown.get(c.automationId)
        return automation && c.kind === 'question' && c.answer === undefined
          ? [toRequest(c, automation)]
          : []
      })
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
      return toRequest(comment, own.automation)
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
      const message = `The human answered your question “${firstLine(comment.body, 200)}”:\n\n${answer}`
      unread.set(run.id, [...(unread.get(run.id) ?? []), message.trim()])
      try {
        await runs.send(run.id, message)
      } catch (error) {
        const waiting = unread.get(run.id)?.filter((text) => text !== message.trim()) ?? []
        if (waiting.length > 0) unread.set(run.id, waiting)
        else unread.delete(run.id)
        throw error
      }
      saved.answerComment(id, answer)
      return requestOf(id)
    },
    runOf,
    check,
    drafts,
    async close() {
      await drafts.close()
      await reattached
      closed = true
      for (const entry of checkRuns.values()) entry.abort.abort()
      await Promise.all([...checkRuns.values()].map((entry) => entry.done))
      timer?.cancel()
      unsubscribe()
      limits.close()
      releaseIdle?.()
      releaseIdle = undefined
    },
  }

  async function remove(automation: StoredAutomation): Promise<void> {
    await Promise.all(stopChecks(automation.id))
    const started = saved.firings(automation.id).filter((f) => f.state === 'started')
    const open = started.filter((f) =>
      checkOf(automation.id)
        ? f.agentPhase === 'started' && store.getRun(f.id)?.state !== 'finished'
        : store.getRun(f.id)?.state !== 'finished',
    )
    saved.delete(automation.id)
    await scheduledChecks
      ?.remove(automation.id)
      .catch((error: unknown) => console.error(`couldn’t remove a scheduled check’s files:`, error))
    banners.clear({
      problem: automationFailingProblem,
      factoryId: automation.factoryId,
      subject: automation.id,
    })
    for (const firing of open) {
      await runs.stop(firing.id).catch((error: unknown) => console.error(error))
    }
    for (const firing of started) await checkouts.release(firing.id)
    await checkouts.forget(automation.id)
    changed()
    pump()
  }

  function switchOn(automation: StoredAutomation, on: boolean): void {
    saved.switch(automation.id, on, iso(now()))
    if (on) return
    for (const firing of saved.firings(automation.id)) {
      if (firing.state !== 'queued' || starting.has(firing.id)) continue
      checkRuns.get(firing.id)?.abort.abort()
      saved.dropFiring(firing.id)
    }
  }
}

export function automationRunPrompt(input: {
  name: string
  factoryName: string
  repos: readonly string[]
  why: string
  checkout?: string
  taskLines: readonly string[]
  intake: string | undefined
  githubIntake: string | undefined
  instructions: string
  guidance: readonly string[]
}): string {
  return [
    `# You are an Automation Run in Ted`,
    ...input.guidance,
    [
      `You are “${input.name}”, an Automation in the ${input.factoryName} Factory (repos: ${input.repos.join(', ')}). Ted started this Run ${input.why}. You run outside any Task, usually to bring new work in as Tasks.`,
      '',
      '- Create a Task with `ted task create --source <URL of the item it came from> "<title>"`. Every Task you create needs `--source`. Add `--description "<text>"` for context, and `--start` only if your instructions say new Tasks should start; otherwise they wait in Backlog.',
      '- Ted refuses a source it already tracks and says why. Leave those, except a Done Task whose problem came back: your instructions say when to create a Follow-up with `ted task create --follow-up <Task ID> --source <URL> "<title>"`.',
      '- `ted task list` lists the Tasks. `ted automation list`, `show` and `history` read Automations; you can’t change them.',
      '- To ask the human something, run `ted comment --choice "<answer>" … "<question>"` and end your turn; Ted sends you their answer. `ted comment "<text>"` posts a note.',
      '- When you are done, end your turn with a short final message whose first line says what you did. Ted stops this Run when you go idle with no open question.',
    ].join('\n'),
    ...(input.checkout === undefined ? [] : [input.checkout]),
    `## Tasks this Automation has created\n\n${input.taskLines.length > 0 ? input.taskLines.join('\n') : 'None yet.'}`,
    input.intake,
    input.githubIntake,
    `## Your instructions\n\n${input.instructions.trim()}`,
  ].join('\n\n')
}
