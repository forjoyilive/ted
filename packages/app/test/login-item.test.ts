import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  backgroundFlag,
  createLoginItem,
  desktopEntry,
  type LoginItemSystem,
  macLoginService,
  recordLoginItem,
  startsInBackground,
} from '../src/login-item.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ted-login-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

interface FakeMac {
  calls: unknown[]
  status: string
  openAtLogin: boolean
}

function system(changes: Partial<LoginItemSystem>, mac?: FakeMac): LoginItemSystem {
  return {
    platform: 'darwin',
    packaged: true,
    macVersion: 15,
    executable: '/Applications/TED.app/Contents/MacOS/TED',
    autostartDir: path.join(dir, 'autostart'),
    getLoginItemSettings(options) {
      mac?.calls.push(['get', options])
      return { status: mac?.status ?? 'not-registered' }
    },
    setLoginItemSettings(settings) {
      mac?.calls.push(['set', settings])
      if (mac) mac.openAtLogin = settings.openAtLogin === true
    },
    ...changes,
  }
}

const agent = { type: 'agentService', serviceName: macLoginService }

describe('Start at login on macOS', () => {
  test('registers TED’s LaunchAgent through SMAppService and reports it on', async () => {
    const mac: FakeMac = { calls: [], status: 'enabled', openAtLogin: false }

    expect(await createLoginItem(system({}, mac)).apply(true)).toBe('on')

    expect(mac.calls).toEqual([
      ['set', { openAtLogin: true, ...agent }],
      ['get', agent],
    ])
  })

  test('unregisters it when turned off', async () => {
    const mac: FakeMac = { calls: [], status: 'not-registered', openAtLogin: true }

    expect(await createLoginItem(system({}, mac)).apply(false)).toBe('off')

    expect(mac.calls[0]).toEqual(['set', { openAtLogin: false, ...agent }])
  })

  test('says when macOS needs the human to allow TED in System Settings', async () => {
    const mac: FakeMac = { calls: [], status: 'requires-approval', openAtLogin: false }

    expect(await createLoginItem(system({}, mac)).apply(true)).toBe('requires-approval')
  })

  test('a bundle without the LaunchAgent can’t start at login', async () => {
    const mac: FakeMac = { calls: [], status: 'not-found', openAtLogin: false }

    expect(await createLoginItem(system({}, mac)).apply(true)).toBe('unavailable')
  })

  test('before macOS 13 there is no LaunchAgent to register', async () => {
    const mac: FakeMac = { calls: [], status: 'enabled', openAtLogin: false }

    expect(await createLoginItem(system({ macVersion: 12 }, mac)).apply(true)).toBe('unavailable')
    expect(mac.calls).toEqual([])
  })
})

describe('the LaunchAgent shipped in the macOS bundle', () => {
  test('is named for the service TED registers and starts the app with --background', async () => {
    const plist = await readFile(
      new URL(`../build/mac/LaunchAgents/${macLoginService}`, import.meta.url),
      'utf8',
    )
    expect(plist).toContain('<string>Contents/MacOS/TED</string>')
    expect(plist).toContain(`<string>${backgroundFlag}</string>`)
    expect(plist).toContain('<string>design.kriya.ted.background</string>')
  })
})

describe('Start at login on Linux', () => {
  const linux = (changes: Partial<LoginItemSystem> = {}) =>
    system({ platform: 'linux', executable: '/opt/TED/ted-app', ...changes })
  const entryFile = () => path.join(dir, 'autostart', 'ted.desktop')

  test('writes an XDG autostart entry that starts TED in the background', async () => {
    expect(await createLoginItem(linux()).apply(true)).toBe('on')

    const text = await readFile(entryFile(), 'utf8')
    expect(text).toContain('[Desktop Entry]')
    expect(text).toContain('Exec="/opt/TED/ted-app" --background\n')
    expect((await stat(entryFile())).mode & 0o777).toBe(0o644)
  })

  test('rewrites the entry with the current path, as after an AppImage update', async () => {
    await createLoginItem(linux({ executable: '/home/n/Apps/TED-1.0.AppImage' })).apply(true)
    await createLoginItem(linux({ executable: '/home/n/Apps/TED-1.1.AppImage' })).apply(true)

    const text = await readFile(entryFile(), 'utf8')
    expect(text).toContain('Exec="/home/n/Apps/TED-1.1.AppImage" --background')
    expect(text).not.toContain('1.0')
  })

  test('removes the entry when turned off, and turning off twice is fine', async () => {
    const item = createLoginItem(linux())
    await item.apply(true)

    expect(await item.apply(false)).toBe('off')
    expect(await item.apply(false)).toBe('off')
    await expect(stat(entryFile())).rejects.toThrow()
  })

  test('quotes the path so spaces, quotes, dollars and percents stay literal', () => {
    expect(desktopEntry('/home/n/My Apps/a"b$c`d\\e%f')).toContain(
      'Exec="/home/n/My Apps/a\\\\"b\\\\$c\\\\`d\\\\\\\\e%%f" --background\n',
    )
  })

  test('refuses a path with a line break', () => {
    expect(() => desktopEntry('/opt/TED\nExec=rm')).toThrow()
  })
})

describe('where Start at login can’t work', () => {
  test('a copy run from source never touches the OS', async () => {
    const mac: FakeMac = { calls: [], status: 'enabled', openAtLogin: false }

    expect(await createLoginItem(system({ packaged: false }, mac)).apply(true)).toBe('unavailable')
    expect(mac.calls).toEqual([])
  })

  test('Windows isn’t supported', async () => {
    expect(await createLoginItem(system({ platform: 'win32' })).apply(true)).toBe('unavailable')
  })
})

describe('recording instead of registering', () => {
  test('writes each change to a file and reports the given state', async () => {
    const log = path.join(dir, 'login.log')
    const item = recordLoginItem(log, 'requires-approval')

    expect(await item.apply(true)).toBe('requires-approval')
    expect(await item.apply(false)).toBe('off')
    expect(await readFile(log, 'utf8')).toBe('on\noff\n')
  })
})

describe('starting in the background', () => {
  test('only --background starts TED with no window', () => {
    expect(startsInBackground(['/opt/TED/ted-app', '--background'])).toBe(true)
    expect(startsInBackground(['/opt/TED/ted-app'])).toBe(false)
  })
})
