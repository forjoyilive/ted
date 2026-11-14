// @vitest-environment jsdom
import type { AttachmentBytes, Automation, AutomationDetail, RunChat } from '@ted/protocol'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { DesignReviewContent } from '../src/renderer/components/DesignReview.tsx'
import { SidebarLayout } from '../src/renderer/components/ResizableSidebar.tsx'
import { saveSidebarWidths } from '../src/renderer/sidebar-widths.ts'
import {
  AutomationRunView,
  AutomationsPage,
  AutomationView,
} from '../src/renderer/views/Automations.tsx'
import { bridge, deferred, user } from './support/component.ts'
import { createdAt, factory } from './support/fixtures.ts'

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

test('Automations load in a six-column table and keep loaded rows during refresh', async () => {
  const pending = deferred<Automation[]>()
  const api = bridge({ listAutomations: () => pending.promise, automationTemplates: () => [] })
  render(
    <AutomationsPage
      factory={factory()}
      banners={null}
      onOpen={vi.fn()}
      onNew={vi.fn()}
      onOpenTask={vi.fn()}
    />,
  )
  const loading = screen.getByRole('status', { name: 'Loading Automations…' })
  const table = within(loading).getByRole('table', { hidden: true })
  expect(table.querySelectorAll('thead th')).toHaveLength(6)
  expect([...table.querySelectorAll('tbody tr')].map((row) => row.children.length)).toEqual([
    6, 6, 6,
  ])
  expect(loading.querySelector('button, [tabindex]')).toBeNull()
  await act(async () => pending.resolve([detail().automation]))
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.getAllByRole('columnheader')).toHaveLength(6)
  const refresh = deferred<Automation[]>()
  api.handle('listAutomations', () => refresh.promise)
  act(() => api.emit({ type: 'automation-updated', automationId: 'automation-a' }))
  expect(screen.getByRole('button', { name: 'Weekly triage' })).toBeTruthy()
  expect(screen.queryByRole('status')).toBeNull()
  await act(async () => refresh.resolve([detail().automation]))
})

