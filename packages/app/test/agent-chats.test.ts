import type { CoordinatorChatSummary, Plan } from '@ted/protocol'
import { expect, test } from 'vitest'
import { agentChatRows, groupedRows, pickChat } from '../src/renderer/agent-chats.ts'

const coordinator = (fields: Partial<CoordinatorChatSummary>): CoordinatorChatSummary => ({
  id: 'c',
  factoryId: 'f1',
  title: 'Coordinator chat',
  status: 'ready',
  startedAt: '2026-11-10T10:00:00.000Z',
  lastAt: '2026-11-10T10:00:00.000Z',
  taskCount: 0,
  waiting: false,
  ...fields,
})

const plan = (fields: Partial<Plan>): Plan => ({
  id: 'p',
  factoryId: 'f1',
  factoryKey: 'NB',
  title: 'Plan',
  message: 'Plan',
  agent: 'claude',
  status: 'idle',
  createdAt: '2026-11-10T10:00:00.000Z',
  lastAt: '2026-11-10T10:00:00.000Z',
  createdTasks: 0,
  ...fields,
})

test('Coordinator chats and planning chats make one list, newest activity first, ended ones included', () => {
  const rows = agentChatRows(
    [
      coordinator({ id: 'c1', title: 'Triage', lastAt: '2026-11-10T12:00:00.000Z', taskCount: 1 }),
      coordinator({
        id: 'c2',
        title: '',
        lastAt: '2026-11-09T12:00:00.000Z',
        endedAt: '2026-11-09T12:00:00.000Z',
      }),
      coordinator({ id: 'c3', lastAt: '2026-11-10T09:00:00.000Z', waiting: true }),
    ],
    [
      plan({
        id: 'p1',
        title: 'Offline notes',
        status: 'waiting',
        lastAt: '2026-11-10T13:00:00.000Z',
      }),
      plan({
        id: 'p2',
        status: 'finished',
        lastAt: '2026-11-10T11:00:00.000Z',
        fromTask: { id: 't1', displayId: 'NB-4', title: 'Big one' },
      }),
    ],
  )
  expect(rows.map((r) => `${r.agent}:${r.ref.id}`)).toEqual([
    'Planner:p1',
    'Coordinator:c1',
    'Planner:p2',
    'Coordinator:c3',
    'Coordinator:c2',
  ])
  expect(rows[0]).toMatchObject({ title: 'Offline notes', waiting: true, ended: false })
  expect(rows[1]).toMatchObject({ meta: '1 Task', chip: { label: 'Ready' } })
  expect(rows[2]).toMatchObject({ meta: 'From NB-4', ended: true, chip: { label: 'Finished' } })
  expect(rows[3]).toMatchObject({ waiting: true, chip: { label: 'Waiting on you' } })
  expect(rows[4]).toMatchObject({
    title: 'Coordinator chat',
    ended: true,
    chip: { label: 'Ended' },
  })

  expect(groupedRows(rows).map((g) => [g.agent, g.rows.map((r) => r.ref.id)])).toEqual([
    ['Coordinator', ['c1', 'c3', 'c2']],
    ['Planner', ['p1', 'p2']],
  ])
  expect(groupedRows(rows.filter((r) => r.agent === 'Planner')).map((g) => g.agent)).toEqual([
    'Planner',
  ])
})

test('Agents opens the chat last open in the Factory, else the newest, else nothing', () => {
  const rows = agentChatRows(
    [coordinator({ id: 'c1', lastAt: '2026-11-10T12:00:00.000Z' })],
    [plan({ id: 'p1', lastAt: '2026-11-10T13:00:00.000Z' })],
  )
  expect(pickChat(rows, { agent: 'coordinator', id: 'c1' })).toEqual({
    agent: 'coordinator',
    id: 'c1',
  })
  expect(pickChat(rows, { agent: 'coordinator', id: 'deleted' })).toEqual({
    agent: 'planner',
    id: 'p1',
  })
  expect(pickChat(rows, { agent: 'planner', id: 'c1' })).toEqual({ agent: 'planner', id: 'p1' })
  expect(pickChat([], undefined)).toBeUndefined()
})
