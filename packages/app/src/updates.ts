import type { Banner, UpdateWork } from '@ted/protocol'
import { releaseRepo } from '@ted/protocol/release'

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'unavailable' }
  | { state: 'checking' }
  | { state: 'up-to-date' }
  | { state: 'downloading'; version: string }
  | { state: 'ready'; version: string; asksPassword: boolean }
  | { state: 'finishing'; version: string; work: UpdateWork }
  | { state: 'restarting'; version: string }
  | { state: 'failed'; version: string }

export type SourceEvent =
  | { kind: 'checking' }
  | { kind: 'available'; version: string }
  | { kind: 'none' }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string }

export interface UpdateSource {
  check(): Promise<void>
  install(): void
}

export type MakeSource = (listener: (event: SourceEvent) => void) => UpdateSource

const versionPattern = /^(\d+)\.(\d+)\.(\d+)$/

function parts(version: string): number[] | undefined {
  const match = versionPattern.exec(version)
  return match ? match.slice(1).map(Number) : undefined
}

export function isNewer(candidate: string, current: string): boolean {
  const a = parts(candidate)
  const b = parts(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

export function shortVersion(version: string): string {
  const p = parts(version)
  if (!p) return version
  return p[2] === 0 ? `${p[0]}.${p[1]}` : version
}

export function failedUpdate(pending: string | undefined, current: string): string | undefined {
  return pending !== undefined && isNewer(pending, current) ? pending : undefined
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many)

function finishingLabel({ checks, merges }: UpdateWork): string {
  const named = [
    ...(checks > 0 ? [`${checks} ${plural(checks, 'Check', 'Checks')}`] : []),
    ...(merges === 1 && checks === 0 ? ['a merge'] : []),
    ...(merges > 0 && !(merges === 1 && checks === 0)
      ? [`${merges} ${plural(merges, 'merge', 'merges')}`]
      : []),
  ]
  return `Finishing ${named.join(' and ')}…`
}

export function updateChip(status: UpdateStatus): { label: string; busy: boolean } | undefined {
  switch (status.state) {
    case 'ready':
      return {
        label: status.asksPassword
          ? 'Restart to update (asks for your password)'
          : 'Update ready · Restart',
        busy: false,
      }
    case 'finishing':
      return status.work.checks + status.work.merges > 0
        ? { label: finishingLabel(status.work), busy: true }
        : { label: 'Restarting…', busy: true }
    case 'restarting':
      return { label: 'Restarting…', busy: true }
    default:
      return undefined
  }
}

export function updateMenuVersion(status: UpdateStatus): string | undefined {
  return status.state === 'ready' ? shortVersion(status.version) : undefined
}

export const updateFailedProblem = 'update-failed'

export function updateBanner(status: UpdateStatus, raisedAt: string): Banner[] {
  if (status.state !== 'failed') return []
  return [
    {
      id: `${updateFailedProblem}:app`,
      problem: updateFailedProblem,
      severity: 'warning',
      text: `Update to ${shortVersion(status.version)} failed`,
      action: { label: 'Download' },
      raisedAt,
    },
  ]
}

export function aboutLine(status: UpdateStatus): string | undefined {
  switch (status.state) {
    case 'unavailable':
      return 'Only an installed copy of Ted updates itself.'
    case 'checking':
      return 'Checking for updates…'
    case 'up-to-date':
      return 'Ted is up to date.'
    case 'downloading':
      return `Downloading Ted ${status.version}…`
    case 'ready':
      return `Update ready: Ted ${status.version}.`
    case 'finishing':
    case 'restarting':
      return `Restarting to update to Ted ${status.version}…`
    case 'failed':
      return `Update to Ted ${status.version} failed.`
    case 'idle':
      return undefined
  }
}

export interface Updates {
  readonly status: UpdateStatus
  check(): Promise<void>
  restart(): Promise<void>
}

export function createUpdates(options: {
  source: MakeSource
  current: string
  asksPassword: boolean
  failed?: string
  onStatus: (status: UpdateStatus) => void
  handOver: (onWork: (work: UpdateWork) => void) => Promise<void>
  markPending: (version: string) => Promise<void>
  installFailed: (version: string) => Promise<void>
}): Updates {
  const { asksPassword } = options
  let status: UpdateStatus =
    options.failed !== undefined ? { state: 'failed', version: options.failed } : { state: 'idle' }
  let restarting: Promise<void> | undefined

  const set = (next: UpdateStatus) => {
    status = next
    options.onStatus(next)
  }
  const settled = () =>
    status.state === 'ready' || status.state === 'finishing' || status.state === 'restarting'
  const quiet = () => settled() || status.state === 'failed'

  const source = options.source((event) => {
    switch (event.kind) {
      case 'checking':
        if (!quiet()) set({ state: 'checking' })
        break
      case 'none':
        if (!quiet()) set({ state: 'up-to-date' })
        break
      case 'available':
        if (!settled() && isNewer(event.version, options.current)) {
          set({ state: 'downloading', version: event.version })
        }
        break
      case 'downloaded':
        if (!settled() && isNewer(event.version, options.current)) {
          set({ state: 'ready', version: event.version, asksPassword })
        }
        break
      case 'error':
        console.error('Ted’s update failed:', event.message)
        if (status.state === 'restarting') {
          const { version } = status
          set({ state: 'failed', version })
          options
            .installFailed(version)
            .catch((error: unknown) => console.error('couldn’t recover from the update:', error))
        } else if (!quiet()) set({ state: 'idle' })
        break
    }
  })

  async function restartNow(version: string): Promise<void> {
    set({ state: 'finishing', version, work: { checks: 0, merges: 0 } })
    try {
      await options.handOver((work) => set({ state: 'finishing', version, work }))
      set({ state: 'restarting', version })
      await options.markPending(version)
    } catch (error) {
      set({ state: 'ready', version, asksPassword })
      await options
        .installFailed(version)
        .catch((failure: unknown) => console.error('couldn’t take the daemon back:', failure))
      throw error
    }
    source.install()
  }

  return {
    get status() {
      return status
    },
    check: () => source.check(),
    restart() {
      if (restarting) return restarting
      if (status.state !== 'ready') return Promise.resolve()
      restarting = restartNow(status.version).finally(() => {
        restarting = undefined
      })
      return restarting
    },
  }
}

interface AutoUpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  allowDowngrade: boolean
  forceDevUpdateConfig: boolean
  setFeedURL(options: { provider: 'github'; owner: string; repo: string }): void
  checkForUpdates(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  on(event: 'checking-for-update' | 'update-not-available', listener: () => void): unknown
  on(
    event: 'update-available' | 'update-downloaded',
    listener: (info: { version: string }) => void,
  ): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

export function electronUpdateSource(
  updater: AutoUpdaterLike,
  { installOnQuit }: { installOnQuit: boolean },
): MakeSource {
  return (emit) => {
    updater.autoDownload = true
    updater.autoInstallOnAppQuit = installOnQuit
    updater.allowPrerelease = false
    updater.allowDowngrade = false
    updater.forceDevUpdateConfig = false
    updater.setFeedURL({ provider: 'github', owner: releaseRepo.owner, repo: releaseRepo.repo })
    updater.on('checking-for-update', () => emit({ kind: 'checking' }))
    updater.on('update-available', (info: { version: string }) =>
      emit({ kind: 'available', version: info.version }),
    )
    updater.on('update-not-available', () => emit({ kind: 'none' }))
    updater.on('update-downloaded', (info: { version: string }) =>
      emit({ kind: 'downloaded', version: info.version }),
    )
    updater.on('error', (error: Error) => emit({ kind: 'error', message: error.message }))
    return {
      async check() {
        await updater.checkForUpdates()
      },
      install: () => updater.quitAndInstall(false, true),
    }
  }
}

export function allowedUpdateUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' || parsed.port !== '') return false
  const host = parsed.hostname
  return host === 'github.com' || host.endsWith('.githubusercontent.com')
}
