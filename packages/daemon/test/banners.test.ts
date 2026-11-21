import { mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type Banner,
  type DaemonClient,
  type DaemonEvent,
  type Factory,
  readDaemonInfo,
  tedPaths,
} from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, expectTypeOf, test, vi } from 'vitest'
import { createBanners } from '../src/banners.ts'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import { openStore, type TedStore } from '../src/store/index.ts'
import type { MachineArea } from '../src/store/machine.ts'
import {
  appClient,
  commitToOrigin,
  killRunHosts,
  makeOriginRepo,
  makeTempHome,
  rawRequest,
  stubClaudePath,
} from './helpers.ts'

expectTypeOf<TedStore>().toExtend<MachineArea>()

describe('banners in the store', () => {
  let dir: string
  let store: TedStore

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ted-store-'))
    store = await openStore({ directory: dir })
  })

  afterEach(async () => {
    await store.close()
    await rm(dir, { recursive: true, force: true })
  })

  test('a raised problem is listed until it clears, and subscribers hear both', () => {
    const banners = createBanners({ store })
    const seen: DaemonEvent[] = []
    store.subscribe((event) => seen.push(event))

    const banner = banners.raise({
      problem: 'offline',
      severity: 'stops-work',
      text: 'You’re offline · 5 Runs paused until the connection returns',
    })

    expect(banner).toMatchObject({
      id: 'offline:app',
      problem: 'offline',
      severity: 'stops-work',
      text: 'You’re offline · 5 Runs paused until the connection returns',
    })
    expect(banners.list()).toEqual([banner])

    banners.clear({ problem: 'offline' })

    expect(banners.list()).toEqual([])
    expect(seen).toEqual([
      { type: 'banner-raised', banner },
      { type: 'banner-cleared', id: 'offline:app' },
    ])
  })

  test('raising the same problem again changes nothing; new text updates it in place', () => {
    const banners = createBanners({ store })
    const first = banners.raise({
      problem: 'agent-signed-out',
      subject: 'claude',
      severity: 'stops-work',
      text: 'Claude Code is signed out · 3 Runs paused',
      action: { label: 'Fix', opens: { kind: 'settings', section: 'agents' } },
    })
    const seen: DaemonEvent[] = []
    store.subscribe((event) => seen.push(event))

    banners.raise({
      problem: 'agent-signed-out',
      subject: 'claude',
      severity: 'stops-work',
      text: 'Claude Code is signed out · 3 Runs paused',
      action: { label: 'Fix', opens: { kind: 'settings', section: 'agents' } },
    })
    expect(seen).toEqual([])

    const second = banners.raise({
      problem: 'agent-signed-out',
      subject: 'claude',
      severity: 'stops-work',
      text: 'Claude Code is signed out · 4 Runs paused',
      action: { label: 'Fix', opens: { kind: 'settings', section: 'agents' } },
    })

    expect(second).toEqual({ ...first, text: 'Claude Code is signed out · 4 Runs paused' })
    expect(seen).toEqual([{ type: 'banner-updated', banner: second }])
    expect(banners.list()).toEqual([second])
  })

  test('clearing a problem that isn’t raised does nothing', () => {
    const banners = createBanners({ store })
    const seen: DaemonEvent[] = []
    store.subscribe((event) => seen.push(event))

    banners.clear({ problem: 'offline' })

    expect(seen).toEqual([])
  })

  test('lists stops-work first, then warnings, newest first within each', async () => {
    const banners = createBanners({ store })
    const raise = async (problem: string, severity: Banner['severity']) => {
      banners.raise({ problem, severity, text: problem })
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    await raise('warning-old', 'warning')
    await raise('stop-old', 'stops-work')
    await raise('warning-new', 'warning')
    await raise('stop-new', 'stops-work')

    expect(banners.list().map((b) => b.problem)).toEqual([
      'stop-new',
      'stop-old',
      'warning-new',
      'warning-old',
    ])
  })

  test('a warning dismisses for 24 hours and a stopped problem dismisses for its occurrence', () => {
    const banners = createBanners({ store })
    banners.raise({ problem: 'disk-almost-full', severity: 'warning', text: 'Disk almost full' })
    const problem = banners.raise({
      problem: 'disk-full',
      severity: 'stops-work',
      text: 'Disk full',
    })

    const before = Date.now()
    const dismissed = banners.dismiss('disk-almost-full:app')
    const until = Date.parse(dismissed.dismissedUntil ?? '')
    expect(until - before).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 1000)
    expect(until - before).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 1000)

    expect(banners.dismiss(problem.id, problem.raisedAt).dismissed).toBe(true)
    expect(banners.dismiss(problem.id, problem.raisedAt).dismissed).toBe(true)
    expect(banners.raise({ ...problem, text: 'Still full' }).dismissed).toBe(true)
    banners.clear(problem)
    expect(banners.raise(problem).dismissed).toBeUndefined()
    expect(() => banners.dismiss('nothing:app')).toThrow(/no such banner/)
  })

  test('an in-memory problem dismisses without waiting for storage', async () => {
    const emit = vi.fn()
    const persisted = vi.fn(() => Promise.reject(new Error('storage unavailable')))
    const banners = createBanners({ store: { ...store, persisted }, emit })
    const input = { problem: 'disk-full', severity: 'stops-work', text: 'Disk full' } as const
    const banner = banners.raiseUnsaved(input)
    await banners.dismissProblem(banner.id, banner.raisedAt)

    expect(persisted).not.toHaveBeenCalled()
    expect(emit).toHaveBeenLastCalledWith({
      type: 'banner-updated',
      banner: { ...banner, dismissed: true },
    })
    expect(banners.raiseUnsaved({ ...input, text: 'Still full' }).dismissed).toBe(true)
    expect(banners.list()).toMatchObject([{ id: banner.id, dismissed: true }])
    banners.clear(input)
    expect(banners.raiseUnsaved(input).dismissed).toBeUndefined()
  })

  test('dismissing a repo-added warning clears it for good', () => {
    const banners = createBanners({ store })
    banners.raise({
      problem: 'repo-added',
      factoryId: 'f1',
      subject: 'acme/api',
      severity: 'warning',
      text: 'acme/api was added · Set up its checks and Apps with a setup Task',
    })

    banners.dismiss('repo-added:f1:acme/api')

    expect(banners.list().some((b) => b.problem === 'repo-added')).toBe(false)
  })

  test('a dismissal survives new text but not the problem clearing and coming back', () => {
    const banners = createBanners({ store })
    banners.raise({ problem: 'rate-limit', severity: 'warning', text: 'checking again at 14:05' })
    banners.dismiss('rate-limit:app')

    const updated = banners.raise({
      problem: 'rate-limit',
      severity: 'warning',
      text: 'checking again at 14:10',
    })
    expect(updated.dismissedUntil).toBeDefined()

    banners.clear({ problem: 'rate-limit' })
    const back = banners.raise({
      problem: 'rate-limit',
      severity: 'warning',
      text: 'checking again at 14:20',
    })
    expect(back.dismissedUntil).toBeUndefined()
  })

  test('banners survive a reopen of the store', async () => {
    const banners = createBanners({ store })
    const banner = banners.raise({
      problem: 'clone-failed',
      factoryId: 'f1',
      severity: 'stops-work',
      text: 'Couldn’t clone kriya/billing-web',
      action: { label: 'Retry' },
    })
    banners.dismiss(banner.id, banner.raisedAt)
    await store.close()
    store = await openStore({ directory: dir })

    expect(createBanners({ store }).list()).toMatchObject([
      {
        id: 'clone-failed:f1',
        dismissed: true,
        factoryId: 'f1',
        severity: 'stops-work',
        action: { label: 'Retry' },
      },
    ])
  })

  test('an action runs the handler registered for the problem', async () => {
    const banners = createBanners({ store })
    const ran: string[] = []
    banners.onAction('clone-failed', async (banner) => {
      ran.push(banner.id)
    })
    banners.raise({
      problem: 'clone-failed',
      factoryId: 'f1',
      severity: 'stops-work',
      text: 'Couldn’t clone',
      action: { label: 'Retry' },
    })
    banners.raise({ problem: 'offline', severity: 'stops-work', text: 'offline' })

    await banners.act('clone-failed:f1')

    expect(ran).toEqual(['clone-failed:f1'])
    await expect(banners.act('offline:app')).rejects.toThrow(/no action/)
  })
})

