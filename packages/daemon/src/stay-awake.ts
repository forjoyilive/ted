import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { countWaiting } from '@ted/protocol'
import type { TedStore } from './store/index.ts'

export interface AwakeHold {
  release(): void
}

export type HoldAwake = () => AwakeHold

export interface StayAwake {
  close(): void
}

export function stayAwakeWhileWorking(store: TedStore, holdAwake: HoldAwake): StayAwake {
  let hold: AwakeHold | undefined
  const update = () => {
    const wanted =
      store.settings().stayAwake &&
      (store.activity().runs.working > 0 ||
        store.activity().checksRunning > 0 ||
        store.activity().checksWaiting > 0)
    if (wanted && !hold) hold = holdAwake()
    if (!wanted && hold) {
      hold.release()
      hold = undefined
    }
  }
  const unsubscribe = store.subscribe((event) => {
    if (event.type === 'activity-changed' || event.type === 'settings-changed') update()
  })
  update()
  return {
    close() {
      unsubscribe()
      hold?.release()
      hold = undefined
    },
  }
}

export type PhoneAwakeStore = Pick<TedStore, 'settings' | 'waiting' | 'subscribe'> & {
  phones: Pick<TedStore['phones'], 'list'>
}

export function stayAwakeForPhones(store: PhoneAwakeStore, holdOnPower: HoldAwake): StayAwake {
  let hold: AwakeHold | undefined
  const update = () => {
    const wanted =
      store.settings().stayAwake &&
      store.phones.list().length > 0 &&
      countWaiting(store.waiting()) > 0
    if (wanted && !hold) hold = holdOnPower()
    if (!wanted && hold) {
      hold.release()
      hold = undefined
    }
  }
  const unsubscribe = store.subscribe((event) => {
    if (
      event.type === 'inbox-changed' ||
      event.type === 'settings-changed' ||
      event.type === 'phones-changed'
    )
      update()
  })
  update()
  return {
    close() {
      unsubscribe()
      hold?.release()
      hold = undefined
    },
  }
}

export interface StayAwakeCommand {
  command: string
  args: string[]
}

export function stayAwakeCommand(
  platform: NodeJS.Platform,
  pid: number,
  exists: (file: string) => boolean = existsSync,
): StayAwakeCommand | undefined {
  if (platform === 'darwin') {
    return { command: '/usr/bin/caffeinate', args: ['-i', '-w', String(pid)] }
  }
  if (platform !== 'linux') return undefined
  const find = (name: string) => [`/usr/bin/${name}`, `/bin/${name}`].find((file) => exists(file))
  const inhibit = find('systemd-inhibit')
  const tail = find('tail')
  if (inhibit === undefined || tail === undefined) return undefined
  return {
    command: inhibit,
    args: [
      '--what=idle:sleep',
      '--who=Ted',
      '--why=Runs are working',
      '--mode=block',
      tail,
      `--pid=${pid}`,
      '-f',
      '/dev/null',
    ],
  }
}

export function stayAwakeOnPowerCommand(
  platform: NodeJS.Platform,
  pid: number,
): StayAwakeCommand | undefined {
  if (platform !== 'darwin') return undefined
  return { command: '/usr/bin/caffeinate', args: ['-s', '-w', String(pid)] }
}

export function holdAwakeWithOs(
  command = stayAwakeCommand(process.platform, process.pid),
): HoldAwake {
  return () => {
    if (!command) return { release: () => undefined }
    const child = spawn(command.command, command.args, { stdio: 'ignore' })
    let released = false
    child.on('error', (error) => console.error('Stay Awake couldn’t start:', error.message))
    child.on('exit', (code, signal) => {
      if (!released) console.error(`Stay Awake stopped early (${signal ?? code})`)
    })
    child.unref()
    return {
      release() {
        released = true
        child.kill()
      },
    }
  }
}

export function holdOnPowerWithOs(
  command = stayAwakeOnPowerCommand(process.platform, process.pid),
): HoldAwake {
  return command ? holdAwakeWithOs(command) : () => ({ release: () => undefined })
}
