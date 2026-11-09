import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { readDaemonInfo } from '@ted/protocol'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { DaemonAlreadyRunningError, type RunningDaemon, startDaemon } from '../src/index.ts'
import { makeTempHome } from './helpers.ts'

const mainPath = fileURLToPath(new URL('../src/main.ts', import.meta.url))

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

test('a second daemon on the same TED home is refused while the first runs', async () => {
  daemon = await startDaemon({ home, version: '9.9.9' })

  await expect(startDaemon({ home, version: '9.9.9' })).rejects.toBeInstanceOf(
    DaemonAlreadyRunningError,
  )
})

test('the lock is released when the daemon process is killed', async () => {
  const child = spawn(process.execPath, [mainPath], {
    env: { ...process.env, TED_HOME: home },
    stdio: 'ignore',
  })
  for (let i = 0; i < 200 && !(await readDaemonInfo(home)); i++) await sleep(25)
  await expect(startDaemon({ home, version: '9.9.9' })).rejects.toBeInstanceOf(
    DaemonAlreadyRunningError,
  )

  child.kill('SIGKILL')
  await once(child, 'exit')
  daemon = await startDaemon({ home, version: '9.9.9' })

  expect(daemon.port).toBeGreaterThan(0)
})

test('only one of several daemons starting at once wins', async () => {
  for (let trial = 0; trial < 150; trial++) {
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => startDaemon({ home, version: '9.9.9' })),
    )
    const winners = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
    const losers = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []))
    await Promise.all(winners.map((d) => d.stop()))

    expect(winners, `trial ${trial}`).toHaveLength(1)
    for (const reason of losers) expect(reason).toBeInstanceOf(DaemonAlreadyRunningError)
  }
}, 60_000)
