import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { withDaemon } from '../../../src/launch.ts'

const tree = `
const { spawn } = require('node:child_process')
spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
setInterval(() => {}, 1000)
`

test('leaves a daemon and a detached process tree running', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'ted-leaky-'))
  process.env.TED_IDLE_EXIT_MS = '600000'
  const tasks = await withDaemon(home, (client) => client.listTasks())
  expect(tasks).toEqual([])

  const leader = spawn(process.execPath, ['-e', tree], { detached: true, stdio: 'ignore' })
  leader.unref()
  await new Promise((resolve) => setTimeout(resolve, 500))
}, 60_000)
