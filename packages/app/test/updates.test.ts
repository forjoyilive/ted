import { EventEmitter } from 'node:events'
import type { UpdateWork } from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import {
  aboutLine,
  allowedUpdateUrl,
  createUpdates,
  electronUpdateSource,
  failedUpdate,
  type SourceEvent,
  shortVersion,
  type UpdateStatus,
  updateBanner,
  updateChip,
  updateMenuVersion,
} from '../src/updates.ts'

const ready = (asksPassword = false): UpdateStatus => ({
  state: 'ready',
  version: '1.4.0',
  asksPassword,
})

describe('what the window and menus say about an update', () => {
  test('the chip reads Update ready · Restart, or names the password on deb and rpm', () => {
    expect(updateChip(ready())).toEqual({ label: 'Update ready · Restart', busy: false })
    expect(updateChip(ready(true))).toEqual({
      label: 'Restart to update (asks for your password)',
      busy: false,
    })
  })

  test('while TED waits on Checks and merges the chip says what it’s finishing', () => {
    const finishing = (work: UpdateWork): UpdateStatus => ({
      state: 'finishing',
      version: '1.4.0',
      work,
    })
    expect(updateChip(finishing({ checks: 2, merges: 0 }))?.label).toBe('Finishing 2 checks…')
    expect(updateChip(finishing({ checks: 1, merges: 0 }))?.label).toBe('Finishing 1 Check…')
    expect(updateChip(finishing({ checks: 0, merges: 1 }))?.label).toBe('Finishing a merge…')
    expect(updateChip(finishing({ checks: 2, merges: 2 }))?.label).toBe(
      'Finishing 2 checks and 2 merges…',
    )
    expect(updateChip(finishing({ checks: 0, merges: 0 }))).toEqual({
      label: 'Restarting…',
      busy: true,
    })
  })

  test('no chip before an update is ready or after one failed', () => {
    expect(updateChip({ state: 'idle' })).toBeUndefined()
    expect(updateChip({ state: 'downloading', version: '1.4.0' })).toBeUndefined()
    expect(updateChip({ state: 'failed', version: '1.4.0' })).toBeUndefined()
  })

  test('the menu names the short version only when an update is ready', () => {
    expect(updateMenuVersion(ready())).toBe('1.4')
    expect(updateMenuVersion({ state: 'downloading', version: '1.4.0' })).toBeUndefined()
    expect(shortVersion('1.4.2')).toBe('1.4.2')
    expect(shortVersion('2.0.0')).toBe('2.0')
  })

  test('a failed install is a warning banner with Download', () => {
    const banner = updateBanner({ state: 'failed', version: '1.4.0' }, '2026-11-09T10:00:00.000Z')
    expect(banner).toEqual([
      {
        id: 'update-failed:app',
        problem: 'update-failed',
        severity: 'warning',
        text: 'Update to 1.4 failed',
        action: { label: 'Download' },
        raisedAt: '2026-11-09T10:00:00.000Z',
      },
    ])
    expect(updateBanner(ready(), '2026-11-09T10:00:00.000Z')).toEqual([])
  })

  test('About and updates says where the update stands', () => {
    expect(aboutLine(ready())).toBe('Update ready: TED 1.4.0.')
    expect(aboutLine({ state: 'checking' })).toBe('Checking for updates…')
    expect(aboutLine({ state: 'up-to-date' })).toBe('TED is up to date.')
    expect(aboutLine({ state: 'downloading', version: '1.4.0' })).toBe('Downloading TED 1.4.0…')
    expect(aboutLine({ state: 'failed', version: '1.4.0' })).toBe('Update to TED 1.4.0 failed.')
    expect(aboutLine({ state: 'unavailable' })).toBe(
      'Only an installed copy of TED updates itself.',
    )
    expect(aboutLine({ state: 'idle' })).toBeUndefined()
  })
})

describe('a failed install shows at the next launch', () => {
  test('a pending update newer than the running version failed', () => {
    expect(failedUpdate('1.4.0', '1.3.2')).toBe('1.4.0')
    expect(failedUpdate('1.4.0', '1.4.0')).toBeUndefined()
    expect(failedUpdate('1.10.0', '1.9.9')).toBe('1.10.0')
    expect(failedUpdate(undefined, '1.3.2')).toBeUndefined()
    expect(failedUpdate('not a version', '1.3.2')).toBeUndefined()
  })
})

