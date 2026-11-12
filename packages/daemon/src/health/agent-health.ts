import {
  type AgentHealth,
  type AgentHealthState,
  type AgentKind,
  agentKinds,
  agentProblem,
  agentShortNames,
  bannerId,
  type DaemonEvent,
  type FixCommand,
  offlineProblem,
  type PlanUsage,
  type PlanWindow,
  pausedReason,
  resetTime,
  runsPaused,
  usageLimitProblem,
} from '@ted/protocol'
import type { CredentialReport } from '../agents/agent.ts'
import type { Agents } from '../agents/index.ts'
import { compareVersions } from '../backups.ts'
import type { Banners } from '../banners.ts'
import { findBinSync } from '../cli-env.ts'
import type { Environment } from '../command-env.ts'
import { RequestError } from '../errors.ts'
import type { TedStore } from '../store/index.ts'
import type { OpenTerminal } from '../terminal.ts'
import { runCli, versionIn } from './cli.ts'

export const healthIntervalMs = 10 * 60 * 1000
export const fixPollMs = 5_000
export const fixWatchMs = 10 * 60 * 1000
export const freshForMs = 30_000
export const limitProbeMs = 15 * 60 * 1000
const resetMarginMs = 5_000
const usageAgeEveryMs = 60_000

export interface AgentHealthMonitor {
  list(): AgentHealth[]
  check(kinds?: readonly AgentKind[], options?: { reloadEnv?: boolean }): Promise<AgentHealth[]>
  ready(kind: AgentKind): Promise<boolean>
  authFailed(kind: AgentKind): void
  limited(kind: AgentKind, resetsAt?: string): void
  usable(kind: AgentKind): void
  credentialReported(kind: AgentKind, report: CredentialReport): boolean
  planUsage(kind: AgentKind, windows: readonly PlanWindow[]): void
  setOnline(online: boolean): void
  fix(kind: AgentKind): Promise<AgentHealth>
  onReady(listener: (kind: AgentKind) => void): void
  onPaused(listener: (kind: AgentKind, state: AgentHealthState) => void): void
  onProbe(listener: (kind: AgentKind) => boolean): void
  onVersion(listener: (kind: AgentKind, version: string) => void): void
  close(): void
}

export interface AgentHealthOptions {
  agents: Agents
  environment: Environment
  store: TedStore
  banners: Banners
  home: string
  runEnv: () => NodeJS.ProcessEnv
  openTerminal: OpenTerminal
  emit?: (event: DaemonEvent) => void
  intervalMs?: number
  fixPollMs?: number
  probeAfterMs?: number
}

interface Limit {
  resetsAt?: string
  timer: NodeJS.Timeout
}

