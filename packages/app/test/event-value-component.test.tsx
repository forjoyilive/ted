// @vitest-environment jsdom
import type { AgentHealth, Banner } from '@ted/protocol'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { useTaskChanges } from '../src/renderer/changes.ts'
import { useLineComments } from '../src/renderer/components/LineComments.tsx'
import {
  ConnectionContext,
  useAgentHealth,
  useBanners,
  useEventValue,
  useValidationObligations,
} from '../src/renderer/data.ts'
import { bridge, deferred } from './support/component.ts'
import { task } from './support/fixtures.ts'

function Value({ id, enabled = true }: { id: string; enabled?: boolean }) {
  const { value } = useEventValue<string | undefined>({
    initial: undefined,
    key: id,
    enabled,
    focus: true,
    load: async () => String(await window.ted.request('value', id)),
    event: (event) => (event.type === 'library-changed' ? 'reload' : undefined),
  })
  return <output>{value ?? 'Loading'}</output>
}

test('old resource and epoch loads cannot replace current state', async () => {
  const first = deferred<string>()
  const second = deferred<string>()
  const third = deferred<string>()
  const calls = [first, second, third]
  const api = bridge({ value: () => calls.shift()?.promise })
  const at = (epoch: number, id: string) => (
    <ConnectionContext value={{ connection: { state: 'connected' }, epoch }}>
      <Value id={id} />
    </ConnectionContext>
  )
  const view = render(at(0, 'a'))
  view.rerender(at(0, 'b'))
  expect(screen.getByText('Loading')).toBeTruthy()
  view.rerender(at(1, 'b'))
  await act(async () => {
    third.resolve('current')
  })
  await screen.findByText('current')
  await act(async () => {
    second.resolve('old epoch')
    first.resolve('old task')
  })
  expect(screen.getByText('current')).toBeTruthy()
  expect(api.request).toHaveBeenCalledTimes(3)
})

function Lists() {
  const banners = useBanners()
  const health = useAgentHealth()
  return (
    <>
      <output>{banners.map((b) => b.text).join(',')}</output>
      <output>{health.map((h) => h.version).join(',')}</output>
      <output>{health.map((h) => h.agent).join(',')}</output>
    </>
  )
}

test('banner deltas preserve untouched loaded banners and health keeps its newest timestamp and agent order', async () => {
  const banners = deferred<Banner[]>()
  const health = deferred<AgentHealth[]>()
  const api = bridge({ listBanners: () => banners.promise, agentHealth: () => health.promise })
  const banner = (id: string): Banner => ({
    id,
    text: id,
    problem: id,
    severity: 'warning',
    raisedAt: '2026-11-10T00:00:00Z',
  })
  const h: AgentHealth = {
    agent: 'codex',
    state: 'ready',
    minimumVersion: '1',
    version: 'new',
    pausedRuns: 0,
    checkedAt: '2026-11-10T02:00:00Z',
  }
  render(<Lists />)
  await act(async () => {
    api.emit({ type: 'banner-raised', banner: banner('new') })
    api.emit({ type: 'banner-cleared', id: 'removed' })
    api.emit({ type: 'agent-health-changed', health: h })
    banners.resolve([banner('removed'), banner('untouched')])
    health.resolve([
      { ...h, agent: 'antigravity', version: 'a' },
      { ...h, version: 'old', checkedAt: '2026-11-10T01:00:00Z' },
      { ...h, agent: 'claude', version: 'c' },
    ])
  })
  await screen.findByText('untouched,new')
  await screen.findByText('c,new,a')
  await screen.findByText('claude,codex,antigravity')
  await act(async () =>
    api.emit({
      type: 'agent-health-changed',
      health: { ...h, version: 'older', checkedAt: '2026-11-10T00:00:00Z' },
    }),
  )
  expect(screen.queryByText('older')).toBeNull()
})

test('disabled values do not load, and focus refresh stops on cleanup', async () => {
  let value = 'first'
  const api = bridge({ value: () => value })
  const view = render(<Value id="a" enabled={false} />)
  expect(api.request).not.toHaveBeenCalled()
  view.rerender(<Value id="a" />)
  await screen.findByText('first')
  value = 'focused'
  await act(async () => fireEvent.focus(window))
  await screen.findByText('focused')
  expect(api.request).toHaveBeenCalledTimes(2)
  view.unmount()
  fireEvent.focus(window)
  expect(api.request).toHaveBeenCalledTimes(2)
})

test('Library event refresh preserves a draft until Discard reloads the current version', async () => {
  const { LibraryPage } = await import('../src/renderer/settings/LibraryPage.tsx')
  const { defaultMachineSettings } = await import('@ted/protocol/settings')
  const { user } = await import('./support/component.ts')
  let version = 'v1'
  const api = bridge({
    library: () => ({
      path: '/library',
      version,
      agents: [],
      problems: [],
      stages: [{ id: 'review', inOrder: true, enabled: true, gate: true, from: 'ted' }],
    }),
  })
  render(<LibraryPage settings={defaultMachineSettings} dispatch={() => undefined} />)
  const gate = await screen.findByRole('switch', { name: 'Review sign-off' })
  await user().click(gate)
  expect(gate.getAttribute('aria-checked')).toBe('false')
  version = 'v2'
  await act(async () => api.emit({ type: 'library-changed' }))
  await screen.findByText('The Library changed on disk. Discard your changes to see it.')
  expect(gate.getAttribute('aria-checked')).toBe('false')
  await user().click(screen.getByRole('button', { name: 'Discard' }))
  await act(async () => {})
  expect(gate.getAttribute('aria-checked')).toBe('true')
  expect(
    screen.queryByText('The Library changed on disk. Discard your changes to see it.'),
  ).toBeNull()
})

