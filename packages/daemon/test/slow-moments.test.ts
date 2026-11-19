import { lstat, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ProfileResult, SlowMoments } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createCpuProfiler } from '../src/cpu-profile.ts'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { appRoutes } from '../src/routes/apps.ts'
import { automationRoutes } from '../src/routes/automations.ts'
import { browserRoutes } from '../src/routes/browser.ts'
import { coordinatorRoutes } from '../src/routes/coordinators.ts'
import { factoryRoutes } from '../src/routes/factories.ts'
import { integrationRoutes } from '../src/routes/integrations.ts'
import { libraryRoutes } from '../src/routes/library.ts'
import { machineRoutes } from '../src/routes/machine.ts'
import { peerRoutes } from '../src/routes/peers.ts'
import { planRoutes } from '../src/routes/plans.ts'
import { routePattern } from '../src/routes/route.ts'
import { runRoutes } from '../src/routes/runs.ts'
import { searchRoutes } from '../src/routes/search.ts'
import { shellRoutes } from '../src/routes/shells.ts'
import { taskRoutes } from '../src/routes/tasks.ts'
import { createSlowMonitor } from '../src/slow-moments.ts'
import {
  api,
  devRunToken,
  killRunHosts,
  makeTempHome,
  stubClaudePath,
  tokenFor,
} from './helpers.ts'

let home: string
let cleanup: () => Promise<void>
let daemon: RunningDaemon | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
})

async function start(slow?: { requestMs?: number; stallMs?: number }) {
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    ...(slow && { slow }),
  })
  return api(daemon.port, { appKey: daemon.appToken })
}

async function slowMoments(client: ReturnType<typeof api>): Promise<SlowMoments> {
  const { status, body } = await client.call('GET', '/diagnostics/slow')
  expect(status).toBe(200)
  return body as SlowMoments
}

function block(ms: number): void {
  const end = performance.now() + ms
  while (performance.now() < end);
}

describe('slow requests', () => {
  test('a slow request is counted under its route pattern, never its URL', async () => {
    const client = await start({ requestMs: 0 })

    await client.call('GET', '/settings')
    await client.call('GET', '/tasks/SECRET-41/comments')
    await client.call('GET', '/tasks/SECRET-41/comments')
    await client.call('GET', '/search?q=private-words')

    const slow = await slowMoments(client)
    const routes = new Map(slow.lastMinute.routes.map((r) => [r.route, r]))
    expect(routes.get('GET /settings')?.count).toBe(1)
    expect(routes.get('GET /tasks/:id/comments')?.count).toBe(2)
    expect(routes.has('GET /search')).toBe(true)
    expect(JSON.stringify(slow)).not.toMatch(/SECRET-41|private-words/)
    expect(slow.lastMinute.requests.count).toBeGreaterThanOrEqual(4)
    expect(slow.lastHour.requests.count).toBe(slow.lastMinute.requests.count)
    expect(slow.thresholds).toEqual({ requestMs: 0, stallMs: 200 })
    expect(slow.minutes).toHaveLength(60)
    expect(slow.minutes.at(-1)?.requests.count).toBeGreaterThan(0)
  })

  test('routes that wait by design are left out', async () => {
    const client = await start({ requestMs: 0 })

    await client.call('GET', '/tasks/nope/repos/x/shell/output?generation=0&from=0')
    await client.call('POST', '/browser/poll', { session: 'not-a-session' })

    const { routes } = (await slowMoments(client)).lastMinute
    expect(routes.map((r) => r.route).filter((r) => /shell|browser/.test(r))).toEqual([])
  })

  test('fast requests are not counted at the default threshold', async () => {
    const client = await start()

    await client.call('GET', '/settings')

    const slow = await slowMoments(client)
    expect(slow.thresholds).toEqual({ requestMs: 100, stallMs: 200 })
    expect(slow.lastHour.routes.find((r) => r.route === 'GET /settings')).toBeUndefined()
  })

  test('every route has a pattern made only of fixed words, :id and :action', () => {
    const routes = [
      taskRoutes,
      peerRoutes,
      shellRoutes,
      appRoutes,
      browserRoutes,
      factoryRoutes,
      machineRoutes,
      libraryRoutes,
      integrationRoutes,
      runRoutes,
      automationRoutes,
      planRoutes,
      coordinatorRoutes,
      searchRoutes,
    ].flat()
    expect(routes.length).toBeGreaterThan(150)
    for (const route of routes) {
      expect(routePattern(route.path), route.path.source).toMatch(
        /^(\/(:id|:action|[a-z]+(-[a-z]+)*))+$/,
      )
    }
    expect(routePattern(/^\/tasks\/([^/]+)\/runs$/)).toBe('/tasks/:id/runs')
    expect(routePattern(/^\/tasks\/([^/]+)\/blockers(?:\/([^/]+))?$/)).toBe(
      '/tasks/:id/blockers/:id',
    )
    expect(routePattern(/^\/coordinator\/tasks\/([^/]+)\/(start|move|tell)$/)).toBe(
      '/coordinator/tasks/:id/:action',
    )
    expect(routePattern(/^\/peers\/watch\?cursor=([a-f0-9]{64})&timeout=([\d.]{1,8})$/)).toBe(
      '/peers/watch',
    )
    expect(routes.filter((r) => r.waits).map((r) => routePattern(r.path))).toEqual([
      '/tasks/:id/lead/restart',
      '/peers/watch',
      '/tasks/:id/repos/:id/shell/panes/:id/output',
      '/tasks/:id/browser',
      '/runs/:id/browser',
      '/browser/poll',
      '/sub-agents/:id/wait',
      '/chat-commands',
      '/chat-commands/:id',
    ])
  })
})

