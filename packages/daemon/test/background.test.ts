import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DaemonClient, type DaemonEvent, readDaemonInfo, tedPaths } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import { api, killRunHosts, makeTempHome, rawRequest, stubClaudePath, tokenFor } from './helpers.ts'

let home: string
let cleanup: () => Promise<void>
let cwd: string
let daemon: RunningDaemon | undefined
let shutdowns: number

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  cwd = await mkdtemp(path.join(tmpdir(), 'ted-run-cwd-'))
  shutdowns = 0
})

afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await killRunHosts(home)
  await cleanup()
  await rm(cwd, { recursive: true, force: true })
})

async function start() {
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    onShutdown: () => {
      shutdowns++
    },
  })
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('no daemon.json')
  return { ted: new DaemonClient(info), raw: api(daemon.port, await tokenFor(home)) }
}

const idle = { waitingOnYou: 0, runs: { working: 0, active: 0, queued: 0 }, automationsOn: 0 }

describe('activity', () => {
  test('counts working and waiting Runs, and tells subscribers when the counts change', async () => {
    const { ted, raw } = await start()
    const seen: DaemonEvent[] = []
    const subscription = await ted.subscribe((event) => seen.push(event))
    expect(await ted.getActivity()).toEqual(idle)

    const gate = (name: string) => path.join(cwd, name)
    await raw.startRun(
      [
        { hook: 'PermissionRequest:Bash' },
        { waitFor: gate('1') },
        { endTurn: true },
        { waitFor: gate('2') },
        { exit: 0 },
      ],
      cwd,
    )

    await expect
      .poll(() => ted.getActivity())
      .toEqual({ ...idle, waitingOnYou: 1, runs: { working: 0, active: 1, queued: 0 } })
    await writeFile(gate('1'), '')
    await expect
      .poll(() => ted.getActivity())
      .toEqual({ ...idle, runs: { working: 0, active: 1, queued: 0 } })
    await writeFile(gate('2'), '')
    await expect.poll(() => ted.getActivity()).toEqual(idle)

    const changes = seen.flatMap((e) => (e.type === 'activity-changed' ? [e.activity] : []))
    expect(changes.at(0)).toEqual({ ...idle, runs: { working: 1, active: 1, queued: 0 } })
    expect(changes.at(-1)).toEqual(idle)
    for (const [i, change] of changes.entries()) expect(change).not.toEqual(changes[i - 1])
    subscription.close()
  })
})

describe('quitting', () => {
  test('shutdown stops every active Run, answers, then hands over to the process to exit', async () => {
    const { ted, raw } = await start()
    const run = await raw.startRun([{ waitFor: path.join(cwd, 'never') }], cwd)
    await expect.poll(async () => (await ted.getActivity()).runs.active).toBe(1)

    await ted.shutdown()

    expect((await ted.getRun(run.id)).run.state).toBe('finished')
    await expect.poll(() => shutdowns).toBe(1)
  })

  test('once shutdown starts, no new Run can start', async () => {
    const { ted, raw } = await start()

    await ted.shutdown()

    const res = await raw.call('POST', '/dev/runs', { prompt: 'hello', cwd })
    expect(res).toEqual({ status: 503, body: { error: 'TED is shutting down' } })
    expect(await ted.getActivity()).toEqual(idle)
  })

  test('the quit setting and the tray setting have defaults and keep their values', async () => {
    const { ted } = await start()
    expect(await ted.getSettings()).toEqual({
      appearance: 'system',
      quitWithWorkRunning: 'ask',
      showTrayIcon: true,
    })

    await ted.updateSettings({ quitWithWorkRunning: 'keep-running', showTrayIcon: false })
    await daemon?.stop()
    const again = await start()

    expect(await again.ted.getSettings()).toEqual({
      appearance: 'system',
      quitWithWorkRunning: 'keep-running',
      showTrayIcon: false,
    })
  })

  test.each([
    ['an unknown quit choice', { quitWithWorkRunning: 'later' }],
    ['a tray setting that is not true or false', { showTrayIcon: 'yes' }],
  ])('refuses %s', async (_, body) => {
    await start()

    const res = await rawRequest(daemon?.port ?? 0, {
      method: 'PATCH',
      path: '/settings',
      headers: { authorization: `Bearer ${await tokenFor(home)}` },
      body: JSON.stringify(body),
    })

    expect(res.status).toBe(400)
  })
})

describe('ted open', () => {
  test('asks a connected app to open its window', async () => {
    const { ted } = await start()
    const seen: DaemonEvent[] = []
    const app = await ted.subscribe((event) => seen.push(event), { app: true })

    expect(await ted.openApp()).toEqual({ opened: true })
    await expect.poll(() => seen).toContainEqual({ type: 'open-requested' })
    app.close()
  })

  test('says so when no app is connected, even with other subscribers', async () => {
    const { ted } = await start()
    const other = await ted.subscribe(() => undefined)

    expect(await ted.openApp()).toEqual({ opened: false })
    other.close()
  })

  test('closing the app’s stream means no app is connected', async () => {
    const { ted } = await start()
    const app = await ted.subscribe(() => undefined, { app: true })
    app.close()

    await expect.poll(() => ted.openApp()).toEqual({ opened: false })
  })
})

test('Runs can’t read activity, shut TED down or open the app', async () => {
  await start()
  const runToken = (await loadRunTokens(tedPaths(home).runTokenKey)).issue('run-1')
  const asRun = (method: string, route: string) =>
    rawRequest(daemon?.port ?? 0, {
      method,
      path: route,
      headers: { authorization: `Bearer ${runToken}` },
    })

  expect((await asRun('GET', '/activity')).status).toBe(403)
  expect((await asRun('POST', '/shutdown')).status).toBe(403)
  expect((await asRun('POST', '/app/open')).status).toBe(403)
  expect((await asRun('GET', '/events?app=1')).status).toBe(403)
  expect(shutdowns).toBe(0)
})
