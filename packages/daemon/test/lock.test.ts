import { spawnSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { DaemonAlreadyRunningError, type RunningDaemon, startDaemon } from '../src/index.ts'
import { makeTempHome } from './helpers.ts'

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

test('a lock left by a process that has exited is taken over', async () => {
  const exited = spawnSync(process.execPath, ['-e', ''])
  await writeFile(path.join(home, 'daemon.lock'), String(exited.pid))

  daemon = await startDaemon({ home, version: '9.9.9' })

  expect(daemon.port).toBeGreaterThan(0)
})
