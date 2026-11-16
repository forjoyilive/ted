import path from 'node:path'
import type { CoordinatorReceipt } from '@ted/protocol'
import { afterEach, expect, test } from 'vitest'
import { receiptsKept } from '../src/store/coordinator-change.ts'
import type { StoredCoordinator } from '../src/store/coordinators.ts'
import { openStore, type TedStore } from '../src/store/index.ts'
import { editEventlog, eventArgs, makeTempHome, pretendStateSchemaChanged } from './helpers.ts'

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

const chatIn = (factoryId: string, id: string, runId: string): StoredCoordinator => ({
  id,
  factoryId,
  runId,
  runIds: [runId],
  lead: { agent: 'claude' },
  phase: 'ready',
  opening: `Opening of ${id}`,
  receipts: [],
  taskIds: [],
})

test('a chat saves only what changed, keeps the newest receipts, and rebuilds from its events', async () => {
  const temporary = await makeTempHome()
  cleanup = temporary.cleanup
  const directory = path.join(temporary.home, 'store')
  store = await openStore({ directory })
  const chat = {
    ...chatIn('factory-1', 'chat-1', 'run-1'),
    opening: 'Opening prompt. '.repeat(200),
  }
  store.coordinators.save(chat)
  store.coordinators.save(chatIn('factory-1', 'chat-2', 'run-2'))

  let current = chat
  for (let i = 0; i < 150; i++) {
    current = { ...current, receipts: [...current.receipts, receipt(i)] }
    store.coordinators.save(current)
  }
  store.coordinators.save({ ...current, phase: 'working', error: 'Stopped' })
  store.coordinators.save({ ...current, phase: 'working' })
  store.coordinators.save({ ...current, phase: 'working' })
  store.coordinators.rename('chat-2', 'Release review')
  store.coordinators.rename('chat-2', 'Release review')
  store.coordinators.save({ ...chatIn('factory-1', 'chat-2', 'run-2'), phase: 'working' })
  await store.persisted()
  expect(await eventArgs(temporary.home, 'v1.CoordinatorChatRenamed')).toHaveLength(1)
  expect(store.coordinators.get('chat-2')).toMatchObject({
    title: 'Release review',
    phase: 'working',
  })

  const live = store.coordinators.get('chat-1')
  expect(live?.receipts).toHaveLength(receiptsKept)
  expect(live?.receipts[0]?.id).toBe('operation-50')
  expect(live).toMatchObject({ phase: 'working', opening: chat.opening })
  expect(live?.error).toBeUndefined()
  expect(store.coordinators.get('chat-2')?.receipts).toEqual([])
  expect(store.coordinators.forRun('run-2')?.id).toBe('chat-2')

  const patches = (await eventArgs(temporary.home, 'v1.CoordinatorChatChanged')).filter(
    (args) => JSON.parse(args).id === 'chat-1',
  )
  expect(patches).toHaveLength(1 + 150 + 2)
  const largest = Math.max(...patches.slice(1).map((args) => args.length))
  expect(largest).toBeLessThan(JSON.stringify(receipt(149)).length * 2)
  expect(patches.slice(1).every((args) => !args.includes('Opening prompt.'))).toBe(true)
  expect(JSON.parse(patches.at(-1) ?? '{}')).toMatchObject({ unset: ['error'], lists: null })

  await store.close()
  await pretendStateSchemaChanged(temporary.home)
  store = await openStore({ directory })
  expect(store.coordinators.get('chat-1')).toEqual(live)
  expect(store.coordinators.get('chat-2')?.title).toBe('Release review')
  expect(
    store.coordinators
      .chats('factory-1')
      .map((c) => c.id)
      .sort(),
  ).toEqual(['chat-1', 'chat-2'])
})

