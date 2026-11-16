// @vitest-environment jsdom
import type { AgentHealth, Automation, AutomationDetail, Run, RunSlots } from '@ted/protocol'
import { noChecks } from '@ted/protocol/slots'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  ConnectionContext,
  useAutomationOutcomes,
  useAutomationState,
  useAutomationsState,
} from '../src/renderer/data.ts'
import type { TedEvent } from '../src/renderer/ted.ts'
import { bridge, deferred } from './support/component.ts'
import { createdAt, task } from './support/fixtures.ts'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
})

afterEach(() => {
  vi.useRealTimers()
})

type Api = ReturnType<typeof bridge>

function emit(api: Api, ...events: TedEvent[]) {
  act(() => {
    for (const event of events) {
      vi.setSystemTime(Date.now() + 2_000)
      api.emit(event)
    }
  })
}

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
    cwd: '/home/automations/automation-a',
    state: 'working',
    startedAt: createdAt,
    ...fields,
  }
}

function health(fields: Partial<AgentHealth> = {}): AgentHealth {
  return {
    agent: 'claude',
    state: 'ready',
    minimumVersion: '1.0.0',
    pausedRuns: 0,
    checkedAt: createdAt,
    ...fields,
  }
}

function slots(automationId: string, place: number): RunSlots {
  return {
    limit: 3,
    working: 0,
    queued: 1,
    holders: [],
    queue: [
      {
        kind: 'automation',
        place,
        runId: `run-${automationId}`,
        automationId,
        name: '',
        factoryId: 'f1',
      },
    ],
    factories: [],
    checks: noChecks,
  }
}

function calls(api: Api, name: string): number {
  return api.request.mock.calls.filter(([called]) => called === name).length
}

const settle = () => act(async () => {})

test('events during a load collapse into one more request, and its answer wins', async () => {
  const first = deferred<Automation[]>()
  const api = bridge({ listAutomations: () => first.promise })
  const hook = renderHook(() => useAutomationsState(undefined))
  const second = deferred<Automation[]>()
  api.handle('listAutomations', () => second.promise)
  for (let i = 0; i < 5; i++) emit(api, { type: 'automation-updated', automationId: 'a' })
  expect(calls(api, 'listAutomations')).toBe(1)
  await act(async () => first.resolve([automation({ name: 'Old' })]))
  expect(calls(api, 'listAutomations')).toBe(2)
  for (let i = 0; i < 5; i++) emit(api, { type: 'automation-updated', automationId: 'a' })
  api.handle('listAutomations', () => [automation({ name: 'Newest' })])
  await act(async () => second.resolve([automation({ name: 'Newer' })]))
  await waitFor(() => expect(hook.result.current.value?.[0]?.name).toBe('Newest'))
  expect(calls(api, 'listAutomations')).toBe(3)
})

test('the list reloads only for events that change what it shows', async () => {
  const api = bridge({ listAutomations: () => [withTask()] })
  const hook = renderHook(() => useAutomationsState(undefined))
  await waitFor(() => expect(hook.result.current.value).toHaveLength(1))

  const other = task({ id: 't-other', createdBy: 'automation' })
  emit(
    api,
    { type: 'task-updated', task: task({ id: 't-human', title: 'Changed' }) },
    { type: 'task-updated', task: made },
    { type: 'task-updated', task: other },
    { type: 'task-updated', task: { ...other, stage: 'work' } },
    { type: 'run-updated', run: run({ id: 'lead', taskId: 't-human' }) },
    { type: 'run-updated', run: run({ id: 'sub', parentRunId: 'lead' }) },
    { type: 'run-updated', run: run({ id: 'chat', cwd: '/home/side-chats/automation-a' }) },
    { type: 'run-updated', run: run({ id: 'theirs', cwd: '/home/automations/automation-b' }) },
    { type: 'slots-changed', slots: slots('automation-b', 1) },
    { type: 'slots-changed', slots: slots('automation-b', 2) },
  )
  await settle()
  expect(calls(api, 'listAutomations')).toBe(1)

  api.handle('listAutomations', () => [withTask('work')])
  emit(api, { type: 'task-updated', task: { ...made, stage: 'work' } })
  await waitFor(() =>
    expect(hook.result.current.value?.[0]?.last?.created?.[0]?.stage).toBe('work'),
  )
  emit(api, { type: 'task-updated', task: { ...made, stage: 'work' } })
  await settle()
  expect(calls(api, 'listAutomations')).toBe(2)

  emit(api, { type: 'run-updated', run: run() })
  await settle()
  expect(calls(api, 'listAutomations')).toBe(3)
  emit(api, { type: 'run-updated', run: run() })
  await settle()
  expect(calls(api, 'listAutomations')).toBe(3)
  emit(api, { type: 'run-updated', run: run({ state: 'idle' }) })
  await settle()
  expect(calls(api, 'listAutomations')).toBe(4)

  emit(api, { type: 'task-deleted', taskId: 't-made' })
  await settle()
  expect(calls(api, 'listAutomations')).toBe(5)

  emit(api, { type: 'slots-changed', slots: slots('automation-a', 2) })
  await settle()
  expect(calls(api, 'listAutomations')).toBe(6)
  emit(api, { type: 'slots-changed', slots: slots('automation-a', 2) })
  await settle()
  expect(calls(api, 'listAutomations')).toBe(6)
  emit(api, { type: 'slots-changed', slots: slots('automation-a', 1) })
  await settle()
  expect(calls(api, 'listAutomations')).toBe(7)
})

