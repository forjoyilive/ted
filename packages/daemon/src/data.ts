import path from 'node:path'
import type {
  Backup,
  BackupsSummary,
  DaemonEvent,
  DataStatus,
  RestoreBackupRequest,
  RestoreBackupResult,
} from '@ted/protocol'
import { tedPaths } from '@ted/protocol'
import type { Automations } from './automations/automations.ts'
import { type Backups, compareVersions, createBackups, displayPath } from './backups.ts'
import type { Banners } from './banners.ts'
import type { CheckTries } from './check-tries.ts'
import type { DiskWatch } from './disk.ts'
import type { Editors } from './editors.ts'
import { RequestError } from './errors.ts'
import type { FactoryRemovals } from './factory-removal.ts'
import type { FactorySettings } from './factory-settings.ts'
import type { Factories } from './factory-setup.ts'
import type { AgentHealthMonitor } from './health/agent-health.ts'
import type { Integrations } from './integrations.ts'
import type { LibrarySettings } from './library-settings.ts'
import type { Plans } from './plans/plans.ts'
import { redactSecrets } from './redact.ts'
import type { Conversations } from './runs/conversations.ts'
import type { RunManager } from './runs/run-manager.ts'
import type { Shells } from './shells.ts'
import type { Storage } from './storage.ts'
import { checkStore, readStoreMeta, removeStaleStateFiles, writeStoreMeta } from './store/files.ts'
import { openStore, type TedStore } from './store/index.ts'
import type { Tasks } from './tasks/tasks.ts'
import { plural } from './text.ts'
import type { Workflows } from './workflow/workflows.ts'

export interface Services {
  store: TedStore
  automations: Automations
  plans: Plans
  runs: RunManager
  tasks: Tasks
  banners: Banners
  workflows: Workflows
  health: AgentHealthMonitor
  integrations: Integrations
  disk: DiskWatch
  storage: Storage
  factories: Factories
  factorySettings: FactorySettings
  factoryRemovals: FactoryRemovals
  checkTries: CheckTries
  library: LibrarySettings
  conversations: Conversations
  shells: Shells
  editors: Editors
}

export interface StartedServices extends Omit<Services, 'store'> {
  close(): Promise<void>
}

export interface DataOptions {
  home: string
  version: string
  startServices: (store: TedStore, emit: (event: DaemonEvent) => void) => Promise<StartedServices>
  onStatus?: (status: DataStatus) => void
  now?: () => Date
  dailyCheckMs?: number
  progressEveryMs?: number
}

export interface Data {
  status(): DataStatus
  services(): Promise<Services>
  summary(): Promise<BackupsSummary>
  restore(request: RestoreBackupRequest): Promise<RestoreBackupResult>
  subscribe(listener: (event: DaemonEvent) => void): () => void
  open(): Promise<void>
  close(): Promise<void>
}

const dailyBackupProblem = 'daily-backup-failed'

export function majorMinor(version: string): string {
  return version.split('.').slice(0, 2).join('.')
}

