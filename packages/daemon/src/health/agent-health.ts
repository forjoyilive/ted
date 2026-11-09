import {
  type AgentHealth,
  type AgentHealthState,
  type AgentKind,
  agentKinds,
  agentProblem,
  bannerId,
  type DaemonEvent,
  type FixCommand,
  pausedReason,
  runsPaused,
} from '@ted/protocol'
import type { Agents } from '../agents/index.ts'
import type { Banners } from '../banners.ts'
import { RequestError } from '../errors.ts'
import type { TedStore } from '../store/index.ts'
import { findExecutable, isBelow, runCli, versionIn } from './cli.ts'
import type { Environment } from './environment.ts'

export const healthIntervalMs = 10 * 60 * 1000
export const fixPollMs = 5_000
export const fixWatchMs = 10 * 60 * 1000
export const freshForMs = 30_000

export interface AgentHealthMonitor {
  list(): AgentHealth[]
  check(kinds?: readonly AgentKind[], options?: { reloadEnv?: boolean }): Promise<AgentHealth[]>
  ready(kind: AgentKind): Promise<boolean>
  authFailed(kind: AgentKind): void
  fix(kind: AgentKind): Promise<AgentHealth>
  onReady(listener: (kind: AgentKind) => void): void
  subscribe(listener: (event: DaemonEvent) => void): () => void
  close(): void
}

export interface AgentHealthOptions {
  agents: Agents
  environment: Environment
  store: TedStore
  banners: Banners
  home: string
  runEnv: () => NodeJS.ProcessEnv
  openTerminal: (command: string, env: NodeJS.ProcessEnv) => Promise<void>
  intervalMs?: number
  fixPollMs?: number
}

export function createAgentHealth(options: AgentHealthOptions): AgentHealthMonitor {
  const { agents, environment, store, banners, home } = options
  const latest = new Map<AgentKind, AgentHealth>()
  const checking = new Map<AgentKind, Promise<AgentHealth>>()
  const readyListeners = new Set<(kind: AgentKind) => void>()
  const listeners = new Set<(event: DaemonEvent) => void>()
  const watches = new Map<AgentKind, NodeJS.Timeout>()
  let closed = false

  const emit = (event: DaemonEvent) => {
    for (const listener of listeners) listener(event)
  }

  function withCount(health: AgentHealth): AgentHealth {
    return { ...health, pausedRuns: store.pausedRunCount(health.agent) }
  }

  function fixFor(kind: AgentKind, state: AgentHealthState): FixCommand | undefined {
    const spec = agents.get(kind).health
    if (state === 'not-installed') return { label: 'Install', command: spec.install }
    if (state === 'signed-out') return { label: 'Sign in', command: spec.signIn }
    if (state === 'too-old') return { label: 'Update', command: spec.update }
    return undefined
  }

  async function inspect(kind: AgentKind): Promise<AgentHealth> {
    const agent = agents.get(kind)
    const spec = agent.health
    const env = agent.environment(options.runEnv())
    const base = { agent: kind, minimumVersion: spec.minimumVersion, pausedRuns: 0 }
    const done = (state: AgentHealthState, extra: Partial<AgentHealth> = {}): AgentHealth => {
      const reason = pausedReason(kind, state)
      const fix = fixFor(kind, state)
      return {
        ...base,
        ...extra,
        state,
        ...(reason !== undefined && { reason }),
        ...(fix && { fix }),
        checkedAt: new Date().toISOString(),
      }
    }
    const binary = findExecutable(agent.binary, env)
    if (!binary) return done('not-installed')
    const cli = (args: string[]) => runCli(binary, args, { env, cwd: home })
    const versionRun = await cli(spec.versionArgs)
    const version = versionIn(versionRun.stdout) ?? versionIn(versionRun.stderr)
    const found = { path: binary, ...(version !== undefined && { version }) }
    if (version !== undefined && isBelow(version, spec.minimumVersion))
      return done('too-old', found)
    const auth = spec.auth(await cli(spec.authArgs))
    if (!auth.signedIn) return done('signed-out', found)
    return done('ready', { ...found, ...(auth.account !== undefined && { account: auth.account }) })
  }

  function showBanner(health: AgentHealth): void {
    const ref = { problem: agentProblem, subject: health.agent }
    const needed = health.state !== 'not-installed' || health.pausedRuns > 0
    if (health.state === 'ready' || !needed || health.reason === undefined) {
      banners.clear(ref)
      return
    }
    banners.raise({
      ...ref,
      severity: 'stops-work',
      text:
        health.pausedRuns > 0
          ? `${health.reason} · ${runsPaused(health.pausedRuns)}`
          : health.reason,
      action: { label: 'Fix' },
    })
  }

  function apply(health: AgentHealth): AgentHealth {
    const before = latest.get(health.agent)
    store.pauseAgent(health.agent, health.reason)
    const counted = withCount(health)
    latest.set(health.agent, counted)
    showBanner(counted)
    emit({ type: 'agent-health-changed', health: counted })
    if (counted.state === 'ready') {
      stopWatching(health.agent)
      const held = store.heldRuns().some((h) => h.agent === health.agent)
      if (before?.state !== 'ready' || held) {
        for (const listener of readyListeners) listener(health.agent)
      }
    }
    return counted
  }

  function checkOne(kind: AgentKind): Promise<AgentHealth> {
    let running = checking.get(kind)
    if (!running) {
      running = inspect(kind)
        .then((health) => (closed ? health : apply(health)))
        .finally(() => checking.delete(kind))
      checking.set(kind, running)
    }
    return running
  }

  async function check(
    kinds: readonly AgentKind[] = agentKinds,
    { reloadEnv = false }: { reloadEnv?: boolean } = {},
  ): Promise<AgentHealth[]> {
    if (reloadEnv) await environment.reload()
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
      checkOne(kind).catch((error: unknown) => console.error('agent health check failed:', error))
    }, options.fixPollMs ?? fixPollMs)
    timer.unref()
    watches.set(kind, timer)
  }

  const interval = setInterval(() => {
    check().catch((error: unknown) => console.error('agent health check failed:', error))
  }, options.intervalMs ?? healthIntervalMs)
  interval.unref()

  const unsubscribe = store.subscribe((event) => {
    if (event.type !== 'task-updated') return
    for (const health of latest.values()) {
      if (health.state === 'ready') continue
      const pausedRuns = store.pausedRunCount(health.agent)
      if (pausedRuns === health.pausedRuns) continue
      const counted = { ...health, pausedRuns }
      latest.set(health.agent, counted)
      showBanner(counted)
      emit({ type: 'agent-health-changed', health: counted })
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
    fix,
    onReady(listener) {
      readyListeners.add(listener)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close() {
      closed = true
      clearInterval(interval)
      for (const kind of [...watches.keys()]) stopWatching(kind)
      unsubscribe()
    },
  }
}