function Changes({ t }: { t: ReturnType<typeof task> }) {
  const changes = useTaskChanges(t)
  const comments = useLineComments(t)
  return (
    <output>
      {changes?.repos.length ?? 'loading'} repos, {comments.length} comments
    </output>
  )
}

test('Changes and line comments coalesce task invalidations and refresh on focus', async () => {
  const t = task()
  const api = bridge({ taskChanges: () => ({ taskId: t.id, repos: [] }), lineComments: () => [] })
  vi.useFakeTimers()
  try {
    const view = render(<Changes t={t} />)
    await act(async () => {})
    expect(screen.getByText('0 repos, 0 comments')).toBeTruthy()
    const count = (name: string) => api.request.mock.calls.filter(([call]) => call === name).length
    await act(async () => {
      api.emit({ type: 'task-updated', task: t })
      api.emit({ type: 'task-updated', task: t })
      await vi.advanceTimersByTimeAsync(1499)
    })
    expect(count('taskChanges')).toBe(1)
    expect(count('lineComments')).toBe(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(count('taskChanges')).toBe(2)
    expect(count('lineComments')).toBe(2)
    await act(async () => fireEvent.focus(window))
    expect(count('taskChanges')).toBe(3)
    expect(count('lineComments')).toBe(3)
    await act(async () => api.emit({ type: 'line-comments-changed', taskId: t.id }))
    expect(count('lineComments')).toBe(4)
    view.unmount()
  } finally {
    vi.useRealTimers()
  }
})

function Obligations() {
  const value = useValidationObligations('NB-1')
  return (
    <output>
      {value === undefined ? 'Loading obligations' : value.satisfied ? 'Satisfied' : 'Blocked'}
    </output>
  )
}

test('an update during the first validation obligations read is followed by one more read', async () => {
  const first = deferred<import('@ted/protocol').ValidationObligations>()
  let reads = 0
  const api = bridge({
    validationObligations: () => {
      if (++reads === 1) {
        api.emit({ type: 'task-updated', task: task() })
        return first.promise
      }
      return { checkRuns: [], satisfied: true, cases: [], blockers: [] }
    },
  })
  render(
    <>
      <Obligations />
      <Obligations />
    </>,
  )
  await act(async () => api.emit({ type: 'task-updated', task: task() }))
  expect(reads).toBe(1)
  await act(async () =>
    first.resolve({ checkRuns: [], satisfied: false, cases: [], blockers: ['Old read'] }),
  )
  expect(await screen.findAllByText('Satisfied')).toHaveLength(2)
  expect(reads).toBe(2)
})

test('Library Save loads no second view for its own event, and reloads after one for an outside edit', async () => {
  const { LibraryPage } = await import('../src/renderer/settings/LibraryPage.tsx')
  const { defaultMachineSettings } = await import('@ted/protocol/settings')
  const { user } = await import('./support/component.ts')
  const library = (version: string, gate: boolean) => ({
    path: '/library',
    version,
    agents: [],
    problems: [],
    stages: [{ id: 'review', inOrder: true, enabled: true, gate, from: 'ted' }],
  })
  let onDisk = library('v1', true)
  let saving = deferred<ReturnType<typeof library>>()
  const api = bridge({ library: () => onDisk, saveLibrary: () => saving.promise })
  const loads = () => api.request.mock.calls.filter(([name]) => name === 'library').length
  render(<LibraryPage settings={defaultMachineSettings} dispatch={() => undefined} />)
  const gate = await screen.findByRole('switch', { name: 'Review sign-off' })

  await user().click(gate)
  await user().click(screen.getByRole('button', { name: 'Save' }))
  onDisk = library('v2', false)
  await act(async () => {
    api.emit({ type: 'library-changed', version: 'v2' })
    saving.resolve(library('v2', false))
  })
  await act(async () => api.emit({ type: 'library-changed', version: 'v2' }))
  expect(gate.getAttribute('aria-checked')).toBe('false')
  expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  expect(loads()).toBe(1)

  saving = deferred()
  await user().click(gate)
  await user().click(screen.getByRole('button', { name: 'Save' }))
  onDisk = library('v4', false)
  await act(async () => {
    api.emit({ type: 'library-changed', version: 'v3' })
    api.emit({ type: 'library-changed', version: 'v4' })
    saving.resolve(library('v3', true))
  })
  await waitFor(() => expect(gate.getAttribute('aria-checked')).toBe('false'))
  expect(loads()).toBe(2)
  expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
})