function fakeSource() {
  let emit: (event: SourceEvent) => void = () => undefined
  const calls: string[] = []
  return {
    calls,
    emit: (event: SourceEvent) => emit(event),
    source: (listener: (event: SourceEvent) => void) => {
      emit = listener
      return {
        check: async () => void calls.push('check'),
        install: () => void calls.push('install'),
      }
    },
  }
}

describe('restarting to update', () => {
  function setUp(
    options: {
      handOver?: (onWork: (w: UpdateWork) => void) => Promise<void>
      failed?: string
    } = {},
  ) {
    const fake = fakeSource()
    const statuses: UpdateStatus[] = []
    const pending: string[] = []
    const resumed: string[] = []
    const updates = createUpdates({
      source: fake.source,
      current: '1.3.2',
      asksPassword: false,
      onStatus: (status) => statuses.push(status),
      handOver:
        options.handOver ??
        (async (onWork) => {
          onWork({ checks: 2, merges: 0 })
          onWork({ checks: 0, merges: 0 })
        }),
      markPending: async (version) => void pending.push(version),
      installFailed: async (version) => void resumed.push(version),
      ...(options.failed !== undefined && { failed: options.failed }),
    })
    return { ...fake, statuses, pending, resumed, updates }
  }

  test('a downloaded update becomes ready', () => {
    const { emit, updates } = setUp()
    emit({ kind: 'available', version: '1.4.0' })
    expect(updates.status).toEqual({ state: 'downloading', version: '1.4.0' })
    emit({ kind: 'downloaded', version: '1.4.0' })
    expect(updates.status).toEqual(ready())
  })

  test('restart hands the daemon over, finishing its work, then records and installs', async () => {
    const { emit, updates, statuses, pending, calls } = setUp()
    emit({ kind: 'downloaded', version: '1.4.0' })

    await updates.restart()

    expect(statuses.slice(1)).toEqual([
      { state: 'finishing', version: '1.4.0', work: { checks: 0, merges: 0 } },
      { state: 'finishing', version: '1.4.0', work: { checks: 2, merges: 0 } },
      { state: 'finishing', version: '1.4.0', work: { checks: 0, merges: 0 } },
      { state: 'restarting', version: '1.4.0' },
    ])
    expect(pending).toEqual(['1.4.0'])
    expect(calls).toEqual(['install'])
  })

  test('an error while installing is a failed update, and TED takes the daemon back', async () => {
    const { emit, updates, resumed } = setUp()
    emit({ kind: 'downloaded', version: '1.4.0' })
    await updates.restart()
    emit({ kind: 'error', message: 'pkexec was dismissed' })
    expect(updates.status).toEqual({ state: 'failed', version: '1.4.0' })
    expect(resumed).toEqual(['1.4.0'])
  })

  test('a failure found at launch stays until a newer update is ready', () => {
    const { emit, updates } = setUp({ failed: '1.4.0' })
    expect(updates.status).toEqual({ state: 'failed', version: '1.4.0' })
    emit({ kind: 'checking' })
    emit({ kind: 'none' })
    emit({ kind: 'error', message: 'offline' })
    expect(updates.status).toEqual({ state: 'failed', version: '1.4.0' })
    emit({ kind: 'available', version: '1.4.1' })
    emit({ kind: 'downloaded', version: '1.4.1' })
    expect(updates.status).toEqual({ state: 'ready', version: '1.4.1', asksPassword: false })
  })

  test('an error while checking or downloading leaves no failure behind', () => {
    const { emit, updates } = setUp()
    emit({ kind: 'available', version: '1.4.0' })
    emit({ kind: 'error', message: 'offline' })
    expect(updates.status).toEqual({ state: 'idle' })
  })

  test('nothing restarts unless an update is ready, and a second click does nothing', async () => {
    let handOvers = 0
    const { emit, updates, calls } = setUp({
      handOver: async () => {
        handOvers++
      },
    })
    await updates.restart()
    expect(calls).toEqual([])
    emit({ kind: 'downloaded', version: '1.4.0' })
    await Promise.all([updates.restart(), updates.restart()])
    expect(handOvers).toBe(1)
    expect(calls).toEqual(['install'])
  })

  test('a hand-over that fails puts the update back to ready and takes the daemon back', async () => {
    const { emit, updates, calls, resumed } = setUp({
      handOver: async () => {
        throw new Error('daemon didn’t stop')
      },
    })
    emit({ kind: 'downloaded', version: '1.4.0' })
    await expect(updates.restart()).rejects.toThrow('daemon didn’t stop')
    expect(updates.status).toEqual(ready())
    expect(resumed).toEqual(['1.4.0'])
    expect(calls).toEqual([])
  })

  test('Check for updates reports up to date', async () => {
    const { emit, updates, calls } = setUp()
    const checked = updates.check()
    emit({ kind: 'checking' })
    expect(updates.status).toEqual({ state: 'checking' })
    emit({ kind: 'none' })
    await checked
    expect(calls).toEqual(['check'])
    expect(updates.status).toEqual({ state: 'up-to-date' })
  })

  test('a ready update isn’t checked again over itself', async () => {
    const { emit, updates, calls } = setUp()
    emit({ kind: 'downloaded', version: '1.4.0' })
    emit({ kind: 'checking' })
    emit({ kind: 'none' })
    expect(updates.status).toEqual(ready())
    await updates.check()
    expect(calls).toEqual(['check'])
  })
})