describe('banners over the daemon API', () => {
  let home: string
  let cleanup: () => Promise<void>
  let scratch: string
  let origin: string
  let daemon: RunningDaemon | undefined

  beforeEach(async () => {
    ;({ home, cleanup } = await makeTempHome())
    scratch = await mkdtemp(path.join(tmpdir(), 'ted-origin-'))
    origin = await makeOriginRepo(scratch)
  })

  afterEach(async () => {
    await daemon?.stop()
    daemon = undefined
    await killRunHosts(home)
    await cleanup()
    await rm(scratch, { recursive: true, force: true })
  })

  async function client(): Promise<DaemonClient> {
    const info = await readDaemonInfo(home)
    if (!info) throw new Error('no daemon.json')
    return appClient(info, daemon?.appToken)
  }

  async function start() {
    daemon = await startDaemon({ home, version: '9.9.9', claudeBin: stubClaudePath })
    return client()
  }

  test('a Factory whose Workflow has no Checks gets a No Checks warning', async () => {
    const ted = await start()
    const factory = (await ted.addFactory({ repo: origin, key: 'NB' })) as Factory

    expect(await ted.listBanners()).toMatchObject([
      {
        id: `no-checks:${factory.id}`,
        factoryId: factory.id,
        severity: 'warning',
        text: 'No checks set up · Validate relies on the agent alone',
        action: {
          label: 'Open Configuration',
          opens: { kind: 'factory-settings', factoryId: factory.id },
        },
      },
    ])
  })

  test('the No Checks warning clears once the Factory’s Workflow has a Check', async () => {
    const ted = await start()
    await ted.addFactory({ repo: origin, key: 'NB' })
    await commitToOrigin(scratch, {
      '.ted/workflow.yaml': [
        'version: 1',
        'stages:',
        '  backlog: { enabled: true }',
        '  validate:',
        '    checks:',
        '      - { name: Tests, run: pnpm test }',
        '',
      ].join('\n'),
    })

    await ted.createTask({ title: 'Anything', factory: 'NB' })

    expect(await ted.listBanners()).toEqual([])
  })

  test('a lost clone that can’t be cloned again raises Clone failed; Retry clears it', async () => {
    const ted = await start()
    const factory = (await ted.addFactory({ repo: origin, key: 'NB' })) as Factory
    await ted.createTask({ title: 'Anything', factory: 'NB' })
    await rm(path.join(tedPaths(home).repos, ...factory.repo.split('/')), {
      recursive: true,
      force: true,
    })
    const hidden = `${origin}.hidden`
    await rename(origin, hidden)
    const seen: DaemonEvent[] = []
    const subscription = await ted.subscribe((event) => seen.push(event))

    await expect(ted.startTask('NB-1')).rejects.toThrow(/Couldn’t clone/)

    const id = `clone-failed:${factory.id}`
    const failed = (await ted.listBanners()).find((b) => b.id === id)
    expect(failed).toMatchObject({
      severity: 'stops-work',
      factoryId: factory.id,
      text: `Couldn’t clone ${factory.repo} · ${factory.name} can’t start Tasks until it’s cloned`,
      action: { label: 'Retry' },
    })
    await expect
      .poll(() => seen.flatMap((e) => (e.type === 'banner-raised' ? [e.banner.id] : [])))
      .toContain(id)

    await expect(ted.actOnBanner(id)).rejects.toThrow(/Couldn’t clone/)
    expect((await ted.listBanners()).some((b) => b.id === id)).toBe(true)

    if (!failed) throw new Error('Clone failure did not raise a banner')
    await expect(ted.dismissBanner(id, 'older')).rejects.toMatchObject({ status: 409 })
    await expect(ted.dismissBanner(id, failed.raisedAt)).resolves.toMatchObject({ dismissed: true })

    await rename(hidden, origin)
    await ted.actOnBanner(id)

    expect((await ted.listBanners()).some((b) => b.id === id)).toBe(false)
    await expect.poll(() => seen).toContainEqual({ type: 'banner-cleared', id })
    subscription.close()
  })

  test('two Tasks starting at once after the clone is lost clone it once and both start', async () => {
    const ted = await start()
    const factory = (await ted.addFactory({ repo: origin, key: 'NB' })) as Factory
    await ted.createTask({ title: 'One', factory: 'NB' })
    await ted.createTask({ title: 'Two', factory: 'NB' })
    await rm(path.join(tedPaths(home).repos, ...factory.repo.split('/')), {
      recursive: true,
      force: true,
    })

    const started = await Promise.all([ted.startTask('NB-1'), ted.startTask('NB-2')])

    expect(started.map((t) => t.stage)).toEqual(['intake', 'intake'])
    expect((await ted.listBanners()).some((b) => b.problem === 'clone-failed')).toBe(false)
  })

  test('a client dismisses a warning', async () => {
    const ted = await start()
    const factory = (await ted.addFactory({ repo: origin, key: 'NB' })) as Factory

    const dismissed = await ted.dismissBanner(`no-checks:${factory.id}`)
    expect(dismissed.dismissedUntil).toBeDefined()

    await expect(ted.dismissBanner('nothing:app')).rejects.toMatchObject({ status: 404 })
  })

  test('Runs can’t read, dismiss or act on banners', async () => {
    await start()
    const runToken = (await loadRunTokens(tedPaths(home).runTokenKey)).issue('run-1')
    const asRun = (method: string, route: string) =>
      rawRequest(daemon?.port ?? 0, {
        method,
        path: route,
        headers: { authorization: `Bearer ${runToken}` },
      })

    expect((await asRun('GET', '/banners')).status).toBe(403)
    expect((await asRun('POST', '/banners/x/dismiss')).status).toBe(403)
    expect((await asRun('POST', '/banners/x/action')).status).toBe(403)
  })
})
