import type { CoordinatorChatSummary, Plan } from '@ted/protocol'
import { expect, test } from 'vitest'
import {
  agentChatRows,
  type ChatState,
  chatActionLabel,
  chatActions,
  coordinatorChatState,
  groupedRows,
  pickChat,
  planChatState,
  splitArchived,
} from '../src/renderer/agent-chats.ts'
import { coordinatorAgent, plannerAgent } from './support/fixtures.ts'

const coordinator = (fields: Partial<CoordinatorChatSummary>): CoordinatorChatSummary => ({
  id: 'c',
  factoryId: 'f1',
  title: 'Coordinator chat',
  status: 'ready',
  startedAt: '2026-11-10T10:00:00.000Z',
  lastAt: '2026-11-10T10:00:00.000Z',
  taskCount: 0,
  waiting: false,
  chatAgent: coordinatorAgent,
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
  chatAgent: plannerAgent,
  ...fields,
})

test('Coordinator chats and planning chats make one list, newest activity first, and archived ones split off newest archive first', () => {
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
        archivedAt: '2026-11-10T11:00:00.000Z',
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
  expect(rows[0]).toMatchObject({ title: 'Offline notes', waiting: true })
  expect(rows[0]?.archivedAt).toBeUndefined()
  expect(rows[1]).toMatchObject({ meta: '1 Task', chip: { label: 'Ready' } })
  expect(rows[2]).toMatchObject({
    meta: 'From NB-4',
    archivedAt: '2026-11-10T11:00:00.000Z',
    chip: { label: 'Archived' },
  })
  expect(rows[3]).toMatchObject({ waiting: true, chip: { label: 'Waiting on you' } })
  expect(rows[4]).toMatchObject({
    title: 'Coordinator chat',
    archivedAt: '2026-11-09T12:00:00.000Z',
    chip: { label: 'Archived' },
  })
  const { open, archived } = splitArchived(rows)
  expect(open.map((r) => r.ref.id)).toEqual(['p1', 'c1', 'c3'])
  expect(archived.map((r) => r.ref.id)).toEqual(['p2', 'c2'])
  const [waitingArchived] = agentChatRows(
    [coordinator({ waiting: true, endedAt: '2026-11-09T12:00:00.000Z' })],
    [],
  )
  expect(waitingArchived).toMatchObject({ waiting: false })

  expect(groupedRows(rows).map((g) => [g.agent, g.rows.map((r) => r.ref.id)])).toEqual([
    ['Coordinator', ['c1', 'c3', 'c2']],
    ['Planner', ['p1', 'p2']],
  ])
  expect(groupedRows(rows.filter((r) => r.agent === 'Planner')).map((g) => g.agent)).toEqual([
    'Planner',
  ])
  const triager = {
    ...coordinatorAgent,
    id: 'triager',
    name: 'Triager',
    source: 'factory' as const,
  }
  const custom = agentChatRows(
    [coordinator({ id: 'c4', title: '', chatAgent: triager }), coordinator({ id: 'c5' })],
    [plan({ id: 'p3' })],
  )
  expect(custom.find((r) => r.ref.id === 'c4')).toMatchObject({
    agent: 'Triager',
    title: 'Triager chat',
  })
  expect(groupedRows(custom).map((g) => g.agent)).toEqual(['Coordinator', 'Planner', 'Triager'])

  const [stopped] = agentChatRows([], [plan({ status: 'stopped', openRequest: true })])
  expect(stopped).toMatchObject({ waiting: true, chip: { label: 'Stopped' } })
  const [failed] = agentChatRows([], [plan({ status: 'failed' })])
  expect(failed).toMatchObject({ waiting: false })
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
  const onlyArchived = agentChatRows(
    [coordinator({ id: 'c1', endedAt: '2026-11-10T12:00:00.000Z' })],
    [],
  )
  expect(pickChat(onlyArchived, undefined)).toBeUndefined()
  expect(pickChat(onlyArchived, { agent: 'coordinator', id: 'c1' })).toEqual({
    agent: 'coordinator',
    id: 'c1',
  })
})

const menu = (state: ChatState) =>
  chatActions(state).map(
    ({ kind, divider }) => `${divider ? '— ' : ''}${chatActionLabel(kind, state)}`,
  )

test('every chat’s ⋯ menu comes from one list: Stop, Resume or Retry first, then Rename, then Archive and Delete; archived chats offer Unarchive and Delete', () => {
  expect(menu(coordinatorChatState(coordinator({ status: 'working' })))).toEqual([
    'Stop',
    '— Rename…',
    '— Archive',
    'Delete…',
  ])
  expect(menu(coordinatorChatState(coordinator({ status: 'ready' })))).toEqual([
    'Rename…',
    '— Archive',
    'Delete…',
  ])
  expect(menu(coordinatorChatState(coordinator({ status: 'failed' })))).toEqual([
    'Retry',
    '— Rename…',
    '— Archive',
    'Delete…',
  ])
  expect(
    menu(
      coordinatorChatState(
        coordinator({ status: 'failed', chatAgent: { ...coordinatorAgent, removed: true } }),
      ),
    ),
  ).toEqual(['Rename…', '— Archive', 'Delete…'])
  expect(menu(coordinatorChatState(coordinator({ endedAt: '2026-11-10T10:00:00.000Z' })))).toEqual([
    'Unarchive',
    '— Delete…',
  ])
  expect(menu(planChatState(plan({ status: 'waiting' })))).toEqual([
    'Stop',
    '— Rename…',
    '— Archive',
    'Delete…',
  ])
  expect(menu(planChatState(plan({ status: 'stopped' })))).toEqual([
    'Resume',
    '— Rename…',
    'Plan more from here…',
    '— Archive',
    'Delete…',
  ])
  expect(menu(planChatState(plan({ status: 'finished' })))).toEqual([
    'Rename…',
    'Plan more from here…',
    '— Archive',
    'Delete…',
  ])
  expect(
    menu(planChatState(plan({ status: 'stopped', archivedAt: '2026-11-10T10:00:00.000Z' }))),
  ).toEqual(['Unarchive', '— Plan more from here…', 'Delete…'])
})