test('a home with conversations saved before chats lists each one as an ended chat', async () => {
  const temporary = await makeTempHome()
  cleanup = temporary.cleanup
  const directory = path.join(temporary.home, 'store')
  store = await openStore({ directory })
  const first = { ...chatIn('factory-1', 'unused', 'run-1'), startedAt: '2026-01-01T00:00:00.000Z' }
  const second = chatIn('factory-1', 'unused', 'run-2')
  const other = chatIn('factory-2', 'unused', 'run-3')
  const old = ({ id: _id, ...chat }: StoredCoordinator) => chat
  const saved = (id: string, endedAt: string, chat: StoredCoordinator) => ({
    id,
    factoryId: chat.factoryId,
    endedAt,
    data: JSON.stringify({ id, startedAt: chat.startedAt ?? '', endedAt, chat: old(chat) }),
  })
  const withReceipt = { ...first, receipts: [receipt(1)] }
  const history: [string, unknown][] = [
    ['v1.CoordinatorChanged', { factoryId: 'factory-1', data: JSON.stringify(old(first)) }],
    [
      'v2.CoordinatorChanged',
      {
        factoryId: 'factory-1',
        set: '{}',
        unset: [],
        lists: JSON.stringify({ receipts: { put: [receipt(1)], keep: 1 } }),
      },
    ],
    [
      'v1.CoordinatorConversationSaved',
      saved('conversation-1', '2026-01-02T00:00:00.000Z', withReceipt),
    ],
    ['v1.CoordinatorChanged', { factoryId: 'factory-1', data: JSON.stringify(old(second)) }],
    [
      'v1.CoordinatorConversationSaved',
      saved('conversation-2', '2026-01-03T00:00:00.000Z', second),
    ],
    ['v1.CoordinatorConversationContinued', { id: 'conversation-1', factoryId: 'factory-1' }],
    ['v1.CoordinatorChanged', { factoryId: 'factory-1', data: JSON.stringify(old(withReceipt)) }],
    [
      'v2.CoordinatorChanged',
      { factoryId: 'factory-1', set: JSON.stringify({ phase: 'working' }), unset: [], lists: null },
    ],
    ['v1.CoordinatorChanged', { factoryId: 'factory-2', data: JSON.stringify(old(other)) }],
    ['v1.CoordinatorConversationSaved', saved('conversation-3', '2026-01-04T00:00:00.000Z', other)],
    ['v1.CoordinatorConversationDeleted', { id: 'conversation-3', runIds: ['run-3'] }],
  ]
  for (const [i] of history.entries())
    store.coordinators.save(chatIn('placeholder', `placeholder-${i}`, `placeholder-run-${i}`))
  await store.close()
  store = undefined
  await editEventlog(
    temporary.home,
    history
      .map(
        ([name, args]) =>
          `UPDATE eventlog SET name = '${name}', argsJson = '${JSON.stringify(args).replaceAll("'", "''")}'
           WHERE seqNumGlobal = (SELECT seqNumGlobal FROM eventlog
             WHERE name = 'v1.CoordinatorChatChanged' ORDER BY seqNumGlobal LIMIT 1);`,
      )
      .join('\n'),
  )
  await pretendStateSchemaChanged(temporary.home)
  store = await openStore({ directory })

  const chats = store.coordinators.chats('factory-1').sort((a, b) => a.id.localeCompare(b.id))
  expect(chats).toMatchObject([
    { id: 'conversation-2', endedAt: '2026-01-03T00:00:00.000Z', runIds: ['run-2'] },
    { id: 'factory-1', runIds: ['run-1'], phase: 'working', receipts: [receipt(1)] },
  ])
  expect(chats[1]?.endedAt).toBeUndefined()
  expect(store.coordinators.list().map((c) => c.id)).toEqual(['factory-1'])
  expect(store.coordinators.chats('factory-2')).toEqual([])
  expect(store.coordinators.chats('placeholder')).toEqual([])
  expect(store.coordinators.forRun('run-2')).toBeUndefined()
  expect(store.coordinators.endedForRun('run-2')?.id).toBe('conversation-2')

  const live = store.coordinators.get('factory-1')
  if (!live) throw new Error('the open chat is missing')
  store.coordinators.save({ ...live, receipts: [...live.receipts, receipt(2)] })
  store.coordinators.reopen('conversation-2')
  expect(store.coordinators.get('conversation-2')?.endedAt).toBeUndefined()
  expect(store.coordinators.forRun('run-2')?.id).toBe('conversation-2')
  store.coordinators.delete('factory-1')
  await store.persisted()
  expect(store.coordinators.chats('factory-1').map((c) => c.id)).toEqual(['conversation-2'])

  await store.close()
  await pretendStateSchemaChanged(temporary.home)
  store = await openStore({ directory })
  expect(store.coordinators.chats('factory-1')).toMatchObject([
    { id: 'conversation-2', runIds: ['run-2'], phase: 'ready' },
  ])
  expect(store.coordinators.list().map((c) => c.id)).toEqual(['conversation-2'])
})
