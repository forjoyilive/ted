import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { readDaemonInfo } from '@ted/protocol'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import { holdAwakeWithOs, stayAwakeCommand } from '../src/stay-awake.ts'
import { api, appClient, isAlive, killRunHosts, makeTempHome, stubClaudePath } from './helpers.ts'

let home: string
let cleanup: () => Promise<void>
let cwd: string
let daemon: RunningDaemon | undefined
let calls: string[]

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  cwd = await mkdtemp(path.join(tmpdir(), 'ted-run-cwd-'))
  calls = []
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
    holdAwake: () => {
      calls.push('hold')
      return { release: () => calls.push('release') }
    },
  })
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('no daemon.json')
  return {
    ted: appClient(info, daemon.appToken),
    raw: api(daemon.port, { appKey: daemon.appToken }),
  }
}

const gate = (name: string) => path.join(cwd, name)

describe('Stay Awake', () => {
  test('holds the machine awake while a Run is working, and lets go once none are', async () => {
    const { raw } = await start()
    expect(calls).toEqual([])

    await raw.startRun([{ waitFor: gate('done') }, { exit: 0 }], cwd)
    await expect.poll(() => calls).toEqual(['hold'])

    await writeFile(gate('done'), '')
    await expect.poll(() => calls).toEqual(['hold', 'release'])
  })

  test('a Run waiting on the human doesn’t keep the machine awake', async () => {
    const { ted, raw } = await start()

    await raw.startRun([{ hook: 'PermissionRequest:Bash' }, { waitFor: gate('done') }], cwd)
    await expect.poll(async () => (await ted.getActivity()).waitingOnYou).toBe(1)

    expect(calls.at(-1) ?? 'release').toBe('release')
    await writeFile(gate('done'), '')
  })

  test('turning the setting off lets go at once, and turning it on holds again', async () => {
    const { ted, raw } = await start()
    await raw.startRun([{ waitFor: gate('done') }, { exit: 0 }], cwd)
    await expect.poll(() => calls).toEqual(['hold'])

    await ted.updateSettings({ stayAwake: false })
    expect(calls).toEqual(['hold', 'release'])

    await ted.updateSettings({ stayAwake: true })
    expect(calls).toEqual(['hold', 'release', 'hold'])
    await writeFile(gate('done'), '')
    await expect.poll(() => calls).toEqual(['hold', 'release', 'hold', 'release'])
  })

  test('with the setting off, a working Run doesn’t hold the machine awake', async () => {
    const { ted, raw } = await start()
    await ted.updateSettings({ stayAwake: false })

    await raw.startRun([{ waitFor: gate('done') }, { exit: 0 }], cwd)
    await expect.poll(async () => (await ted.getActivity()).runs.working).toBe(1)

    expect(calls).toEqual([])
    await writeFile(gate('done'), '')
  })

  test('stopping the daemon lets go', async () => {
    const { raw } = await start()
    await raw.startRun([{ waitFor: gate('done') }, { exit: 0 }], cwd)
    await expect.poll(() => calls).toEqual(['hold'])

    await daemon?.stop()
    daemon = undefined

    expect(calls).toEqual(['hold', 'release'])
  })
})

describe('the command that keeps the machine awake', () => {
  test('on macOS, caffeinate stops idle sleep until the daemon exits', () => {
    expect(stayAwakeCommand('darwin', 4242, () => true)).toEqual({
      command: '/usr/bin/caffeinate',
      args: ['-i', '-w', '4242'],
    })
  })

  test('on Linux, systemd-inhibit blocks idle and sleep until the daemon exits', () => {
    const present = new Set(['/usr/bin/systemd-inhibit', '/usr/bin/tail'])
    expect(stayAwakeCommand('linux', 4242, (file) => present.has(file))).toEqual({
      command: '/usr/bin/systemd-inhibit',
      args: [
        '--what=idle:sleep',
        '--who=TED',
        '--why=Runs are working',
        '--mode=block',
        '/usr/bin/tail',
        '--pid=4242',
        '-f',
        '/dev/null',
      ],
    })
  })

  test('finds systemd-inhibit and tail in /bin when /usr/bin lacks them', () => {
    const present = new Set(['/bin/systemd-inhibit', '/bin/tail'])
    const command = stayAwakeCommand('linux', 7, (file) => present.has(file))
    expect(command?.command).toBe('/bin/systemd-inhibit')
    expect(command?.args).toContain('/bin/tail')
  })

  test('without systemd-inhibit, or on another platform, there is nothing to run', () => {
    expect(stayAwakeCommand('linux', 7, () => false)).toBeUndefined()
    expect(stayAwakeCommand('win32', 7, () => true)).toBeUndefined()
  })
})

describe('holding the machine awake with the OS command', () => {
  test('runs the command while held and stops it on release', async () => {
    const pidFile = gate('pid')
    const hold = holdAwakeWithOs({
      command: process.execPath,
      args: [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`,
      ],
    })()
    await expect.poll(() => readFile(pidFile, 'utf8').catch(() => '')).not.toBe('')
    const pid = Number(await readFile(pidFile, 'utf8'))
    expect(isAlive(pid)).toBe(true)

    hold.release()

    await expect.poll(() => isAlive(pid)).toBe(false)
  })

  test('with no command for this platform, holding does nothing', () => {
    expect(() => holdAwakeWithOs(undefined)().release()).not.toThrow()
  })
})