export function createAgentHealth(options: AgentHealthOptions): AgentHealthMonitor {
  const { agents, environment, store, banners, home } = options
  const probeAfterMs = options.probeAfterMs ?? limitProbeMs
  const inspected = new Map<AgentKind, AgentHealth>()
  const latest = new Map<AgentKind, AgentHealth>()
  const checking = new Map<AgentKind, Promise<AgentHealth>>()
  const readyListeners = new Set<(kind: AgentKind) => void>()
  const pausedListeners = new Set<(kind: AgentKind, state: AgentHealthState) => void>()
  const probeListeners = new Set<(kind: AgentKind) => boolean>()
  const versionListeners = new Set<(kind: AgentKind, version: string) => void>()
  const watches = new Map<AgentKind, NodeJS.Timeout>()
  const limits = new Map<AgentKind, Limit>()
  const wrongKeys = new Map<AgentKind, string | undefined>()
  const usage = new Map<AgentKind, PlanUsage>()
  const usageTimers = new Map<AgentKind, NodeJS.Timeout>()
  const usageReads = new Set<AbortController>()
  let offline = false
  let closed = false

  const emit = (event: DaemonEvent) => options.emit?.(event)
  const announced = new Map<AgentKind, { shown: string; usageAt: number }>()
  const shownAs = (health: AgentHealth) =>
    JSON.stringify({ ...health, planUsage: health.planUsage && { ...health.planUsage, at: '' } })
  const announce = (health: AgentHealth) => {
    announced.set(health.agent, {
      shown: shownAs(health),
      usageAt: health.planUsage ? Date.parse(health.planUsage.at) : 0,
    })
    emit({ type: 'agent-health-changed', health })
  }
  const billing = (kind: AgentKind) => store.settings().billing[kind]

  function fixFor(kind: AgentKind, state: AgentHealthState): FixCommand | undefined {
    const spec = agents.get(kind).health
    if (state === 'not-installed') return { label: 'Install', command: spec.install }
    if (state === 'signed-out' || state === 'wrong-credential') {
      return { label: 'Sign in', command: spec.signIn(options.runEnv()) }
    }
    if (state === 'too-old') return { label: 'Update', command: spec.update }
    return undefined
  }

  async function inspect(kind: AgentKind): Promise<AgentHealth> {
    const agent = agents.get(kind)
    const spec = agent.health
    const env = agent.environment(options.runEnv(), billing(kind))
    const base = { agent: kind, minimumVersion: spec.minimumVersion, pausedRuns: 0 }
    const done = (state: AgentHealthState, extra: Partial<AgentHealth> = {}): AgentHealth => ({
      ...base,
      ...extra,
      state,
      checkedAt: new Date().toISOString(),
    })
    const binary = findBinSync(agent.binary, env)
    if (!binary) return done('not-installed')
    const cli = (args: string[]) => runCli(binary, args, { env, cwd: home })
    const versionRun = await cli(spec.versionArgs)
    const version = versionIn(versionRun.stdout) ?? versionIn(versionRun.stderr)
    const found = { path: binary, ...(version !== undefined && { version }) }
    if (version !== undefined && compareVersions(version, spec.minimumVersion) < 0)
      return done('too-old', found)
    const auth = spec.inspect
      ? await spec.inspect({ binary, env, cwd: home, billing: billing(kind) })
      : spec.auth(await cli(spec.authArgs))
    if (auth.problem) return done('unavailable', { ...found, ...auth.problem })
    if (!auth.signedIn) return done('signed-out', found)
    const account = { ...found, ...(auth.account !== undefined && { account: auth.account }) }
    if (auth.billing === 'api-key' && billing(kind) === 'subscription') {
      return done('wrong-credential', account)
    }
    return done('ready', account)
  }

  function compose(kind: AgentKind): AgentHealth | undefined {
    const found = inspected.get(kind)
    if (!found) return undefined
    const limit = limits.get(kind)
    const wrongKey = wrongKeys.has(kind)
    const state: AgentHealthState =
      found.state !== 'ready'
        ? found.state
        : wrongKey
          ? 'wrong-credential'
          : offline
            ? 'offline'
            : limit
              ? 'usage-limit'
              : 'ready'
    const reason =
      state === 'unavailable'
        ? found.reason
        : pausedReason(kind, state, limit?.resetsAt, store.settings())
    const fix = state === 'unavailable' ? found.fix : fixFor(kind, state)
    const keySource = wrongKeys.get(kind)
    const plan = usage.get(kind)
    const { reason: _, fix: __, limitResetsAt: ___, keySource: ____, ...rest } = found
    return {
      ...rest,
      state,
      ...(reason !== undefined && { reason }),
      ...(fix && { fix }),
      ...(state === 'usage-limit' &&
        limit?.resetsAt !== undefined && {
          limitResetsAt: limit.resetsAt,
        }),
      ...(state === 'wrong-credential' && {
        keySource: agents.get(kind).keyHelp(keySource),
      }),
      ...(plan && { planUsage: plan }),
      pausedRuns: store.pausedRunCount(kind),
    }
  }

  function showBanners(health: AgentHealth): void {
    const ref = { problem: agentProblem, subject: health.agent }
    const limitRef = { problem: usageLimitProblem, subject: health.agent }
    const count = health.pausedRuns > 0 ? ` · ${runsPaused(health.pausedRuns)}` : ''
    if (health.state === 'usage-limit') {
      const resets =
        health.limitResetsAt !== undefined
          ? ` · resets ${resetTime(health.limitResetsAt, undefined, store.settings())}`
          : ''
      banners.raise({
        ...limitRef,
        severity: 'stops-work',
        text: `${agentShortNames[health.agent]} usage limit${resets}${count}`,
        action: { label: 'Open', opens: { kind: 'settings', section: 'agents' } },
      })
    } else banners.clear(limitRef)
    const agentState = !['ready', 'usage-limit', 'offline'].includes(health.state)
    const needed = health.state !== 'not-installed' || health.pausedRuns > 0
    if (!agentState || !needed || health.reason === undefined) {
      banners.clear(ref)
      return
    }
    banners.raise({
      ...ref,
      severity: 'stops-work',
      text: `${health.reason}${count}`,
      action:
        health.state === 'wrong-credential' || !health.fix
          ? { label: 'Fix', opens: { kind: 'settings', section: 'agents' } }
          : { label: 'Fix', section: 'agents' },
    })
  }

  function showOffline(): void {
    const ref = { problem: offlineProblem }
    if (!offline) {
      banners.clear(ref)
      return
    }
    const paused = agentKinds.reduce((sum, kind) => sum + store.pausedRunCount(kind), 0)
    banners.raise({
      ...ref,
      severity: 'stops-work',
      text:
        paused > 0
          ? `You’re offline · ${runsPaused(paused)} until the connection returns`
          : 'You’re offline · Runs wait until the connection returns',
    })
  }

  function publish(kind: AgentKind): AgentHealth | undefined {
    const before = latest.get(kind)
    const health = compose(kind)
    if (!health) return undefined
    store.pauseAgent(kind, health.reason)
    const counted = { ...health, pausedRuns: store.pausedRunCount(kind) }
    latest.set(kind, counted)
    showBanners(counted)
    showOffline()
    announce(counted)
    if (counted.state === 'ready') {
      const held = store.heldRuns().some((h) => h.agent === kind)
      if (before?.state !== 'ready' || held) {
        for (const listener of readyListeners) listener(kind)
      }
    } else if (before?.state !== counted.state) {
      for (const listener of pausedListeners) listener(kind, counted.state)
    }
    return counted
  }

  function apply(health: AgentHealth): AgentHealth {
    inspected.set(health.agent, health)
    const { version } = health
    if (version !== undefined)
      for (const listener of versionListeners) listener(health.agent, version)
    if (health.state === 'ready') stopWatching(health.agent)
    return publish(health.agent) ?? health
  }

  function scheduleUsage(kind: AgentKind): void {
    clearTimeout(usageTimers.get(kind))
    usageTimers.delete(kind)
    if (closed || !agents.get(kind).readPlanUsage) return
    const resets = (usage.get(kind)?.windows ?? [])
      .flatMap((window) => (window.resetsAt ? [Date.parse(window.resetsAt)] : []))
      .filter((at) => at + resetMarginMs > Date.now())
    if (!resets.length) return
    const delay = Math.min(Math.min(...resets) + resetMarginMs - Date.now(), 2_147_483_647)
    const timer = setTimeout(
      () => {
        usageTimers.delete(kind)
        const active = checking.get(kind)
        void (async () => {
          if (active) await active.catch(() => undefined)
          if (!closed) await checkOne(kind)
        })().catch((error: unknown) => console.error('agent health check failed:', error))
      },
      Math.max(1, delay),
    )
    timer.unref()
    usageTimers.set(kind, timer)
  }

  async function refreshUsage(kind: AgentKind, health: AgentHealth): Promise<void> {
    const agent = agents.get(kind)
    if (
      closed ||
      offline ||
      health.state !== 'ready' ||
      wrongKeys.has(kind) ||
      billing(kind) !== 'subscription' ||
      !agent.readPlanUsage ||
      !health.path
    )
      return
    const before = usage.get(kind)
    const controller = new AbortController()
    usageReads.add(controller)
    try {
      const windows = await agent.readPlanUsage({
        binary: health.path,
        env: agent.environment(options.runEnv(), billing(kind)),
        cwd: home,
        signal: controller.signal,
      })
      if (
        closed ||
        offline ||
        billing(kind) !== 'subscription' ||
        wrongKeys.has(kind) ||
        usage.get(kind) !== before ||
        windows === undefined
      )
        return
      usage.set(kind, { windows, at: new Date().toISOString(), from: 'read' })
      publish(kind)
    } catch {
      // Usage is best-effort; a failed read must not pause work or refresh its timestamp.
    } finally {
      usageReads.delete(controller)
      scheduleUsage(kind)
    }
  }

  function checkOne(kind: AgentKind): Promise<AgentHealth> {
    let running = checking.get(kind)
    if (!running) {
      running = inspect(kind)
        .then(async (health) => {
          if (closed) return health
          apply(health)
          await refreshUsage(kind, health)
          return latest.get(kind) ?? health
        })
        .finally(() => checking.delete(kind))
      checking.set(kind, running)
    }
    return running
  }

  async function check(
    kinds: readonly AgentKind[] = agentKinds,
    { reloadEnv = false }: { reloadEnv?: boolean } = {},
  ): Promise<AgentHealth[]> {
    if (reloadEnv) {
      await environment.reload()
      for (const kind of kinds) wrongKeys.delete(kind)
    }
    return Promise.all(kinds.map(checkOne))
  }

  function stopWatching(kind: AgentKind): void {
    const timer = watches.get(kind)
    if (timer) clearInterval(timer)
    watches.delete(kind)
  }

  function watch(kind: AgentKind): void {
    stopWatching(kind)
    const startedAt = Date.now()
    const timer = setInterval(() => {
      if (Date.now() - startedAt > fixWatchMs) return stopWatching(kind)
      const reload =
        inspected.get(kind)?.state === 'not-installed' ? environment.reload() : undefined
      Promise.resolve(reload)
        .then(() => checkOne(kind))
        .catch((error: unknown) => console.error('agent health check failed:', error))
    }, options.fixPollMs ?? fixPollMs)
    timer.unref()
    watches.set(kind, timer)
  }

  function clearLimit(kind: AgentKind): void {
    const limit = limits.get(kind)
    if (!limit) return
    clearTimeout(limit.timer)
    limits.delete(kind)
    publish(kind)
  }

  function probe(kind: AgentKind): void {
    const limit = limits.get(kind)
    if (!limit || closed) return
    if (compose(kind)?.state !== 'usage-limit') {
      limit.timer = setTimeout(() => probe(kind), probeAfterMs)
      limit.timer.unref()
      return
    }
    const tried = [...probeListeners].some((listener) => listener(kind))
    if (!tried) {
      clearLimit(kind)
      return
    }
    limit.timer = setTimeout(() => probe(kind), probeAfterMs)
    limit.timer.unref()
  }

  function limited(kind: AgentKind, reported?: string): void {
    if (closed) return
    const current = limits.get(kind)
    const known = current?.resetsAt
    const resetsAt =
      reported ?? (known !== undefined && Date.parse(known) > Date.now() ? known : undefined)
    if (current) clearTimeout(current.timer)
    const resetsIn = resetsAt === undefined ? undefined : Date.parse(resetsAt) - Date.now()
    const timer =
      resetsIn === undefined
        ? setTimeout(() => probe(kind), probeAfterMs)
        : setTimeout(() => clearLimit(kind), Math.max(0, resetsIn) + resetMarginMs)
    timer.unref()
    limits.set(kind, { ...(resetsAt !== undefined && { resetsAt }), timer })
    const before = latest.get(kind)
    if (before?.state === 'usage-limit' && before.limitResetsAt === resetsAt) return
    if (inspected.has(kind)) publish(kind)
    else void checkOne(kind).catch((error: unknown) => console.error(error))
  }

  const interval = setInterval(() => {
    check().catch((error: unknown) => console.error('agent health check failed:', error))
  }, options.intervalMs ?? healthIntervalMs)
  interval.unref()

  let displayedAs = JSON.stringify([store.settings().timeFormat, store.settings().timeZone])
  let billedAs = JSON.stringify(store.settings().billing)
  const unsubscribe = store.subscribe((event) => {
    if (event.type === 'settings-changed') {
      const display = JSON.stringify([event.settings.timeFormat, event.settings.timeZone])
      if (display !== displayedAs) {
        displayedAs = display
        for (const kind of agentKinds) publish(kind)
      }
      const now = JSON.stringify(event.settings.billing)
      if (now === billedAs) return
      billedAs = now
      for (const kind of agentKinds) {
        if (billing(kind) === 'api-key' && wrongKeys.has(kind)) wrongKeys.delete(kind)
      }
      void check().catch((error: unknown) => console.error('agent health check failed:', error))
      return
    }
    if (event.type !== 'task-updated') return
    for (const health of latest.values()) {
      if (health.state === 'ready') continue
      const pausedRuns = store.pausedRunCount(health.agent)
      if (pausedRuns === health.pausedRuns) continue
      const counted = { ...health, pausedRuns }
      latest.set(health.agent, counted)
      showBanners(counted)
      showOffline()
      announce(counted)
    }
  })

  banners.onAction(agentProblem, async (banner) => {
    const subject = agentKinds.find(
      (k) => banner.id === bannerId({ problem: agentProblem, subject: k }),
    )
    if (subject) await fix(subject)
  })

  async function fix(kind: AgentKind): Promise<AgentHealth> {
    const health = latest.get(kind) ?? (await checkOne(kind))
    if (!health.fix) throw new RequestError(409, `${health.reason ?? 'This agent'} needs no fix`)
    await options
      .openTerminal(health.fix.command, environment.current())
      .catch((error: unknown) => {
        throw new RequestError(409, error instanceof Error ? error.message : String(error))
      })
    watch(kind)
    return health
  }

  return {
    list: () => agentKinds.flatMap((kind) => latest.get(kind) ?? []),
    check,
    async ready(kind) {
      const known = latest.get(kind)
      const fresh =
        known?.state === 'ready' && Date.now() - Date.parse(known.checkedAt) < freshForMs
      return fresh || (await checkOne(kind)).state === 'ready'
    },
    authFailed(kind) {
      checkOne(kind).catch((error: unknown) => console.error('agent health check failed:', error))
    },
    limited,
    usable(kind) {
      clearLimit(kind)
    },
    credentialReported(kind, report) {
      if (report.billing !== 'api-key' || billing(kind) !== 'subscription') return false
      if (wrongKeys.has(kind) && wrongKeys.get(kind) === report.source) return true
      wrongKeys.set(kind, report.source)
      if (inspected.has(kind)) publish(kind)
      else void checkOne(kind).catch((error: unknown) => console.error(error))
      return true
    },
    planUsage(kind, windows) {
      const before = usage.get(kind)
      const merged = new Map((before?.windows ?? []).map((w) => [w.window, w]))
      for (const window of windows) merged.set(window.window, window)
      usage.set(kind, {
        windows: [...merged.values()].sort((a, b) => a.window.localeCompare(b.window)),
        at: new Date().toISOString(),
        from: kind === 'codex' ? 'read' : 'run',
      })
      scheduleUsage(kind)
      const known = latest.get(kind)
      if (!known) return
      const updated = { ...known, planUsage: usage.get(kind) as PlanUsage }
      latest.set(kind, updated)
      const last = announced.get(kind)
      const aged = Date.parse(updated.planUsage.at) - (last?.usageAt ?? 0) >= usageAgeEveryMs
      if (last?.shown === shownAs(updated) && !aged) return
      announce(updated)
    },
    setOnline(online) {
      if (offline === !online || closed) return
      offline = !online
      showOffline()
      for (const kind of agentKinds) publish(kind)
    },
    fix,
    onReady(listener) {
      readyListeners.add(listener)
    },
    onPaused(listener) {
      pausedListeners.add(listener)
    },
    onProbe(listener) {
      probeListeners.add(listener)
    },
    onVersion(listener) {
      versionListeners.add(listener)
    },
    close() {
      closed = true
      clearInterval(interval)
      for (const controller of usageReads) controller.abort()
      for (const timer of usageTimers.values()) clearTimeout(timer)
      usageTimers.clear()
      for (const kind of [...watches.keys()]) stopWatching(kind)
      for (const limit of limits.values()) clearTimeout(limit.timer)
      limits.clear()
      unsubscribe()
    },
  }
}