describe('event-loop stalls', () => {
  test('a blocked event loop is counted with how long it was blocked', async () => {
    const client = await start()

    block(450)

    await expect
      .poll(async () => (await slowMoments(client)).lastMinute.stalls.longestMs)
      .toBeGreaterThanOrEqual(350)
    const { stalls } = (await slowMoments(client)).lastHour
    expect(stalls.count).toBeGreaterThanOrEqual(1)
    expect(stalls.totalMs).toBeGreaterThanOrEqual(stalls.longestMs)
  })

  test('frequent stalls log one line, then a summary a minute later', () => {
    let now = 0
    let cpu = 0
    const lines: string[] = []
    const monitor = createSlowMonitor({
      wall: () => 1_700_000_000_000 + now,
      mono: () => now,
      cpuMs: () => cpu,
      log: (line) => lines.push(line),
      timer: false,
    })
    const tick = (blockedMs = 0) => {
      now += 50 + blockedMs
      cpu += blockedMs
      monitor.check()
    }

    tick(300)
    for (let i = 0; i < 13; i++) tick(i === 5 ? 1800 : 250)
    expect(lines).toEqual(['event loop blocked for 300 ms'])

    while (now < 70_000) tick()
    expect(lines).toHaveLength(2)
    expect(lines[1]).toMatch(
      /^event loop blocked 13 times in the last \d+ s: 4800 ms in total, longest 1800 ms$/,
    )
    expect(monitor.read().lastHour.stalls).toEqual({ count: 14, totalMs: 5100, longestMs: 1800 })

    now += 8 * 60 * 60 * 1000
    monitor.check()
    expect(lines).toHaveLength(2)
    expect(monitor.read().lastHour.stalls.count).toBe(0)
    monitor.close()
  })

  test('slow requests on one route log one line, then a count of the rest', () => {
    let now = 0
    const lines: string[] = []
    const monitor = createSlowMonitor({
      wall: () => 1_700_000_000_000 + now,
      mono: () => now,
      cpuMs: () => 0,
      log: (line) => lines.push(line),
      timer: false,
    })
    const request = (totalMs: number) =>
      monitor.request({
        method: 'GET',
        route: '/tasks/:id/runs',
        status: 200,
        handlerMs: totalMs - 2,
        totalMs,
      })

    request(312)
    for (let i = 0; i < 14; i++) request(i === 3 ? 880 : 150)
    request(99)
    expect(lines).toEqual(['slow request: GET /tasks/:id/runs 200 took 312 ms (handler 310 ms)'])

    for (let i = 0; i < 240; i++) {
      now += 50
      monitor.check()
    }
    expect(lines).toEqual([
      'slow request: GET /tasks/:id/runs 200 took 312 ms (handler 310 ms)',
      'slow requests: GET /tasks/:id/runs 14 more in the last 10 s, slowest 880 ms',
    ])
    expect(monitor.read().lastMinute.routes).toEqual([
      { route: 'GET /tasks/:id/runs', count: 15, totalMs: 312 + 880 + 13 * 150, longestMs: 880 },
    ])
    monitor.close()
  })

  test('a slow request after the quiet period keeps the held count', () => {
    let now = 0
    const lines: string[] = []
    const monitor = createSlowMonitor({
      wall: () => 1_700_000_000_000 + now,
      mono: () => now,
      cpuMs: () => 0,
      log: (line) => lines.push(line),
      timer: false,
    })
    const request = (totalMs: number) =>
      monitor.request({
        method: 'GET',
        route: '/tasks/:id/runs',
        status: 200,
        handlerMs: totalMs,
        totalMs,
      })

    request(300)
    now = 500
    request(400)
    now = 10_001
    request(500)
    now += 1000
    monitor.check()
    expect(lines).toEqual([
      'slow request: GET /tasks/:id/runs 200 took 300 ms (handler 300 ms)',
      'slow requests: GET /tasks/:id/runs 2 more in the last 11 s, slowest 500 ms',
    ])
    monitor.close()
  })
})

