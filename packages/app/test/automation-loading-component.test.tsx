// @vitest-environment jsdom
import type { AttachmentBytes, AutomationDetail, RunChat } from '@ted/protocol'
import { act, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { DesignReviewContent } from '../src/renderer/components/DesignReview.tsx'
import { AutomationRunView, AutomationView } from '../src/renderer/views/Automations.tsx'
import { bridge, deferred, user } from './support/component.ts'
import { createdAt } from './support/fixtures.ts'

function detail(): AutomationDetail {
  return {
    automation: {
      id: 'automation-a',
      factoryId: 'f1',
      factoryKey: 'NB',
      name: 'Weekly triage',
      prompt: 'Triage new requests.',
      schedule: { kind: 'weekly', days: ['mon'], at: '09:00' },
      timeZone: 'UTC',
      scheduleText: 'Every Monday',
      agent: 'claude',
      on: false,
      createdAt,
      nextFirings: [],
      failuresInARow: 0,
      totals: { runs: 0, tasksCreated: 0 },
    },
    history: [],
    requests: [],
  }
}

function chat(): RunChat {
  return {
    run: {
      id: 'r1',
      name: 'Weekly triage',
      agent: 'claude',
      role: 'run',
      state: 'finished',
      current: true,
      startedAt: createdAt,
    },
    items: [{ kind: 'agent', id: 'message-a', text: 'Keep this Run content visible.' }],
  }
}

function view(kind: 'details' | 'run') {
  return kind === 'details' ? (
    <AutomationView
      automationId="automation-a"
      banners={null}
      settings={undefined}
      onBack={vi.fn()}
      onOpenRun={vi.fn()}
      onEdit={vi.fn()}
      onOpenAutomation={vi.fn()}
      onOpenTask={vi.fn()}
    />
  ) : (
    <AutomationRunView
      automationId="automation-a"
      runId="r1"
      tasks={[]}
      onBack={vi.fn()}
      onOpenTask={vi.fn()}
      onOpenAutomation={vi.fn()}
    />
  )
}

for (const kind of ['details', 'run'] as const) {
  test(`${kind}: initial Automation failure offers retry and recovers without claiming deletion`, async () => {
    const pending = deferred<AutomationDetail>()
    const api = bridge({ getAutomation: () => pending.promise, getRunChat: chat })
    render(view(kind))
    expect(screen.getByRole('status')).toBeTruthy()
    expect(screen.getByRole('button', { name: '← Automations' })).toBeTruthy()
    await act(async () => pending.reject(new Error('Temporary Automation failure')))
    expect(screen.getByRole('alert').textContent).toContain('Temporary Automation failure')
    expect(screen.queryByText('This Automation was deleted.')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    const retry = deferred<AutomationDetail>()
    api.handle('getAutomation', () => retry.promise)
    await user().click(screen.getByRole('button', { name: 'Try again' }))
    expect(screen.getByRole('status')).toBeTruthy()
    expect(screen.getByRole('button', { name: '← Automations' })).toBeTruthy()
    await act(async () => retry.resolve(detail()))
    expect(screen.getByRole('heading', { name: /Weekly triage/ })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  test(`${kind}: failed Automation refresh keeps content during error and retry, then handles real deletion`, async () => {
    const api = bridge({ getAutomation: detail, getRunChat: chat })
    render(view(kind))
    await screen.findByRole('heading', { name: /Weekly triage/ })
    api.handle('getAutomation', () => Promise.reject(new Error('Automation refresh failed')))
    act(() => api.emit({ type: 'automation-updated', automationId: 'automation-a' }))
    await screen.findByRole('alert')
    expect(screen.getByRole('heading', { name: /Weekly triage/ })).toBeTruthy()
    expect(screen.queryByText('This Automation was deleted.')).toBeNull()
    if (kind === 'run') expect(screen.getByText('Keep this Run content visible.')).toBeTruthy()
    const retry = deferred<AutomationDetail>()
    api.handle('getAutomation', () => retry.promise)
    await user().click(screen.getByRole('button', { name: 'Try again' }))
    expect(screen.getByRole('heading', { name: /Weekly triage/ })).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
    await act(async () => retry.resolve(detail()))
    expect(screen.queryByRole('alert')).toBeNull()
    api.handle('getAutomation', () => null)
    act(() => api.emit({ type: 'automation-deleted', automationId: 'automation-a' }))
    await screen.findByText('This Automation was deleted.')
    expect(screen.queryByRole('heading', { name: /Weekly triage/ })).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })
}

test('screenshot loading is non-interactive and does not queue a viewer to open later', async () => {
  const pending = deferred<AttachmentBytes>()
  bridge({ readAttachment: () => pending.promise })
  render(
    <DesignReviewContent
      design={{ screenshots: [{ hash: 'image-a', name: 'preview.png' }] }}
      files={[]}
      taskId="NB-1"
      commentId="c1"
    />,
  )
  const button = screen.getByRole('button', { name: 'View preview.png' })
  expect(button.hasAttribute('disabled')).toBe(true)
  await user().click(button)
  await act(async () => pending.resolve({ data: 'aW1hZ2U=' }))
  expect(button.hasAttribute('disabled')).toBe(false)
  expect(screen.queryByRole('dialog')).toBeNull()
  await user().click(button)
  expect(screen.getByRole('dialog', { name: 'preview.png' })).toBeTruthy()
})