for (const kind of ['details', 'run'] as const) {
  test(`${kind}: initial Automation failure offers retry and recovers without claiming deletion`, async () => {
    const pending = deferred<AutomationDetail>()
    const api = bridge({ getAutomation: () => pending.promise, getRunChat: chat })
    if (kind === 'details') saveSidebarWidths({ navigation: 210, details: 416 })
    render(kind === 'details' ? <SidebarLayout>{view(kind)}</SidebarLayout> : view(kind))
    expect(screen.getByRole('status')).toBeTruthy()
    if (kind === 'details') {
      expect(screen.getByRole('complementary', { name: 'Automation details' })).toBeTruthy()
      expect(
        screen
          .getByRole('separator', { name: 'Details sidebar width' })
          .getAttribute('aria-valuenow'),
      ).toBe('416')
      expect(screen.getByRole('heading', { name: 'History' })).toBeTruthy()
      const loading = screen.getByRole('status', { name: 'Loading Automation…' })
      const table = within(loading).getByRole('table', { hidden: true })
      expect(table.querySelectorAll('thead th')).toHaveLength(4)
      expect([...table.querySelectorAll('tbody tr')].map((row) => row.children.length)).toEqual([
        4, 4, 4,
      ])
      expect(screen.queryByRole('button', { name: 'Run now' })).toBeNull()
      expect(screen.queryByRole('switch')).toBeNull()
    }
    expect(screen.getByRole('button', { name: '← Automations' })).toBeTruthy()
    await act(async () => pending.reject(new Error('Temporary Automation failure')))
    expect(screen.getByRole('alert').textContent).toContain('Temporary Automation failure')
    expect(screen.queryByText('This Automation was deleted.')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    if (kind === 'details')
      expect(screen.queryByRole('complementary', { name: 'Automation details' })).toBeNull()
    const retry = deferred<AutomationDetail>()
    api.handle('getAutomation', () => retry.promise)
    await user().click(screen.getByRole('button', { name: 'Try again' }))
    expect(screen.getByRole('status')).toBeTruthy()
    expect(screen.getByRole('button', { name: '← Automations' })).toBeTruthy()
    if (kind === 'details') {
      expect(screen.getByRole('complementary', { name: 'Automation details' })).toBeTruthy()
      expect(
        screen
          .getByRole('separator', { name: 'Details sidebar width' })
          .getAttribute('aria-valuenow'),
      ).toBe('416')
    }
    await act(async () => retry.resolve(detail()))
    expect(screen.getByRole('heading', { name: /Weekly triage/ })).toBeTruthy()
    if (kind === 'details') {
      expect(screen.getByRole('complementary', { name: 'Automation details' })).toBeTruthy()
      expect(
        screen
          .getByRole('separator', { name: 'Details sidebar width' })
          .getAttribute('aria-valuenow'),
      ).toBe('416')
    }
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

test('Automation header right-click shares actions with ⋯ and Delete still asks for confirmation', async () => {
  const api = bridge({ getAutomation: detail, setAutomationOn: vi.fn(), deleteAutomation: vi.fn() })
  render(view('details'))
  const heading = await screen.findByRole('heading', { name: 'Weekly triage' })
  fireEvent.contextMenu(heading)
  await user().click(screen.getByRole('menuitem', { name: 'Turn on' }))
  await vi.waitFor(() =>
    expect(api.request).toHaveBeenCalledWith('setAutomationOn', 'automation-a', true),
  )
  await user().click(screen.getByRole('button', { name: 'Automation actions' }))
  await user().click(screen.getByRole('menuitem', { name: 'Delete…' }))
  expect(await screen.findByRole('dialog', { name: 'Delete “Weekly triage”?' })).toBeTruthy()
  expect(api.request).not.toHaveBeenCalledWith('deleteAutomation', 'automation-a')
})

test('a scheduled Check shows its command and agent step, its history row links the Tasks the agent created, noted and started, and Output opens the firing’s output', async () => {
  const shown = detail()
  const api = bridge({
    getAutomation: () => ({
      ...shown,
      automation: {
        ...shown.automation,
        name: 'Nightly tests',
        prompt: '',
        check: {
          command: 'pnpm check',
          timeout: '2h',
          runBy: '07:00',
          agentStep: 'on-failure',
          startTasks: true,
        },
      },
      history: [
        {
          id: 'firing-a',
          automationId: 'automation-a',
          trigger: 'scheduled',
          at: createdAt,
          startedAt: createdAt,
          finishedAt: createdAt,
          result: { kind: 'check-failed', tasks: [task('NB-4')] },
          runId: 'firing-a',
          check: {
            state: 'failed',
            exitCode: 1,
            durationMs: 90_000,
            failing: ['a.test.ts'],
            agent: { state: 'reported', noted: [task('NB-1')], started: [task('NB-4')] },
          },
        },
      ],
    }),
    automationRunOutput: () => ({
      text: ' FAIL  a.test.ts',
      log: '/ted/automation-checks/a/logs/firing-a.log',
    }),
  })
  render(view('details'))
  await screen.findByRole('heading', { name: 'Nightly tests' })
  expect(screen.getByText('pnpm check')).toBeTruthy()
  expect(screen.getByText('When the Check fails · Claude')).toBeTruthy()
  expect(screen.getByText('Starts the Tasks it creates')).toBeTruthy()
  expect(screen.getByText('Show prompt')).toBeTruthy()
  const row = screen.getByText(/^Failed · 1 failing test file/).closest('td')
  expect(row?.textContent).toMatch(/created NB-4.* · noted NB-1 · started NB-4/)
  await user().click(screen.getByRole('button', { name: 'Output' }))
  const dialog = await screen.findByRole('dialog', { name: /^Check output/ })
  expect(await within(dialog).findByText(' FAIL  a.test.ts', { normalizer: (t) => t })).toBeTruthy()
  expect(
    within(dialog).getByText('Full log: /ted/automation-checks/a/logs/firing-a.log'),
  ).toBeTruthy()
  expect(api.request).toHaveBeenCalledWith('automationRunOutput', 'firing-a')
})

function task(displayId: string) {
  return { id: displayId, displayId, title: displayId, stage: 'backlog' as const }
}

const automationEdits: { label: string; change: Partial<Automation> }[] = [
  { label: 'prompt', change: { prompt: 'Triage updated requests.' } },
  { label: 'schedule', change: { schedule: { kind: 'weekly', days: ['fri'], at: '14:00' } } },
  { label: 'agent', change: { agent: 'codex' } },
  { label: 'model', change: { model: 'updated-model' } },
  { label: 'effort', change: { effort: 'high' } },
]

for (const kind of ['list', 'details'] as const) {
  test.each(automationEdits)(
    `${kind}: a $label update closes an open menu before Duplicate`,
    async ({ change }) => {
      let current = detail()
      const api = bridge({
        getAutomation: () => current,
        listAutomations: () => [current.automation],
        automationTemplates: () => [],
        createAutomation: () => current.automation,
      })
      render(
        kind === 'details' ? (
          view('details')
        ) : (
          <AutomationsPage
            factory={factory()}
            banners={null}
            onOpen={vi.fn()}
            onNew={vi.fn()}
            onOpenTask={vi.fn()}
          />
        ),
      )
      const target =
        kind === 'details'
          ? await screen.findByRole('heading', { name: 'Weekly triage' })
          : await screen.findByRole('button', { name: 'Weekly triage' })
      fireEvent.contextMenu(target)
      expect(screen.getByRole('menuitem', { name: 'Duplicate' })).toBeTruthy()
      current = { ...current, automation: { ...current.automation, ...change } }
      act(() => api.emit({ type: 'automation-updated', automationId: 'automation-a' }))
      await vi.waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
      fireEvent.contextMenu(target)
      await user().click(screen.getByRole('menuitem', { name: 'Duplicate' }))
      await vi.waitFor(() =>
        expect(api.request).toHaveBeenCalledWith(
          'createAutomation',
          expect.objectContaining({
            ...change,
            name: 'Weekly triage copy',
            on: false,
          }),
        ),
      )
    },
  )
}
