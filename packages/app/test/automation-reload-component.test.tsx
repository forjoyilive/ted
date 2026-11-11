// @vitest-environment jsdom
import type { Automation, AutomationDetail, Run } from '@ted/protocol'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { expect, test } from 'vitest'
import {
  ConnectionContext,
  useAutomationOutcomes,
  useAutomationState,
  useAutomationsState,
} from '../src/renderer/data.ts'
import { bridge, deferred } from './support/component.ts'
import { createdAt, task } from './support/fixtures.ts'

function automation(fields: Partial<Automation> = {}): Automation {
  return {
    id: 'automation-a',
    factoryId: 'f1',
    factoryKey: 'NB',
    name: 'Weekly triage',
    prompt: 'Triage new requests.',
    schedule: { kind: 'weekly', days: ['mon'], at: '09:00' },
    timeZone: 'UTC',
    scheduleText: 'Every Monday',
    agent: 'claude',
    on: true,
    createdAt,
    nextFirings: [],
    failuresInARow: 0,
    totals: { runs: 1, tasksCreated: 1 },
    ...fields,
  }
}

const made = task({ id: 't-made', displayId: 'NB-7', title: 'Made', createdBy: 'automation' })

const withTask = (stage = made.stage) =>
  automation({
    last: {
      id: 'firing-a',
      automationId: 'automation-a',
      trigger: 'scheduled',
      at: createdAt,
      result: { kind: 'no-new-tasks' },
      created: [{ id: made.id, displayId: made.displayId, title: made.title, stage }],
    },
  })

function run(fields: Partial<Run> = {}): Run {
  return {
    id: 'firing-b',
    agent: 'claude',
    permissions: 'auto',
    prompt: '',
    cwd: '/tmp',
    state: 'working',
    startedAt: createdAt,
    ...fields,
  }
}

function calls(api: ReturnType<typeof bridge>, name: string): number {
  return api.request.mock.calls.filter(([called]) => called === name).length
}

const settle = () => act(async () => {})

test('events during a load collapse into one more request, and its answer wins', async () => {
  const first = deferred<Automation[]>()
  const api = bridge({ listAutomations: () => first.promise })
  const hook = renderHook(() => useAutomationsState(undefined))
  const second = deferred<Automation[]>()
  api.handle('listAutomations', () => second.promise)
  act(() => {
    for (let i = 0; i < 5; i++) api.emit({ type: 'automation-updated', automationId: 'a' })
  })
  expect(calls(api, 'listAutomations')).toBe(1)
  await act(async () => first.resolve([automation({ name: 'Old' })]))
  expect(calls(api, 'listAutomations')).toBe(2)
  act(() => {
    for (let i = 0; i < 5; i++) api.emit({ type: 'automation-updated', automationId: 'a' })
  })
  api.handle('listAutomations', () => [automation({ name: 'Newest' })])
  await act(async () => second.resolve([automation({ name: 'Newer' })]))
  await waitFor(() => expect(hook.result.current.value?.[0]?.name).toBe('Newest'))
  expect(calls(api, 'listAutomations')).toBe(3)
})

test('the list reloads only for events that change what it shows', async () => {
  const api = bridge({ listAutomations: () => [withTask()] })
  const hook = renderHook(() => useAutomationsState(undefined))
  await waitFor(() => expect(hook.result.current.value).toHaveLength(1))

  act(() => {
    api.emit({ type: 'task-updated', task: task({ id: 't-human', title: 'Changed' }) })
    api.emit({ type: 'task-updated', task: made })
    api.emit({ type: 'task-updated', task: task({ id: 't-other', createdBy: 'automation' }) })
    api.emit({ type: 'run-updated', run: run({ id: 'lead', taskId: 't-human' }) })
    api.emit({ type: 'run-updated', run: run({ id: 'sub', parentRunId: 'lead' }) })
  })
  await settle()
  expect(calls(api, 'listAutomations')).toBe(1)

  api.handle('listAutomations', () => [withTask('work')])
  act(() => api.emit({ type: 'task-updated', task: { ...made, stage: 'work' } }))
  await waitFor(() =>
    expect(hook.result.current.value?.[0]?.last?.created?.[0]?.stage).toBe('work'),
  )
  act(() => api.emit({ type: 'task-updated', task: { ...made, stage: 'work' } }))
  await settle()
  expect(calls(api, 'listAutomations')).toBe(2)

  act(() => api.emit({ type: 'run-updated', run: run() }))
  await settle()
  expect(calls(api, 'listAutomations')).toBe(3)
  act(() => api.emit({ type: 'run-updated', run: run() }))
  await settle()
  expect(calls(api, 'listAutomations')).toBe(3)
  act(() => api.emit({ type: 'run-updated', run: run({ state: 'idle' }) }))
  await settle()
  expect(calls(api, 'listAutomations')).toBe(4)

  act(() => api.emit({ type: 'task-deleted', taskId: 't-made' }))
  await settle()
  expect(calls(api, 'listAutomations')).toBe(5)
})

test('a Task that changes while a load is in flight reloads once more', async () => {
  const first = deferred<Automation[]>()
  const api = bridge({ listAutomations: () => first.promise })
  renderHook(() => useAutomationsState(undefined))
  const changed = task({ id: 't-new', createdBy: 'follow-up', stage: 'intake' })
  act(() => {
    api.emit({ type: 'task-updated', task: changed })
    api.emit({ type: 'task-updated', task: changed })
  })
  api.handle('listAutomations', () => [automation()])
  await act(async () => first.resolve([automation()]))
  await settle()
  expect(calls(api, 'listAutomations')).toBe(2)
  act(() => api.emit({ type: 'task-updated', task: changed }))
  await settle()
  expect(calls(api, 'listAutomations')).toBe(2)
})

test('a new connection epoch reloads the list', async () => {
  const api = bridge({ listAutomations: () => [automation()] })
  let epoch = 0
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ConnectionContext value={{ connection: { state: 'connected' }, epoch }}>
      {children}
    </ConnectionContext>
  )
  const hook = renderHook(() => useAutomationsState(undefined), { wrapper })
  await waitFor(() => expect(hook.result.current.value).toHaveLength(1))
  epoch = 1
  hook.rerender()
  await settle()
  expect(calls(api, 'listAutomations')).toBe(2)
})

test('one Automation reloads for its own changes, not another Automation’s', async () => {
  const detail: AutomationDetail = { automation: automation(), history: [], requests: [] }
  const api = bridge({ getAutomation: () => detail })
  const hook = renderHook(() => useAutomationState('automation-a'))
  await waitFor(() => expect(hook.result.current.value).toBeTruthy())
  act(() => api.emit({ type: 'automation-updated', automationId: 'automation-b' }))
  await settle()
  expect(calls(api, 'getAutomation')).toBe(1)
  act(() => api.emit({ type: 'automation-updated', automationId: 'automation-a' }))
  await settle()
  expect(calls(api, 'getAutomation')).toBe(2)
})

test('the app shell’s list reloads only when an Automation changes', async () => {
  const api = bridge({ listAutomations: () => [automation()] })
  const hook = renderHook(() => useAutomationOutcomes())
  await waitFor(() => expect(hook.result.current).toHaveLength(1))
  act(() => {
    api.emit({ type: 'task-updated', task: made })
    api.emit({ type: 'run-updated', run: run() })
  })
  await settle()
  expect(calls(api, 'listAutomations')).toBe(1)
  act(() => api.emit({ type: 'automation-updated', automationId: 'automation-a' }))
  await settle()
  expect(calls(api, 'listAutomations')).toBe(2)
})
