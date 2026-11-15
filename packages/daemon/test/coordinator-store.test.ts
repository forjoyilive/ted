import path from 'node:path'
import type { CoordinatorReceipt } from '@ted/protocol'
import { afterEach, expect, test } from 'vitest'
import { receiptsKept } from '../src/store/coordinator-change.ts'
import type { StoredCoordinator } from '../src/store/coordinators.ts'
import { openStore, type TedStore } from '../src/store/index.ts'
import { eventArgs, makeTempHome, pretendStateSchemaChanged } from './helpers.ts'

let store: TedStore | undefined
let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  await store?.close()
  store = undefined
  await cleanup?.()
})

const receipt = (i: number): CoordinatorReceipt => ({
  id: `operation-${i}`,
  operation: 'tell',
  taskId: 'task-1',
  text: `Told the Task Lead about change ${i}. ${'Detail. '.repeat(20)}`,
  at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
  fingerprint: `fingerprint-${i}`,
})

test('a Coordinator saves only what changed, keeps the newest receipts, and rebuilds from old and new events', async () => {
  const temporary = await makeTempHome()
  cleanup = temporary.cleanup
  const directory = path.join(temporary.home, 'store')
  store = await openStore({ directory })
  const chat: StoredCoordinator = {
    factoryId: 'factory-1',
    runId: 'run-1',
    runIds: ['run-1'],
    lead: { agent: 'claude' },
    phase: 'ready',
    opening: 'Opening prompt. '.repeat(200),
    receipts: [],
    taskIds: [],
  }
  store.coordinators.save(chat)
  store.coordinators.keep(
    {
      id: 'conversation-1',
      startedAt: '2025-12-31T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:00.000Z',
      chat,
    },
    [],
  )
  const saved = store.coordinators.conversation('conversation-1')
  if (!saved) throw new Error('no saved conversation')
  store.coordinators.restore(saved)

  let current = chat
  for (let i = 0; i < 150; i++) {
    current = { ...current, receipts: [...current.receipts, receipt(i)] }
    store.coordinators.save(current)
  }
  store.coordinators.save({ ...current, phase: 'working', error: 'Stopped' })
  store.coordinators.save({ ...current, phase: 'working' })
  store.coordinators.save({ ...current, phase: 'working' })
  await store.persisted()

  const live = store.coordinators.get('factory-1')
  expect(live?.receipts).toHaveLength(receiptsKept)
  expect(live?.receipts[0]?.id).toBe('operation-50')
  expect(live).toMatchObject({ phase: 'working', opening: chat.opening })
  expect(live?.error).toBeUndefined()

  const patches = await eventArgs(temporary.home, 'v2.CoordinatorChanged')
  expect(patches).toHaveLength(1 + 150 + 2)
  const largest = Math.max(...patches.slice(1).map((args) => args.length))
  expect(largest).toBeLessThan(JSON.stringify(receipt(149)).length * 2)
  expect(patches.slice(1).every((args) => !args.includes('Opening prompt.'))).toBe(true)
  expect(JSON.parse(patches.at(-1) ?? '{}')).toMatchObject({ unset: ['error'], lists: null })
  expect(await eventArgs(temporary.home, 'v1.CoordinatorChanged')).toHaveLength(1)

  await store.close()
  await pretendStateSchemaChanged(temporary.home)
  store = await openStore({ directory })
  expect(store.coordinators.get('factory-1')).toEqual(live)
})
