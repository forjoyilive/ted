import type { MemoryUse } from '@ted/protocol'
import { memorySummary } from '@ted/protocol/memory'
import { expect, test } from 'vitest'
import { formatMemoryUse } from '../src/memory.ts'

const mb = 1024 * 1024
const none = { count: 0, bytes: 0 }

const use: MemoryUse = {
  daemon: { bytes: 900 * mb, heapBytes: 330 * mb, externalBytes: 240 * mb },
  hosts: { count: 7, bytes: 530 * mb },
  agents: { count: 7, bytes: 2400 * mb },
  agentTools: { count: 12, bytes: 1500 * mb },
  checks: none,
  apps: none,
  other: none,
  store: { eventLogBytes: 111 * mb, stateBytes: 95 * mb },
}

test('ted dev memory prints the total, each kind of process and the store’s size on disk', () => {
  expect(formatMemoryUse(use).split('\n')).toEqual([
    'TED is using 5.2 GB.',
    '  Agents’ tools and MCP servers: 1.5 GB, 12 processes',
    '  Agents: 2.3 GB, 7 processes',
    '  Daemon and Run hosts: 1.4 GB, 8 processes (daemon 900 MB: JavaScript heap 330 MB, store and buffers 240 MB)',
    'Store on disk: event log 111 MB, state database 95 MB.',
    'The app’s own processes aren’t counted here. Settings → Developer shows them.',
  ])
})

test('the one-line summary adds Checks, Apps, the app and other commands when they are there', () => {
  expect(
    memorySummary({
      ...use,
      hosts: { count: 1, bytes: 75 * mb },
      agents: { count: 1, bytes: 350 * mb },
      agentTools: none,
      checks: { count: 3, bytes: 300 * mb },
      apps: { count: 2, bytes: 200 * mb },
      other: { count: 2, bytes: 40 * mb },
      app: { count: 4, bytes: 590 * mb },
    }),
  ).toBe(
    '2.4 GB · Agents 350 MB · Checks 300 MB · Apps 200 MB · Daemon and Run hosts 975 MB · TED app 590 MB · Other commands 40 MB',
  )
})

test('asleep Runs are counted apart, in the printout and in the summary', () => {
  expect(formatMemoryUse({ ...use, asleepRuns: 9 }).split('\n')[4]).toBe(
    '  9 idle Runs are asleep and use no memory.',
  )
  expect(formatMemoryUse({ ...use, asleepRuns: 1 }).split('\n')[4]).toBe(
    '  1 idle Run is asleep and uses no memory.',
  )
  expect(memorySummary({ ...use, asleepRuns: 9 })).toMatch(/ · 9 Runs asleep$/)
})
