import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { daemonAsApp, isAlive, stopDaemonIn, waitUntil } from './helpers.ts'
import { AppDaemons } from './support/app-daemons.ts'

let home: string
let daemons: AppDaemons
let children: ChildProcess[]

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'ted-app-daemons-'))
  daemons = new AppDaemons()
  children = []
})

afterEach(async () => {
  await daemons.stop(home, true)
  for (const child of children) {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const ended = once(child, 'exit')
      child.kill('SIGKILL')
      await ended
    }
  }
  await stopDaemonIn(home)
  await rm(home, { recursive: true, force: true })
})

async function waitingChild(ignoreTerm = false): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
        ${ignoreTerm ? "process.on('SIGTERM', () => {})" : ''}
        process.on('message', () => process.exit(17))
        setInterval(() => {}, 1000)
        process.send('waiting-before-daemon-info')
      `,
    ],
    { env: { ...process.env }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  )
  children.push(child)
  await once(child, 'message')
  return child
}

const infoFor = (pid: number | undefined) => ({ pid, port: 12345, token: 'test', version: 'test' })

test('readiness returns the owned child’s daemon.json', async () => {
  const child = await waitingChild()
  const info = infoFor(child.pid)
  await writeFile(path.join(home, 'daemon.json'), JSON.stringify(info))
  expect(await daemons.start(home, child)).toEqual(info)
  await daemons.stop(home)
  expect(child.signalCode).toBe('SIGTERM')
})

test('readiness refuses a stale descriptor from another process', async () => {
  const child = await waitingChild()
  const other = await waitingChild()
  await writeFile(path.join(home, 'daemon.json'), JSON.stringify(infoFor(other.pid)))
  await expect(daemons.start(home, child, 0)).rejects.toThrow(
    'timed out waiting for daemon.json (child alive)',
  )
  expect(child.signalCode).toBe('SIGKILL')
  await rm(path.join(home, 'daemon.json'))
})

test('a readiness timeout reaps the still-starting child before rejecting', async () => {
  const child = await waitingChild()
  await expect(daemons.start(home, child, 0)).rejects.toThrow(
    'timed out waiting for daemon.json (child alive)',
  )
  expect(child.signalCode).toBe('SIGKILL')
  expect(await daemons.stop(home)).toBe(false)
  await expect(readFile(path.join(home, 'daemon.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('cleanup reaches a starting daemon even before it has published daemon.json', async () => {
  const child = await waitingChild()
  const ready = expect(daemons.start(home, child)).rejects.toThrow(/before daemon.json/)
  expect(await daemons.stop(home)).toBe(true)
  await ready
  expect(child.signalCode).toBe('SIGTERM')
})

test('cleanup reaps a daemon that ignores SIGTERM before returning', async () => {
  const child = await waitingChild(true)
  await writeFile(path.join(home, 'daemon.json'), JSON.stringify(infoFor(child.pid)))
  await daemons.start(home, child)
  await daemons.stop(home)
  expect(child.signalCode).toBe('SIGKILL')
})

test('an early daemon exit reports the exit boundary instead of a readiness timeout', async () => {
  const child = await waitingChild()
  const ready = expect(daemons.start(home, child)).rejects.toThrow(
    'daemon exited before daemon.json (code 17, signal null)',
  )
  child.send('exit-before-info')
  await ready
  expect(await daemons.stop(home)).toBe(false)
})

test('a failed spawn reports its error and releases ownership', async () => {
  const child = spawn(path.join(home, 'missing-node'), [], { env: { ...process.env } })
  await expect(daemons.start(home, child)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await daemons.stop(home)).toBe(false)
})

test('daemonAsApp reports a Node startup failure before daemon.json exists', async () => {
  await expect(
    daemonAsApp(home, {
      ...process.env,
      NODE_OPTIONS: `--import=${pathToFileURL(path.join(home, 'missing-startup.ts')).href}`,
    }),
  ).rejects.toThrow('daemon exited before daemon.json (code 1, signal null)')
  await expect(readFile(path.join(home, 'daemon.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('stopDaemonIn reaps daemonAsApp while Node is held before daemon.json publication', async () => {
  const preload = path.join(home, 'hold-startup.mjs')
  const marker = path.join(home, 'startup-pid')
  await writeFile(
    preload,
    `import { writeFileSync } from 'node:fs'
     writeFileSync(${JSON.stringify(marker)}, String(process.pid))
     setInterval(() => {}, 1000)
     await new Promise(() => {})`,
  )
  const starting = daemonAsApp(home, {
    ...process.env,
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
  })
  const failed = expect(starting).rejects.toThrow(/before daemon.json/)
  const pid = await waitUntil(async () => {
    const text = await readFile(marker, 'utf8').catch(() => undefined)
    return text ? Number(text) : undefined
  }, 'Node held before daemon startup')
  try {
    await stopDaemonIn(home)
    expect(isAlive(pid)).toBe(false)
    await failed
    await expect(readFile(path.join(home, 'daemon.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    if (isAlive(pid)) process.kill(pid, 'SIGKILL')
    await failed
  }
})
