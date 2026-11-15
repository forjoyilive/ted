import type { MemoryUse } from '@ted/protocol'
import { memorySummary } from '@ted/protocol/memory'
import { expect, test } from 'vitest'
import { formatMemoryUse } from '../src/memory.ts'

const mb = 1024 * 1024

const use: MemoryUse = {
  daemon: { bytes: 900 * mb, heapBytes: 330 * mb, externalBytes: 240 * mb },
  hosts: { count: 7, bytes: 530 * mb },
  agents: { count: 7, bytes: 2400 * mb },
  other: { count: 0, bytes: 0 },
  store: { eventLogBytes: 111 * mb, stateBytes: 95 * mb },
}

test('ted dev memory prints the total, each part and the store’s size on disk', () => {
  expect(formatMemoryUse(use).split('\n')).toEqual([
    'TED is using 3.7 GB.',
    '  Daemon: 900 MB (JavaScript heap 330 MB, store and buffers 240 MB)',
    '  7 Run hosts: 530 MB',
    '  7 agents: 2.3 GB',
    'Store on disk: event log 111 MB, state database 95 MB.',
    'The app’s own processes aren’t counted here. Settings → Developer shows them.',
  ])
})

test('the one-line summary adds the app and other commands when they are there', () => {
  expect(
    memorySummary({
      ...use,
      hosts: { count: 1, bytes: 75 * mb },
      agents: { count: 1, bytes: 350 * mb },
      other: { count: 2, bytes: 40 * mb },
      app: { count: 4, bytes: 590 * mb },
    }),
  ).toBe(
    '1.9 GB · Daemon 900 MB · App 590 MB · 1 Run host 75 MB · 1 agent 350 MB · Checks and other commands 40 MB',
  )
})
