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
import type { Coordinators } from './coordinators/coordinators.ts'
import type { DiskWatch } from './disk.ts'
import type { Editors } from './editors.ts'
import { RequestError } from './errors.ts'
import type { ExecutionController } from './execution/controller.ts'
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
import type { SideChats } from './side-chats/side-chats.ts'
import type { Storage } from './storage.ts'
import { blankReplacedText, replacedTextCount } from './store/blank-replaced.ts'
import { type CompactOptions, compactOutputEvents, hasOutputToCompact } from './store/compact.ts'
import {
  type DropOptions,
  dropSupersededOutput,
  supersededOutputCount,
} from './store/drop-output.ts'
import {
  checkStore,
  eventCount,
  markOutputCompaction,
  markOutputDrop,
  markReplacedText,
  readOutputCompaction,
  readOutputDrop,
  readReplacedText,
  readStoreMeta,
  removeStaleStateFiles,
  writeStoreMeta,
} from './store/files.ts'
import { openStore, type TedStore } from './store/index.ts'
import { type TrimOptions, trimChangesets } from './store/trim-changesets.ts'
import type { ArchiveCleanup } from './tasks/archive-expiry.ts'
import type { Tasks } from './tasks/tasks.ts'
import { plural } from './text.ts'
import type { Workflows } from './workflow/workflows.ts'

export interface Services {
  agentAvailability: ReturnType<typeof import('./agent-availability.ts').createAgentAvailability>
  execution: ExecutionController
  sideChats: SideChats
  store: TedStore
  automations: Automations
  coordinators: Coordinators
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
  archiveCleanup: ArchiveCleanup
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
  compaction?: Pick<CompactOptions, 'beforeVerify'>
  outputDrop?: DropOptions
  changesetTrim?: TrimOptions
}

export interface Data {
  status(): DataStatus
  services(): Promise<Services>
  summary(): Promise<BackupsSummary>
  restore(request: RestoreBackupRequest): Promise<RestoreBackupResult>
  subscribe(listener: (event: DaemonEvent) => void): () => void
  open(): Promise<void>
  close(onStep?: (step: DataCloseStep) => void): Promise<void>
}

