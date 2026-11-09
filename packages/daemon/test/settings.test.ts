import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  DaemonClient,
  type DaemonEvent,
  defaultSettings,
  readDaemonInfo,
  tedPaths,
} from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import { openStore } from '../src/store/index.ts'
import { makeTempHome, rawRequest, tokenFor } from './helpers.ts'

describe('machine settings in the store', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ted-store-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('Appearance starts as System and keeps its value across a reopen', async () => {
    const first = await openStore({ directory: dir })
    expect(first.settings()).toEqual({ ...defaultSettings, appearance: 'system' })
    first.updateSettings({ appearance: 'dark' })
    await first.close()

    const second = await openStore({ directory: dir })
    try {
      expect(second.settings()).toEqual({ ...defaultSettings, appearance: 'dark' })
    } finally {
      await second.close()
    }
  })

  test('changing a setting emits settings-changed with the new settings', async () => {
    const store = await openStore({ directory: dir })
    try {
      const seen: DaemonEvent[] = []
      store.subscribe((event) => seen.push(event))

      store.updateSettings({ appearance: 'light' })

      expect(seen).toEqual([
        { type: 'settings-changed', settings: { ...defaultSettings, appearance: 'light' } },
      ])
    } finally {
      await store.close()
    }
  })

  test('adding a Factory emits factory-added', async () => {
    const store = await openStore({ directory: dir })
    try {
      const seen: DaemonEvent[] = []
      store.subscribe((event) => seen.push(event))

      const factory = store.addFactory({
        key: 'NB',
        name: 'notebook',
        repo: 'kriya/notebook',
        cloneUrl: 'https://example.invalid/notebook.git',
        defaultBranch: 'main',
      })

      const { cloneUrl: _, ...shown } = factory
      expect(seen).toEqual([{ type: 'factory-added', factory: shown }])
    } finally {
      await store.close()
    }
  })
})

describe('settings and Factories over the daemon API', () => {
  let home: string
  let cleanup: () => Promise<void>
  let daemon: RunningDaemon | undefined

  beforeEach(async () => {
    ;({ home, cleanup } = await makeTempHome())
  })

  afterEach(async () => {
    await daemon?.stop()
    daemon = undefined
    await cleanup()
  })

  async function client(): Promise<DaemonClient> {
    const info = await readDaemonInfo(home)
    if (!info) throw new Error('no daemon.json')
    return new DaemonClient(info)
  }

  test('a client reads and changes Appearance, and subscribers hear the change', async () => {
    daemon = await startDaemon({ home, version: '9.9.9' })
    const ted = await client()
    const seen: DaemonEvent[] = []
    const subscription = await ted.subscribe((event) => seen.push(event))

    expect(await ted.getSettings()).toEqual({ ...defaultSettings, appearance: 'system' })
    expect(await ted.updateSettings({ appearance: 'dark' })).toEqual({
      ...defaultSettings,
      appearance: 'dark',
    })
    expect(await ted.getSettings()).toEqual({ ...defaultSettings, appearance: 'dark' })

    await expect
      .poll(() => seen)
      .toEqual([{ type: 'settings-changed', settings: { ...defaultSettings, appearance: 'dark' } }])
    subscription.close()
  })

  test.each([
    ['an unknown Appearance', { appearance: 'sepia' }],
    ['an unknown setting', { fontSize: 20 }],
    ['no settings', {}],
    ['a body that is not an object', ['dark']],
  ])('refuses %s', async (_, body) => {
    daemon = await startDaemon({ home, version: '9.9.9' })
    const token = await tokenFor(home)

    const res = await rawRequest(daemon.port, {
      method: 'PATCH',
      path: '/settings',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

    expect(res.status).toBe(400)
    expect(await (await client()).getSettings()).toEqual({
      ...defaultSettings,
      appearance: 'system',
    })
  })

  test('lists Factories without their clone URL', async () => {
    daemon = await startDaemon({ home, version: '9.9.9' })

    expect(await (await client()).listFactories()).toEqual([])
  })

  test('Runs can’t read or change settings or list Factories', async () => {
    daemon = await startDaemon({ home, version: '9.9.9' })
    const runToken = (await loadRunTokens(tedPaths(home).runTokenKey)).issue('run-1')
    const asRun = (method: string, route: string, body?: unknown) =>
      rawRequest(daemon?.port ?? 0, {
        method,
        path: route,
        headers: { authorization: `Bearer ${runToken}`, 'content-type': 'application/json' },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      })

    expect((await asRun('GET', '/tasks')).status).toBe(200)
    expect((await asRun('GET', '/settings')).status).toBe(403)
    expect((await asRun('PATCH', '/settings', { appearance: 'dark' })).status).toBe(403)
    expect((await asRun('GET', '/factories')).status).toBe(403)
  })
})