export function createData(options: DataOptions): Data {
  const paths = tedPaths(options.home)
  const { version } = options
  const now = options.now ?? (() => new Date())
  const backups: Backups = createBackups({ home: options.home, version, now })
  const listeners = new Set<(event: DaemonEvent) => void>()
  const emit = (event: DaemonEvent) => {
    for (const listener of listeners) listener(event)
  }

  let status: DataStatus = { state: 'opening' }
  let services: (Services & { close(): Promise<void>; unsubscribe(): void }) | undefined
  const firstOpen = Promise.withResolvers<void>()
  let opening: Promise<void> = firstOpen.promise
  let busy = false
  let dailyTimer: NodeJS.Timeout | undefined
  let lastProgressAt = 0

  const setStatus = (next: DataStatus) => {
    status = next
    options.onStatus?.(next)
    emit({ type: 'data-status', status: next })
  }

  async function takeDaily(): Promise<void> {
    const open = services
    if (!open) return
    try {
      await backups.takeDaily(open.store.exportEventlog())
      open.banners.clear({ problem: dailyBackupProblem })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      console.error(`daily backup failed: ${reason}`)
      open.banners.raise({
        problem: dailyBackupProblem,
        severity: 'warning',
        text: `Today’s backup failed: ${reason}`,
        action: { label: 'Open', opens: { kind: 'settings', section: 'storage' } },
      })
    }
  }

  async function failedStatus(
    error: string,
    progress?: { done: number; total: number },
  ): Promise<DataStatus> {
    const restore = await backups.newestPreUpdate(version).catch(() => undefined)
    return {
      state: 'failed',
      version,
      error: redactSecrets(error),
      ...progress,
      ...(restore && { restore }),
    }
  }

  async function openData({ backUp }: { backUp: boolean }): Promise<void> {
    const meta = await readStoreMeta(paths.store)
    const check = await checkStore(paths.store)
    if (check.kind === 'newer') {
      const restore = await backups.newestPreUpdate(version).catch(() => undefined)
      setStatus({
        state: 'needs-newer',
        version,
        ...(meta && compareVersions(meta.lastOpenedBy, version) > 0
          ? { lastOpenedBy: meta.lastOpenedBy }
          : {}),
        dataDir: displayPath(paths.home),
        ...(restore && { restore }),
      })
      console.error(`the store has events this TED doesn't know: ${check.unknownEvents.join(', ')}`)
      return
    }

    const rebuilding = check.kind === 'rebuild'
    let progress = { done: 0, total: rebuilding ? check.events : 0 }
    const startedAt = Date.now()
    if (rebuilding) {
      if (backUp && !(await alreadyBackedUp(meta?.lastOpenedBy))) {
        try {
          await backups.takePreUpdate(meta?.lastOpenedBy)
        } catch (error) {
          setStatus(
            await failedStatus(
              `Couldn’t copy the data before updating: ${error instanceof Error ? error.message : String(error)}`,
            ),
          )
          return
        }
      }
      setStatus(updating(progress, startedAt))
    }

    let store: TedStore
    try {
      store = await openStore({
        directory: paths.store,
        onProgress: (next) => {
          progress = next
          const at = Date.now()
          if (next.done === next.total || at - lastProgressAt >= (options.progressEveryMs ?? 100)) {
            lastProgressAt = at
            setStatus(updating(next, startedAt))
          }
        },
      })
    } catch (error) {
      console.error('opening the store failed:', error)
      setStatus(
        await failedStatus(
          error instanceof Error ? error.message : String(error),
          rebuilding ? progress : undefined,
        ),
      )
      return
    }

    await writeStoreMeta(paths.store, { lastOpenedBy: version, lastOpenedAt: now().toISOString() })
    if (rebuilding) await removeStaleStateFiles(paths.store)
    const started = await options.startServices(store, emit)
    const unsubscribeStore = store.subscribe(emit)
    const unsubscribeTasks = started.tasks.subscribe(emit)
    services = {
      store,
      ...started,
      unsubscribe: () => {
        unsubscribeStore()
        unsubscribeTasks()
      },
    }
    setStatus({ state: 'ready' })
    await takeDaily()
  }

  async function alreadyBackedUp(dataFrom: string | undefined): Promise<boolean> {
    const newest = (await backups.list().catch(() => [])).find((b) => b.kind === 'pre-update')
    return newest !== undefined && newest.takenBy === version && newest.dataFrom === dataFrom
  }

  function updating(progress: { done: number; total: number }, startedAt: number): DataStatus {
    const elapsed = (Date.now() - startedAt) / 1000
    const secondsLeft =
      progress.done > 0
        ? Math.round((elapsed / progress.done) * (progress.total - progress.done))
        : undefined
    return {
      state: 'updating',
      version,
      done: progress.done,
      total: progress.total,
      ...(secondsLeft !== undefined && { secondsLeft }),
      backupsDir: `${displayPath(backups.dir)}${path.sep}`,
    }
  }

  async function closeServices(): Promise<void> {
    const open = services
    services = undefined
    if (!open) return
    open.unsubscribe()
    await open.close()
    await open.store.close()
  }

  function unavailable(): RequestError {
    if (status.state === 'failed') return new RequestError(503, 'TED couldn’t update its data')
    if (status.state === 'needs-newer') {
      return new RequestError(
        503,
        status.lastOpenedBy
          ? `This data needs TED ${majorMinor(status.lastOpenedBy)} or later`
          : 'This data needs a newer TED',
      )
    }
    return new RequestError(503, 'TED is updating its data')
  }

  async function activeRuns(): Promise<string[]> {
    return (services?.store.listRuns() ?? []).filter((r) => r.state !== 'finished').map((r) => r.id)
  }

  return {
    status: () => status,
    async services() {
      while (status.state === 'opening') {
        const current = opening
        await current
        if (current === opening) break
      }
      if (!services) throw unavailable()
      return services
    },
    async summary() {
      return {
        backups: await backups.list(),
        activeRuns: (await activeRuns()).length,
      }
    },
    async restore({ name, stopRuns = false }) {
      const backup: Backup | undefined = await backups.find(name)
      if (!backup) throw new RequestError(404, `no backup ${name}`)
      if (busy || status.state === 'opening' || status.state === 'updating') {
        throw new RequestError(409, 'TED is busy with its data. Try again in a moment.')
      }
      const running = await activeRuns()
      if (running.length > 0 && !stopRuns) {
        const them = running.length === 1 ? 'it' : 'them'
        throw new RequestError(
          409,
          `${plural(running.length, 'Run')} ${running.length === 1 ? 'is' : 'are'} running. Stop ${them} to restore.`,
        )
      }
      busy = true
      try {
        for (const runId of running) await services?.runs.stop(runId)
        await closeServices()
        let saved: Backup | undefined
        const work = (async () => {
          setStatus({ state: 'opening' })
          const meta = await readStoreMeta(paths.store)
          await backups.restore(name, async () => {
            saved = await backups.saveBeforeRestore(meta?.lastOpenedBy)
          })
          await openData({ backUp: false })
        })()
        opening = work.catch(() => undefined)
        try {
          await work
        } catch (error) {
          setStatus(await failedStatus(error instanceof Error ? error.message : String(error)))
          throw error
        }
        if (!services) {
          throw new RequestError(
            500,
            `Restored ${name}, but TED couldn’t open it: ${unavailable().message}. Your data from before the restore is in backup ${saved?.name}.`,
          )
        }
        return { restored: name, saved: saved?.name ?? '', stoppedRuns: running.length }
      } finally {
        busy = false
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async open() {
      await openData({ backUp: true }).catch(async (error: unknown) => {
        console.error('opening TED’s data failed:', error)
        setStatus(await failedStatus(error instanceof Error ? error.message : String(error)))
      })
      firstOpen.resolve()
      dailyTimer = setInterval(() => void takeDaily(), options.dailyCheckMs ?? 60 * 60_000)
      dailyTimer.unref()
    },
    async close() {
      clearInterval(dailyTimer)
      await opening
      await closeServices()
    },
  }
}