describe('electron-updater', () => {
  function fakeAutoUpdater() {
    const updater = Object.assign(new EventEmitter(), {
      autoDownload: false,
      autoInstallOnAppQuit: false,
      allowPrerelease: true,
      allowDowngrade: true,
      forceDevUpdateConfig: true,
      feeds: [] as unknown[],
      checks: 0,
      installs: [] as unknown[][],
      setFeedURL(options: unknown) {
        this.feeds.push(options)
      },
      async checkForUpdates() {
        this.checks++
        return null
      },
      quitAndInstall(...args: unknown[]) {
        this.installs.push(args)
      },
    })
    return updater
  }

  test('reads only TED’s GitHub releases, downloads on its own and never goes back a version', () => {
    const updater = fakeAutoUpdater()
    electronUpdateSource(updater, { installOnQuit: true })(() => undefined)
    expect(updater.feeds).toEqual([{ provider: 'github', owner: 'forjoyilive', repo: 'ted' }])
    expect(updater).toMatchObject({
      autoDownload: true,
      autoInstallOnAppQuit: true,
      allowPrerelease: false,
      allowDowngrade: false,
      forceDevUpdateConfig: false,
    })
    const quiet = fakeAutoUpdater()
    electronUpdateSource(quiet, { installOnQuit: false })(() => undefined)
    expect(quiet.autoInstallOnAppQuit).toBe(false)
  })

  test('turns electron-updater’s events into source events and installs with a restart', () => {
    const updater = fakeAutoUpdater()
    const events: SourceEvent[] = []
    const source = electronUpdateSource(updater, { installOnQuit: true })((e) => events.push(e))
    updater.emit('checking-for-update')
    updater.emit('update-available', { version: '1.4.0' })
    updater.emit('update-not-available', { version: '1.3.2' })
    updater.emit('update-downloaded', { version: '1.4.0', downloadedFile: '/tmp/x' })
    updater.emit('error', new Error('boom'))
    source.install()
    expect(events).toEqual([
      { kind: 'checking' },
      { kind: 'available', version: '1.4.0' },
      { kind: 'none' },
      { kind: 'downloaded', version: '1.4.0' },
      { kind: 'error', message: 'boom' },
    ])
    expect(updater.installs).toEqual([[false, true]])
  })

  test('update traffic may only go over HTTPS to GitHub', () => {
    expect(allowedUpdateUrl('https://github.com/forjoyilive/ted/releases.atom')).toBe(true)
    expect(
      allowedUpdateUrl(
        'https://release-assets.githubusercontent.com/github-production-release-asset/1/2',
      ),
    ).toBe(true)
    expect(allowedUpdateUrl('https://objects.githubusercontent.com/x')).toBe(true)
    expect(allowedUpdateUrl('http://github.com/forjoyilive/ted/releases.atom')).toBe(false)
    expect(allowedUpdateUrl('https://github.com.evil.example/x')).toBe(false)
    expect(allowedUpdateUrl('https://evilgithubusercontent.com/x')).toBe(false)
    expect(allowedUpdateUrl('https://example.com/latest-mac.yml')).toBe(false)
    expect(allowedUpdateUrl('file:///etc/passwd')).toBe(false)
    expect(allowedUpdateUrl('not a url')).toBe(false)
  })
})
