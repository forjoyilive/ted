import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { readDaemonInfo } from '@ted/protocol'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { makeTempHome, rawRequest } from './helpers.ts'

const mainPath = fileURLToPath(new URL('../src/main.ts', import.meta.url))

let home: string
let cleanup: () => Promise<void>
let child: ChildProcess | undefined

beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
})

afterEach(async () => {
  if (child && child.exitCode === null) {
    child.kill()
    await once(child, 'exit')
  }
  child = undefined
  await cleanup()
})

function startDaemonProcess(args: string[], idleExitMs: number): ChildProcess {
  return spawn(process.execPath, [mainPath, ...args], {
    env: { ...process.env, TED_HOME: home, TED_IDLE_EXIT_MS: String(idleExitMs) },
    stdio: 'ignore',
  })
}

async function waitForPort(): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const info = await readDaemonInfo(home)
    if (info) return info.port
    await sleep(25)
  }
  throw new Error('daemon did not write daemon.json')
}

test('a daemon started with --exit-when-idle exits once no request arrives for the idle time', async () => {
  child = startDaemonProcess(['--exit-when-idle'], 800)
  const exited = once(child, 'exit')
  const port = await waitForPort()

  for (let i = 0; i < 8; i++) {
    await sleep(200)
    expect((await rawRequest(port, { path: '/healthz' })).status).toBe(200)
  }
  expect(child.exitCode).toBeNull()

  const [code] = await exited
  expect(code).toBe(0)
  expect(await readDaemonInfo(home)).toBeUndefined()
})

test('a daemon started without --exit-when-idle keeps running', async () => {
  child = startDaemonProcess([], 200)
  await waitForPort()

  await sleep(800)

  expect(child.exitCode).toBeNull()
})
