import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  type DaemonClient,
  type DaemonEvent,
  defaultMachineSettings,
  readDaemonInfo,
  tedPaths,
} from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { loadRunTokens } from '../src/run-token.ts'
import { openStore } from '../src/store/index.ts'
import { appClient, appHeaders, makeTempHome, rawRequest } from './helpers.ts'

const picture =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='

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
    expect(first.settings().appearance).toBe('system')
    first.updateSettings({ appearance: 'dark' })
    await first.close()

    const second = await openStore({ directory: dir })
    try {
      expect(second.settings().appearance).toBe('dark')
    } finally {
      await second.close()
    }
  })

  test('machine settings start at their defaults and keep every change across a reopen', async () => {
    const first = await openStore({ directory: dir })
    expect(first.settings()).toEqual({
      appearance: 'system',
      terminalFontSize: 13,
      profilePicture: null,
      developerMode: false,
      maxWorkingRuns: 6,
      maxBootedSimulators: 3,
      quitWithWorkRunning: 'ask',
      showTrayIcon: true,
      startAtLogin: true,
      stayAwake: true,
      restartIdleRuns: true,
      notifyInboxItems: true,
      notifyProblems: true,
      notifyTaskMerged: false,
      notifySound: false,
      listViews: {},
      billing: { claude: 'subscription', codex: 'subscription' },
      firstLaunchDone: false,
      editor: null,
      editorCommand: '',
    })
    first.updateSettings({ terminalFontSize: 16, developerMode: true })
    first.updateSettings({ profilePicture: picture })
    first.updateSettings({ appearance: 'light' })
    await first.close()

    const second = await openStore({ directory: dir })
    try {
      expect(second.settings()).toMatchObject({
        appearance: 'light',
        terminalFontSize: 16,
        profilePicture: picture,
        developerMode: true,
        maxWorkingRuns: 6,
      })
      second.updateSettings({ profilePicture: null })
      expect(second.settings().profilePicture).toBeNull()
    } finally {
      await second.close()
    }
  })

  test('a change to the current value emits nothing', async () => {
    const store = await openStore({ directory: dir })
    try {
      const seen: DaemonEvent[] = []
      store.subscribe((event) => seen.push(event))

      store.updateSettings({ appearance: 'system', developerMode: false })

      expect(seen).toEqual([])
    } finally {
      await store.close()
    }
  })

  test('changing a setting emits settings-changed with the new settings', async () => {
    const store = await openStore({ directory: dir })
    try {
      const seen: DaemonEvent[] = []
      store.subscribe((event) => seen.push(event))

      store.updateSettings({ appearance: 'light' })

      expect(seen).toEqual([
        { type: 'settings-changed', settings: { ...defaultMachineSettings, appearance: 'light' } },
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

      expect(seen).toEqual([
        {
          type: 'factory-added',
          factory: {
            id: factory.id,
            key: 'NB',
            name: 'notebook',
            repo: 'kriya/notebook',
            defaultBranch: 'main',
            repos: [{ repo: 'kriya/notebook', name: 'notebook' }],
            showTutorial: false,
            cloned: true,
            position: 0,
            createdAt: factory.createdAt,
          },
        },
      ])
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
    return appClient(info, daemon?.appToken)
  }

  test('a client reads and changes Appearance, and subscribers hear the change', async () => {
    daemon = await startDaemon({ home, version: '9.9.9' })
    const ted = await client()
    const seen: DaemonEvent[] = []
    const subscription = await ted.subscribe((event) => seen.push(event))

    const dark = { ...defaultMachineSettings, appearance: 'dark' }
    expect(await ted.getSettings()).toEqual(defaultMachineSettings)
    expect(await ted.updateSettings({ appearance: 'dark' })).toEqual(dark)
    expect(await ted.getSettings()).toEqual(dark)

    await expect.poll(() => seen).toEqual([{ type: 'settings-changed', settings: dark }])
    subscription.close()
  })

  test.each([
    ['an unknown Appearance', { appearance: 'sepia' }],
    ['an unknown setting', { fontSize: 20 }],
    ['a terminal font size below 10', { terminalFontSize: 9 }],
    ['a terminal font size above 20', { terminalFontSize: 21 }],
    ['a fractional terminal font size', { terminalFontSize: 12.5 }],
    ['an editor TED doesn’t know', { editor: 'notepad' }],
    ['a custom editor command with an open quote', { editorCommand: '"my editor {path}' }],
    ['a custom editor command over two lines', { editorCommand: 'code\n{path}' }],
    ['Developer mode that is not true or false', { developerMode: 'yes' }],
    ['a profile picture that is not an image', { profilePicture: 'data:text/html;base64,PGI+' }],
    ['a profile picture that is a link', { profilePicture: 'https://example.com/me.png' }],
    [
      'a profile picture over 512 KB',
      { profilePicture: `data:image/png;base64,${'A'.repeat(600_000)}` },
    ],
    ['Start at login that is not true or false', { startAtLogin: 'on' }],
    ['Stay Awake that is not true or false', { stayAwake: 1 }],
    ['first launch done that is not true or false', { firstLaunchDone: 'yes' }],
    ['no simulator slots', { maxBootedSimulators: 0 }],
    ['more simulator slots than the limit', { maxBootedSimulators: 21 }],
    ['one bad setting among good ones', { developerMode: true, terminalFontSize: 30 }],
    ['no settings', {}],
    ['a body that is not an object', ['dark']],
  ])('refuses %s', async (_, body) => {
    daemon = await startDaemon({ home, version: '9.9.9' })
    const res = await rawRequest(daemon.port, {
      method: 'PATCH',
      path: '/settings',
      headers: {
        ...appHeaders(daemon.appToken, 'PATCH', '/settings', JSON.stringify(body)),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    expect(res.status).toBe(400)
    expect(await (await client()).getSettings()).toEqual(defaultMachineSettings)
  })

  test('a client changes the terminal font size, Developer mode and profile picture', async () => {
    daemon = await startDaemon({ home, version: '9.9.9' })
    const ted = await client()

    await ted.updateSettings({ terminalFontSize: 20, developerMode: true, profilePicture: picture })
    expect(await ted.getSettings()).toMatchObject({
      appearance: 'system',
      terminalFontSize: 20,
      profilePicture: picture,
      developerMode: true,
      maxWorkingRuns: 6,
    })
    await ted.updateSettings({ terminalFontSize: 10, profilePicture: null })
    expect(await ted.getSettings()).toMatchObject({ terminalFontSize: 10, profilePicture: null })
  })

  test('a client turns Start at login and Stay Awake off and on', async () => {
    daemon = await startDaemon({ home, version: '9.9.9' })
    const ted = await client()

    await ted.updateSettings({ startAtLogin: false, stayAwake: false })
    expect(await ted.getSettings()).toMatchObject({ startAtLogin: false, stayAwake: false })
    await ted.updateSettings({ stayAwake: true })
    expect(await ted.getSettings()).toMatchObject({ startAtLogin: false, stayAwake: true })
  })

  test('a client turns the Task merged notification on', async () => {
    daemon = await startDaemon({ home, version: '9.9.9' })
    const ted = await client()

    expect(await ted.getSettings()).toMatchObject({ notifyTaskMerged: false })
    await ted.updateSettings({ notifyTaskMerged: true })
    expect(await ted.getSettings()).toMatchObject({ notifyTaskMerged: true })
    await ted.updateSettings({ notifyInboxItems: false, notifyProblems: false, notifySound: true })
    expect(await ted.getSettings()).toMatchObject({
      notifyInboxItems: false,
      notifyProblems: false,
      notifySound: true,
    })
  })

  test('a client marks first launch done', async () => {
    daemon = await startDaemon({ home, version: '9.9.9' })
    const ted = await client()

    await ted.updateSettings({ firstLaunchDone: true })
    expect(await ted.getSettings()).toMatchObject({ firstLaunchDone: true })
  })

  test('the profile gives a name for the human’s initials', async () => {
    daemon = await startDaemon({ home, version: '9.9.9' })

    const { name } = await (await client()).getProfile()

    expect(name.trim()).not.toBe('')
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
    expect((await asRun('GET', '/profile')).status).toBe(403)
  })
})
