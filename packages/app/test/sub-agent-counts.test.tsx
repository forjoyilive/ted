// @vitest-environment jsdom
import type { RunSummary, TaskRun } from '@ted/protocol'
import { render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { RunsSection } from '../src/renderer/components/RunsSection.tsx'
import { runsCollapsedSummary } from '../src/renderer/details.ts'
import { activeSubAgentCount } from '../src/renderer/sub-agents.ts'
import { Board } from '../src/renderer/views/Board.tsx'
import { appState } from './support/app.tsx'
import { bridge, expandFactory, required, user } from './support/component.ts'
import { createdAt, factory, task } from './support/fixtures.ts'

function run(fields: Partial<TaskRun> = {}): TaskRun {
  return {
    id: 'sub',
    agent: 'codex',
    role: 'sub-agent',
    name: 'Explore',
    state: 'working',
    ...fields,
  }
}

const runs = [
  run({ id: 'lead', role: 'lead' }),
  run({ id: 'old-lead', role: 'lead', state: 'idle' }),
  run({ id: 'working' }),
  run({ id: 'idle', state: 'idle' }),
  run({ id: 'waiting', state: 'waiting' }),
  run({ id: 'paused', paused: 'Offline' }),
  run({ id: 'reviewer', name: 'Reviewer' }),
  run({ id: 'loop', name: 'Loop check' }),
  run({ id: 'finished', state: 'finished' }),
]

test('active counts include every live sub-agent role, independently of name and Lead history', () => {
  expect(activeSubAgentCount(runs)).toBe(6)
  expect(activeSubAgentCount([])).toBe(0)
  expect(activeSubAgentCount([run({ state: 'finished' })])).toBe(0)
})

test('All Tasks and Factory List counts follow search, filters and live Task updates', async () => {
  const a = appState()
  const u = user()
  a.state.factories.push(factory({ id: 'f2', key: 'WEB', name: 'Website', position: 1 }))
  const first = task({ title: 'Explore counts', stage: 'work', runs, status: { kind: 'working' } })
  a.state.tasks = [
    first,
    task({ id: 'WEB-1', displayId: 'WEB-1', factoryId: 'f2', title: 'Website', runs: [run()] }),
    task({ id: 'NB-2', displayId: 'NB-2', runs: [run({ role: 'lead' })] }),
    task({
      id: 'NB-3',
      displayId: 'NB-3',
      archived: { at: createdAt, ended: { kind: 'never-started' } },
      runs: [run()],
    }),
  ]
  a.mount()
  await u.click(await screen.findByRole('button', { name: 'All Tasks' }))
  await screen.findByText('7 active Sub-Agents')
  const workGroup = screen.getByRole('button', { name: /^Work/ })
  await u.click(workGroup)
  expect(document.querySelector('[data-task="NB-1"]')).toBeNull()
  expect(screen.getByText('7 active Sub-Agents')).toBeTruthy()
  await u.click(workGroup)
  const row = required(document.querySelector<HTMLElement>('[data-task="NB-1"]'))
  const pill = within(row).getByRole('img', { name: '6 sub-agents running' })
  expect(pill.textContent).toBe('6')
  expect(pill.title).toBe('6 sub-agents running')
  expect(pill.dataset.working).toBe('true')
  expect(within(row).getByText('Working')).toBeTruthy()
  expect(
    within(required(document.querySelector<HTMLElement>('[data-task="NB-2"]'))).queryByLabelText(
      /sub-agents? running/,
    ),
  ).toBeNull()
  await u.type(screen.getByRole('searchbox'), 'Explore')
  expect(screen.getByText('6 active Sub-Agents in results')).toBeTruthy()
  await a.emitTask({
    ...first,
    runs: [run({ state: 'idle' }), run({ id: 'p', paused: 'Offline' })],
  })
  expect(screen.getByText('2 active Sub-Agents in results')).toBeTruthy()
  const idle = within(row).getByRole('img', { name: '2 sub-agents running' })
  expect(idle.textContent).toBe('2')
  expect(idle.dataset.working).toBe('false')
  await a.emitTask({ ...first, runs: [run()] })
  expect(screen.getByText('1 active Sub-Agent in results')).toBeTruthy()
  expect(within(row).getByRole('img', { name: '1 sub-agent running' }).textContent).toBe('1')
  await a.emitTask({ ...first, runs: [] })
  expect(screen.getByText('0 active Sub-Agents in results')).toBeTruthy()
  expect(within(row).queryByRole('img', { name: /sub-agents? running/ })).toBeNull()
  await u.clear(screen.getByRole('searchbox'))
  expect(screen.getByText('1 active Sub-Agent')).toBeTruthy()
  await expandFactory()
  await u.click(
    within(screen.getByRole('navigation', { name: 'Sidebar' })).getByRole('button', {
      name: 'Task views',
    }),
  )
  await u.click(
    within(screen.getByRole('navigation', { name: 'Sidebar' })).getByRole('button', {
      name: 'List',
    }),
  )
  expect(screen.getByText('0 active Sub-Agents')).toBeTruthy()
  await a.emitTask(first)
  expect(screen.getByText('6 active Sub-Agents')).toBeTruthy()
  await u.click(screen.getByRole('button', { name: 'Filter' }))
  await u.hover(screen.getByRole('menuitem', { name: /^Priority/ }))
  await u.click(screen.getByRole('menuitemcheckbox', { name: /Urgent/ }))
  expect(screen.getByText('0 active Sub-Agents in results')).toBeTruthy()
})

test('Board cards and aggregate follow the same search and updated Runs', async () => {
  bridge({ factoryBoard: () => ({ stages: [{ id: 'work', enabled: true, gate: false }] }) })
  const props = {
    title: 'widgets',
    factoryId: 'f1',
    factory: factory(),
    factories: [factory()],
    queue: [],
    filters: {},
    onFilters: vi.fn(),
    onOpen: vi.fn(),
    onOpenTask: vi.fn(),
    onNewTask: vi.fn(),
    onPlan: vi.fn(),
    onShowAllDone: vi.fn(),
  }
  const first = task({ title: 'Explore counts', stage: 'work', runs })
  const second = task({
    id: 'NB-2',
    displayId: 'NB-2',
    title: 'Other',
    stage: 'work',
    runs: [run()],
  })
  const view = render(<Board {...props} tasks={[first, second]} />)
  await screen.findByText('7 active Sub-Agents')
  const card = required(document.querySelector<HTMLElement>('[data-task="NB-1"]'))
  expect(within(card).getByRole('img', { name: '6 sub-agents running' }).textContent).toBe('6')
  await user().click(within(card).getByRole('button', { name: 'Explore counts' }))
  expect(props.onOpen).toHaveBeenCalledWith(first)
  await user().type(screen.getByRole('searchbox'), 'Explore')
  expect(screen.getByText('6 active Sub-Agents in results')).toBeTruthy()
  view.rerender(<Board {...props} tasks={[{ ...first, runs: [] }, second]} />)
  expect(screen.getByText('0 active Sub-Agents in results')).toBeTruthy()
  expect(within(card).queryByRole('img', { name: /sub-agents? running/ })).toBeNull()
})

test('Runs summaries keep active counts separate from Lead history and usage totals', () => {
  const history: RunSummary[] = runs.map((r) => ({
    ...r,
    startedAt: createdAt,
    current: r.id === 'lead',
    tokens: 100,
  }))
  render(<RunsSection runs={history} onOpenRun={vi.fn()} />)
  const section = within(screen.getByRole('tabpanel', { name: 'Runs' }))
  expect(section.getByRole('heading').textContent).toBe('Runs')
  expect(
    section.getByText(/^Task Lead working · 6 active Sub-Agents · 1 stopped · 900/),
  ).toBeTruthy()
  expect(
    runsCollapsedSummary([
      { ...run({ role: 'lead', state: 'finished' }), startedAt: createdAt, current: false },
    ]),
  ).toBe('0 active Sub-Agents · 1 stopped')
})