describe('reading and profiling: who may call', () => {
  test('the daemon.json token reads the figures but can’t start a profile; a Run token does neither', async () => {
    const client = await start()
    const file = api(daemon?.port ?? 0, await tokenFor(home))
    const run = api(
      daemon?.port ?? 0,
      await devRunToken(home, daemon?.port ?? 0, daemon?.appToken ?? ''),
    )

    expect((await file.call('GET', '/diagnostics/slow')).status).toBe(200)
    expect(await file.call('POST', '/diagnostics/profile', { seconds: 5 })).toEqual({
      status: 403,
      body: { error: 'only the Ted app can do this' },
    })
    expect((await run.call('GET', '/diagnostics/slow')).status).toBe(403)
    expect((await run.call('POST', '/diagnostics/profile', { seconds: 5 })).status).toBe(403)
    expect((await client.call('POST', '/diagnostics/profile', { seconds: 4 })).status).toBe(400)
    expect((await client.call('POST', '/diagnostics/profile', { seconds: 121 })).status).toBe(400)
    await expect(lstat(path.join(home, 'logs', 'profiles'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})

describe('CPU profile', () => {
  test('a long block of the event loop saves a profile that names the code that blocked', async () => {
    const lines: string[] = []
    const profiler = createCpuProfiler(home, {
      stallMs: 2_000,
      startAfterMs: 300,
      tickMs: 50,
      log: (line) => lines.push(line),
    })
    const dir = path.join(home, 'logs', 'profiles')
    const saved = async () =>
      (await readdir(dir).catch(() => [])).filter((name) => name.startsWith('stall-'))
    try {
      await new Promise((resolve) => setTimeout(resolve, 300))
      block(500)
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(await saved()).toEqual([])
      block(2_500)
      await expect.poll(saved).toHaveLength(1)
      const [name = ''] = await saved()
      expect(name).toMatch(/^stall-\d{8}-\d{6}\.cpuprofile$/)
      expect((await lstat(path.join(dir, name))).mode & 0o777).toBe(0o600)
      const profile = JSON.parse(await readFile(path.join(dir, name), 'utf8')) as {
        nodes: { callFrame: { url: string } }[]
      }
      expect(
        profile.nodes.some((node) => node.callFrame.url.endsWith('slow-moments.test.ts')),
      ).toBe(true)
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatch(/^event loop blocked for \d+ ms; a CPU profile of it is in /)
    } finally {
      profiler.close()
    }
  }, 30_000)

  test('the app records one profile at a time into logs/profiles and keeps the newest five', async () => {
    const client = await start()
    const dir = path.join(home, 'logs', 'profiles')
    await mkdir(dir, { recursive: true })
    const old = [1, 2, 3, 4, 5].map((n) => `daemon-2020010${n}-000000.cpuprofile`)
    for (const name of old) await writeFile(path.join(dir, name), '{}')
    await writeFile(path.join(dir, 'notes.txt'), 'mine')

    const first = client.call('POST', '/diagnostics/profile', { seconds: 5 })
    await expect
      .poll(async () => (await client.call('POST', '/diagnostics/profile', { seconds: 5 })).status)
      .toBe(409)
    block(100)
    const { status, body } = await first
    const result = body as ProfileResult

    expect(status).toBe(201)
    expect(result.seconds).toBe(5)
    const name = path.basename(result.file)
    expect(name).toMatch(/^daemon-\d{8}-\d{6}\.cpuprofile$/)
    const file = path.join(dir, name)
    const info = await lstat(file)
    expect(info.isFile()).toBe(true)
    expect(info.mode & 0o777).toBe(0o600)
    expect(info.size).toBe(result.bytes)
    const profile = JSON.parse(await readFile(file, 'utf8')) as {
      nodes: { callFrame: Record<string, unknown> }[]
      samples: number[]
    }
    expect(profile.nodes.length).toBeGreaterThan(0)
    expect(profile.samples.length).toBeGreaterThan(0)
    expect(Object.keys(profile.nodes[0]?.callFrame ?? {}).sort()).toEqual([
      'columnNumber',
      'functionName',
      'lineNumber',
      'scriptId',
      'url',
    ])
    expect((await readdir(dir)).sort()).toEqual([...old.slice(1), name, 'notes.txt'].sort())
  }, 30_000)

  test('refuses to write through a linked profiles folder', async () => {
    const client = await start()
    const elsewhere = path.join(home, 'elsewhere')
    await mkdir(elsewhere)
    await mkdir(path.join(home, 'logs'), { recursive: true })
    await symlink(elsewhere, path.join(home, 'logs', 'profiles'))

    const { status, body } = await client.call('POST', '/diagnostics/profile', { seconds: 5 })

    expect(status).toBe(409)
    expect((body as { error: string }).error).toContain('isn’t a plain folder')
    expect(await readdir(elsewhere)).toEqual([])
  })
})