export type DataCloseStep = 'opening' | 'services' | 'store'

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
      await backups.takeDaily(() => open.store.exportEventlog())
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
    let backedUp = false
    if (rebuilding) {
      if (backUp && !(await alreadyBackedUp(meta?.lastOpenedBy))) {
        try {
          await backups.takePreUpdate(meta?.lastOpenedBy)
          backedUp = true
        } catch (error) {
          setStatus(
            await failedStatus(
              `Couldn’t copy the data before updating: ${error instanceof Error ? error.message : String(error)}`,
            ),
          )
          return
        }
      }
    }
    if (backUp && check.kind !== 'empty') {
      backedUp = await compactOutput(meta?.lastOpenedBy, backedUp).catch((error: unknown) => {
        console.error(redactSecrets(`checking the event log for old Run output failed: ${error}`))
        return backedUp
      })
      backedUp = await blankReplaced(meta?.lastOpenedBy, backedUp).catch((error: unknown) => {
        console.error(redactSecrets(`checking the event log for replaced text failed: ${error}`))
        return backedUp
      })
    }
    const startedAt = Date.now()
    if (rebuilding) setStatus(updating(progress, startedAt))
    const dropOnce = backUp && check.kind === 'current' && (await owesOutputDrop())
    if (dropOnce) setStatus(updating({ done: 0, total: await eventCount(paths.store) }, startedAt))
    let rebuilds = rebuilding
    if ((rebuilding || dropOnce) && backUp) {
      const dropped = await dropSupersededOutput(paths.store, {
        ...options.outputDrop,
        ...(!backedUp && { backUp: () => backups.takePreUpdate(meta?.lastOpenedBy) }),
      })
      const at = now().toISOString()
      if (dropped.kind === 'failed') {
        const reason = redactSecrets(dropped.reason)
        console.error(
          `dropping replaced Run output events failed, so the event log stays as it is: ${reason}`,
        )
        await markOutputDrop(paths.store, { state: 'failed', by: version, at, reason })
      } else {
        await markOutputDrop(paths.store, {
          state: 'done',
          by: version,
          at,
          dropped: dropped.kind === 'dropped' ? dropped.dropped : 0,
        })
      }
      if (dropped.kind === 'dropped') {
        rebuilds = true
        console.log(
          `dropped ${plural(dropped.dropped, 'replaced Run output event')} from the event log: ${plural(dropped.events, 'event')} left, ${dropped.bytesBefore} bytes before, ${dropped.bytesAfter} after`,
        )
        progress = { done: 0, total: dropped.events }
        setStatus(updating(progress, startedAt))
      }
    }

    if (check.kind === 'current' && !rebuilds) await trimStateChangesets()

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
          rebuilds ? progress : undefined,
        ),
      )
      return
    }

    await writeStoreMeta(paths.store, {
      lastOpenedBy: version,
      lastOpenedAt: now().toISOString(),
      ...(check.kind === 'empty' && {
        outputCompaction: { state: 'done', by: version, at: now().toISOString(), rewritten: 0 },
        outputDrop: { state: 'done', by: version, at: now().toISOString(), dropped: 0 },
        replacedText: { state: 'done', by: version, at: now().toISOString(), blanked: 0 },
      }),
    })
    if (rebuilds) await removeStaleStateFiles(paths.store)
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

  // ADR 0122: once per home, a store that needs no rebuild still gets its replaced Run output
  // events dropped, which makes it rebuild.
  async function owesOutputDrop(): Promise<boolean> {
    const mark = await readOutputDrop(paths.store)
    if (mark && (mark.state === 'done' || mark.by === version)) return false
    const count = await supersededOutputCount(paths.store).catch(() => 0)
    if (count >= (options.outputDrop?.atLeast ?? 1000)) return true
    await markOutputDrop(paths.store, {
      state: 'done',
      by: version,
      at: now().toISOString(),
      dropped: 0,
    })
    return false
  }

  async function trimStateChangesets(): Promise<void> {
    const trim = await trimChangesets(paths.store, options.changesetTrim)
    if (trim.kind === 'failed') {
      console.error(
        redactSecrets(
          `emptying LiveStore’s changeset table failed, so the state stays as it is: ${trim.reason}`,
        ),
      )
    } else if (trim.kind === 'trimmed') {
      console.log(
        `emptied LiveStore’s changeset table: ${plural(trim.rows, 'row')} (${trim.tableBytes} bytes) deleted, state database ${trim.bytesBefore} bytes before, ${trim.bytesAfter} after, in ${trim.ms} ms`,
      )
    }
  }

  async function compactOutput(dataFrom: string | undefined, backedUp: boolean): Promise<boolean> {
    const marker = await readOutputCompaction(paths.store)
    if (marker && (marker.state === 'done' || marker.by === version)) return backedUp
    const at = () => now().toISOString()
    if (!(await hasOutputToCompact(paths.store))) {
      await markOutputCompaction(paths.store, {
        state: 'done',
        by: version,
        at: at(),
        rewritten: 0,
      })
      return backedUp
    }
    const startedAt = Date.now()
    setStatus(updating({ done: 0, total: await eventCount(paths.store) }, startedAt))
    if (!(await backUpOnce(dataFrom, backedUp))) return false
    const result = await compactOutputEvents(paths.store, {
      ...options.compaction,
      onProgress: (next) => {
        const at = Date.now()
        if (next.done === next.total || at - lastProgressAt >= (options.progressEveryMs ?? 100)) {
          lastProgressAt = at
          setStatus(updating(next, startedAt))
        }
      },
    })
    if (result.kind === 'failed') {
      const reason = redactSecrets(result.reason)
      console.error(`compacting the event log failed, so it stays as it is: ${reason}`)
      await markOutputCompaction(paths.store, { state: 'failed', by: version, at: at(), reason })
      return true
    }
    const { rewritten, bytesBefore, bytesAfter } = result
    console.log(
      `compacted the event log: ${plural(rewritten, 'old Run output event')} rewritten, ${bytesBefore} bytes before, ${bytesAfter} after`,
    )
    await markOutputCompaction(paths.store, {
      state: 'done',
      by: version,
      at: at(),
      rewritten,
      bytesBefore,
      bytesAfter,
    })
    return true
  }

  async function backUpOnce(dataFrom: string | undefined, backedUp: boolean): Promise<boolean> {
    if (backedUp) return true
    try {
      await backups.takePreUpdate(dataFrom)
      return true
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      console.error(
        redactSecrets(`couldn’t copy the data, so the event log stays as it is: ${reason}`),
      )
      return false
    }
  }

  // ADR 0158: once per home, blank the text of old events a later event replaces.
  async function blankReplaced(dataFrom: string | undefined, backedUp: boolean): Promise<boolean> {
    const mark = await readReplacedText(paths.store)
    if (mark && (mark.state === 'done' || mark.by === version)) return backedUp
    const at = () => now().toISOString()
    if ((await replacedTextCount(paths.store)) === 0) {
      await markReplacedText(paths.store, { state: 'done', by: version, at: at(), blanked: 0 })
      return backedUp
    }
    const startedAt = Date.now()
    setStatus(updating({ done: 0, total: await eventCount(paths.store) }, startedAt))
    if (!(await backUpOnce(dataFrom, backedUp))) return false
    const result = await blankReplacedText(paths.store)
    if (result.kind === 'failed') {
      const reason = redactSecrets(result.reason)
      console.error(
        `blanking replaced text in the event log failed, so it stays as it is: ${reason}`,
      )
      await markReplacedText(paths.store, { state: 'failed', by: version, at: at(), reason })
      return true
    }
    const { blanked, bytesBefore, bytesAfter } = result
    console.log(
      `blanked replaced text in ${plural(blanked, 'old event')}: ${bytesBefore} bytes before, ${bytesAfter} after, in ${Date.now() - startedAt} ms`,
    )
    await markReplacedText(paths.store, {
      state: 'done',
      by: version,
      at: at(),
      blanked,
      bytesBefore,
      bytesAfter,
    })
    return true
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

  async function closeServices(onStep?: (step: DataCloseStep) => void): Promise<void> {
    const open = services
    services = undefined
    if (!open) return
    open.unsubscribe()
    onStep?.('services')
    await open.close()
    onStep?.('store')
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
    async close(onStep) {
      clearInterval(dailyTimer)
      onStep?.('opening')
      await opening
      await closeServices(onStep)
    },
  }
}