test('agent health reloads the list only when an agent’s pause changes', async () => {
  const api = bridge({ listAutomations: () => [automation()] })
  const hook = renderHook(() => useAutomationsState(undefined))
  await waitFor(() => expect(hook.result.current.value).toHaveLength(1))
  emit(api, { type: 'agent-health-changed', health: health() })
  await settle()
  expect(calls(api, 'listAutomations')).toBe(2)
  emit(
    api,
    { type: 'agent-health-changed', health: health({ checkedAt: '2026-11-11T10:00:00.000Z' }) },
    {
      type: 'agent-health-changed',
      health: health({
        planUsage: { windows: [{ window: 'weekly', percent: 41 }], at: createdAt, from: 'run' },
      }),
    },
  )
  await settle()
  expect(calls(api, 'listAutomations')).toBe(2)
  emit(api, {
    type: 'agent-health-changed',
    health: health({ state: 'usage-limit', reason: 'Claude usage limit' }),
  })
  await settle()
  expect(calls(api, 'listAutomations')).toBe(3)
  emit(api, { type: 'agent-health-changed', health: health() })
  await settle()
  expect(calls(api, 'listAutomations')).toBe(4)
})

test('events close together reload once at first and once more a second later', async () => {
  const api = bridge({ listAutomations: () => [automation()] })
  const hook = renderHook(() => useAutomationsState(undefined))
  await waitFor(() => expect(hook.result.current.value).toHaveLength(1))
  vi.setSystemTime(Date.now() + 2_000)
  act(() => api.emit({ type: 'automation-updated', automationId: 'automation-a' }))
  await settle()
  expect(calls(api, 'listAutomations')).toBe(2)
  act(() => {
    for (let i = 0; i < 5; i++)
      api.emit({ type: 'automation-updated', automationId: 'automation-a' })
  })
  await settle()
  expect(calls(api, 'listAutomations')).toBe(2)
  await waitFor(() => expect(calls(api, 'listAutomations')).toBe(3), { timeout: 3_000 })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300))
  })
  expect(calls(api, 'listAutomations')).toBe(3)
})

test('a Task that changes while a load is in flight reloads once more', async () => {
  const first = deferred<Automation[]>()
  const api = bridge({ listAutomations: () => first.promise })
  renderHook(() => useAutomationsState(undefined))
  const changed = task({ id: 't-new', createdBy: 'follow-up', stage: 'intake' })
  emit(api, { type: 'task-updated', task: changed }, { type: 'task-updated', task: changed })
  api.handle('listAutomations', () => [automation()])
  await act(async () => first.resolve([automation()]))
  await settle()
  expect(calls(api, 'listAutomations')).toBe(2)
  emit(api, { type: 'task-updated', task: changed })
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
  emit(api, { type: 'automation-updated', automationId: 'automation-b' })
  await settle()
  expect(calls(api, 'getAutomation')).toBe(1)
  emit(api, { type: 'automation-updated', automationId: 'automation-a' })
  await settle()
  expect(calls(api, 'getAutomation')).toBe(2)
})

test('the app shell’s list reloads only when an Automation changes', async () => {
  const api = bridge({ listAutomations: () => [automation()] })
  const hook = renderHook(() => useAutomationOutcomes())
  await waitFor(() => expect(hook.result.current).toHaveLength(1))
  emit(api, { type: 'task-updated', task: made }, { type: 'run-updated', run: run() })
  await settle()
  expect(calls(api, 'listAutomations')).toBe(1)
  emit(api, { type: 'automation-updated', automationId: 'automation-a' })
  await settle()
  expect(calls(api, 'listAutomations')).toBe(2)
})
