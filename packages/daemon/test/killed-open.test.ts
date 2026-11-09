import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { DataStatus, Task } from '@ted/protocol'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/index.ts'
import {
  api,
  makeTempHome,
  pretendStateSchemaChanged,
  storeDbFiles,
  stubClaudePath,
  tokenFor,
} from './helpers.ts'

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

const storeDir = () => path.join(home, 'store', 'ted')

const killedWriter = `
const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync(process.argv[1])
db.exec('PRAGMA cache_size = 2; BEGIN; CREATE TABLE killed_write (v TEXT)')
const insert = db.prepare('INSERT INTO killed_write VALUES (?)')
for (let i = 0; i < 2000; i++) insert.run('x'.repeat(2000))
process.kill(process.pid, 'SIGKILL')
`

async function killMidWrite(prefix: string): Promise<void> {
  const file = (await storeDbFiles(storeDir())).find((f) => f.startsWith(prefix))
  if (!file) throw new Error(`no ${prefix} file`)
  const db = path.join(storeDir(), file)
  const child = spawnSync(process.execPath, ['-e', killedWriter, db])
  expect(child.signal).toBe('SIGKILL')
  expect(existsSync(`${db}-journal`)).toBe(true)
}

async function start(version: string, statuses: DataStatus[] = []) {
  daemon = await startDaemon({
    home,
    version,
    claudeBin: stubClaudePath,
    onDataStatus: (status) => statuses.push(status),
  })
  return api(daemon.port, await tokenFor(home))
}

async function storeWithTasks(): Promise<Task[]> {
  const ted = await start('1.0.0')
  await ted.call('POST', '/tasks', { title: 'Fix login' })
  await ted.call('POST', '/tasks', { title: 'Add dark mode' })
  const tasks = (await ted.call('GET', '/tasks')).body as Task[]
  await daemon?.stop()
  daemon = undefined
  return tasks
}

test('a daemon killed while writing its event log leaves a store the next start opens', async () => {
  const before = await storeWithTasks()
  await killMidWrite('eventlog')

  const statuses: DataStatus[] = []
  const ted = await start('1.0.0', statuses)

  expect(statuses.filter((s) => s.state === 'failed')).toEqual([])
  expect(statuses.at(-1)).toEqual({ state: 'ready' })
  expect((await ted.call('GET', '/tasks')).body).toEqual(before)
})

test('a daemon killed while rebuilding state after a schema change leaves a store the next start opens', async () => {
  const before = await storeWithTasks()
  await pretendStateSchemaChanged(home)
  await killMidWrite('eventlog')
  await killMidWrite('stateold')

  const statuses: DataStatus[] = []
  const ted = await start('1.1.0', statuses)

  expect(statuses.filter((s) => s.state === 'failed')).toEqual([])
  expect(statuses.at(-1)).toEqual({ state: 'ready' })
  expect((await ted.call('GET', '/tasks')).body).toEqual(before)
})
