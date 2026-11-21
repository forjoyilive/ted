// @vitest-environment jsdom
import { type AutomationRequest, defaultMachineSettings, type PlanInboxItem } from '@ted/protocol'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { Inbox } from '../src/renderer/views/Inbox.tsx'
import { appState } from './support/app.tsx'
import { bridge, user } from './support/component.ts'
import { comment, createdAt, factory, plannerAgent, task } from './support/fixtures.ts'
import { requestApi } from './support/requests.ts'

function inboxProps() {
  bridge({})
  return {
    items: [],
    answered: [],
    factories: [factory()],
    factoryId: undefined,
    showAnswered: false,
    anyTasks: false,
    selected: undefined,
    onOpen: vi.fn(),
    onClear: vi.fn(),
    onFilter: vi.fn(),
    onShowAnswered: vi.fn(),
    onNewTask: vi.fn(),
  }
}

test('empty Inbox offers New Task, Show answered, and a Factory-filter reset', async () => {
  requestApi()
  const props = inboxProps()
  const view = render(<Inbox {...props} />)
  await user().click(screen.getByRole('button', { name: 'New Task…' }))
  expect(props.onNewTask).toHaveBeenCalledOnce()
  view.rerender(<Inbox {...props} anyTasks />)
  await user().click(screen.getByRole('button', { name: 'Show answered' }))
  expect(props.onShowAnswered).toHaveBeenCalledWith(true)
  view.rerender(<Inbox {...props} factoryId="f1" />)
  expect(screen.getAllByText(/widgets/)).toHaveLength(2)
  await user().click(screen.getByRole('button', { name: 'Show all Factories' }))
  expect(props.onFilter).toHaveBeenCalledWith({})
})

test('resolving a selected request opens the next request and clears when none remain', () => {
  requestApi()
  const props = inboxProps()
  const first = { task: task(), request: comment({ id: 'c1' }) }
  const second = { task: task(), request: comment({ id: 'c2', body: 'Second question?' }) }
  const view = render(<Inbox {...props} items={[first, second]} selected="c1" />)
  view.rerender(<Inbox {...props} items={[second]} selected="c1" />)
  expect(props.onOpen).toHaveBeenCalledWith(second)
  view.rerender(<Inbox {...props} items={[]} selected="c2" />)
  expect(props.onClear).toHaveBeenCalledOnce()
})

test('a Factory with Inbox items off has its requests marked as not counted', async () => {
  requestApi()
  const props = inboxProps()
  const onOpenNotifications = vi.fn()
  const items = [{ task: task(), request: comment({ id: 'c1' }) }]
  const view = render(<Inbox {...props} items={items} onOpenNotifications={onOpenNotifications} />)
  expect(screen.queryByText('Not counted')).toBeNull()
  view.rerender(
    <Inbox
      {...props}
      items={items}
      onOpenNotifications={onOpenNotifications}
      settings={{
        ...defaultMachineSettings,
        factoryNotifications: { f1: { inboxItems: false, taskMerged: false } },
      }}
    />,
  )
  expect(screen.getByText('Not counted')).toBeTruthy()
  expect(screen.getByText(/1 not counted or notified: Inbox items are off for/)).toBeTruthy()
  await user().click(screen.getByRole('button', { name: 'Change' }))
  expect(onOpenNotifications).toHaveBeenCalledOnce()
})

test('an Inbox row shows its Task’s or chat’s title large, with the request’s headline in the line below', () => {
  const props = inboxProps()
  const view = render(
    <Inbox
      {...props}
      items={[{ task: task(), request: comment({ id: 'q' }) }]}
      confirmations={[
        {
          source: 'coordinator',
          id: 'c1',
          factoryId: 'f1',
          createdAt,
          headline: 'Archive NB-3?',
          chatId: 'k1',
          chatTitle: 'Plan the release',
          agentName: 'Coordinator',
          confirmationKind: 'archive',
        },
      ]}
    />,
  )
  const row = (headline: string) => {
    const line = [...view.container.querySelectorAll('[data-headline]')].find(
      (el) => el.textContent === headline,
    )
    const button = line?.closest('button')
    return {
      title: button?.querySelector('[data-title]')?.textContent,
      below: line?.parentElement?.textContent,
    }
  }
  const taskRow = row('Use the default?')
  expect(taskRow.title).toBe('Sync notes')
  expect(taskRow.below).toMatch(/^NB-1 · Use the default\? · \S/)
  expect(row('Archive NB-3?')).toEqual({
    title: 'Plan the release',
    below: 'Coordinator · Archive NB-3?',
  })
})

test('the Inbox priority mark and the item’s menu change the Task’s priority without opening it', async () => {
  const props = inboxProps()
  const api = bridge({ setPriority: () => undefined })
  const item = { task: task(), request: comment({ id: 'c1', body: 'A question?' }) }
  const view = render(<Inbox {...props} items={[item]} />)
  const u = user()
  const mark = () => screen.getByRole('button', { name: /^Priority: .*Change priority of NB-1$/ })
  const pick = async (name: string) => {
    const menu = await screen.findByRole('menu', { name: 'Priority' })
    await u.click(within(menu).getByRole('menuitemradio', { name: new RegExp(name) }))
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'Priority' })).toBeNull())
  }

  await u.click(mark())
  await pick('High')
  expect(api.request).toHaveBeenCalledWith('setPriority', 'NB-1', 'high')

  view.rerender(<Inbox {...props} items={[{ ...item, task: task({ priority: 'high' }) }]} />)
  expect(mark().getAttribute('aria-label')).toBe('Priority: High. Change priority of NB-1')
  fireEvent.contextMenu(mark())
  expect(screen.queryByRole('menu', { name: /^NB-1 · / })).toBeNull()
  await pick('Urgent')
  expect(api.request).toHaveBeenCalledWith('setPriority', 'NB-1', 'urgent')

  fireEvent.contextMenu(screen.getByRole('button', { name: /A question\?/ }))
  const itemMenu = await screen.findByRole('menu', { name: /^NB-1 · / })
  await u.click(within(itemMenu).getByRole('menuitem', { name: 'Priority' }))
  await pick('Low')
  expect(api.request).toHaveBeenCalledWith('setPriority', 'NB-1', 'low')
  expect(props.onOpen).not.toHaveBeenCalled()

  view.rerender(
    <Inbox
      {...props}
      items={[
        { ...item, task: task({ archived: { at: createdAt, ended: { kind: 'never-started' } } }) },
      ]}
    />,
  )
  expect(screen.queryByRole('button', { name: /^Priority: / })).toBeNull()
})

test('Filter holds Group by, the order choices, the Factory chips and Answered; headings count, collapse and are remembered', async () => {
  const props = inboxProps()
  const question = {
    task: task(),
    request: comment({ id: 'q', body: 'A question?', createdAt: '2026-11-09T13:00:00Z' }),
  }
  const permission = {
    task: task(),
    request: comment({
      id: 'perm',
      kind: 'permission',
      body: 'Run the build',
      permission: { command: 'pnpm build' },
      createdAt: '2026-11-09T12:00:00Z',
    }),
  }
  const all = {
    ...props,
    items: [question, permission],
    factories: [factory(), factory({ id: 'f2', name: 'Other' })],
    onClearFilters: vi.fn(),
  }
  try {
    const view = render(<Inbox {...all} />)
    const headlines = () =>
      [...view.container.querySelectorAll('[data-headline]')].map((el) => el.textContent)
    const headings = () =>
      [...view.container.querySelectorAll('ul > li > button[aria-expanded]')].map((el) => [
        el.textContent,
        el.getAttribute('aria-expanded'),
      ])
    expect(headlines()).toEqual(['A question?', 'Run the build'])
    expect(headings()).toEqual([])
    expect(screen.queryByRole('switch', { name: 'Answered' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull()

    await user().click(screen.getByRole('button', { name: /^Filter/ }))
    const menu = screen.getByRole('menu', { name: 'Filter' })
    expect(
      within(menu).getByRole('menuitemradio', { name: /^None/ }).getAttribute('aria-checked'),
    ).toBe('true')
    await user().click(within(menu).getByRole('button', { name: 'Other 0' }))
    expect(props.onFilter).toHaveBeenCalledWith({ factoryId: 'f2' })
    await user().click(within(menu).getByRole('switch', { name: 'Answered' }))
    expect(props.onShowAnswered).toHaveBeenCalledWith(true)

    await user().click(within(menu).getByRole('menuitemradio', { name: /^Kind/ }))
    expect(headings()).toEqual([
      ['Blocking a Run1', 'true'],
      ['Questions1', 'true'],
    ])
    expect(headlines()).toEqual(['Run the build', 'A question?'])
    expect(screen.getByText('Grouped by Kind')).toBeTruthy()
    await user().click(within(menu).getByRole('menuitemradio', { name: /^Descending/ }))
    expect(headings().map(([text]) => text)).toEqual(['Questions1', 'Blocking a Run1'])
    expect(screen.getByText('Grouped by Kind · Groups descending')).toBeTruthy()
    await user().click(within(menu).getByRole('menuitemradio', { name: /^Ascending/ }))
    await user().click(within(menu).getByRole('menuitemradio', { name: /^Oldest first/ }))
    expect(screen.getByText('Grouped by Kind · Oldest first')).toBeTruthy()

    await user().click(screen.getByRole('button', { name: /^Blocking a Run/ }))
    expect(headings()).toEqual([
      ['Blocking a Run1', 'false'],
      ['Questions1', 'true'],
    ])
    expect(headlines()).toEqual(['A question?'])
    view.rerender(<Inbox {...all} selected="perm" />)
    expect(props.onOpen).not.toHaveBeenCalled()
    expect(props.onClear).not.toHaveBeenCalled()

    view.unmount()
    render(<Inbox {...all} />)
    const again = () =>
      [...document.querySelectorAll('ul > li > button[aria-expanded]')].map((el) => [
        el.textContent,
        el.getAttribute('aria-expanded'),
      ])
    expect(again()).toEqual([
      ['Blocking a Run1', 'false'],
      ['Questions1', 'true'],
    ])

    expect(screen.getByText('Grouped by Kind · Oldest first')).toBeTruthy()

    await user().click(screen.getByRole('button', { name: 'Clear' }))
    expect(all.onClearFilters).toHaveBeenCalledOnce()
    expect(again()).toEqual([])
    expect([...document.querySelectorAll('[data-headline]')].map((el) => el.textContent)).toEqual([
      'A question?',
      'Run the build',
    ])
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull()
  } finally {
    localStorage.removeItem('ted.inbox.grouping')
  }
})

test('Inbox interleaves request types newest first, filters without reordering, and selects the next visible row', async () => {
  const props = inboxProps()
  const onOpenPlan = vi.fn()
  const onOpenQuestion = vi.fn()
  const old = {
    task: task({ priority: 'urgent' }),
    request: comment({ id: 'old', body: 'Old urgent request', createdAt: '2026-11-09T10:00:00Z' }),
  }
  const recent = {
    task: task({ priority: 'low' }),
    request: comment({ id: 'recent', body: 'Recent request', createdAt: '2026-11-09T13:00:00Z' }),
  }
  const plan: PlanInboxItem = {
    plan: {
      id: 'p1',
      factoryId: 'f1',
      factoryKey: 'NB',
      title: 'Planning chat',
      message: '',
      agent: 'codex',
      status: 'working',
      createdTasks: 0,
      createdAt,
      lastAt: createdAt,
      chatAgent: plannerAgent,
    },
    request: {
      id: 'plan',
      planId: 'p1',
      runId: 'r1',
      kind: 'round',
      author: 'run',
      title: 'Plan request',
      body: '',
      createdAt: '2026-11-09T12:00:00Z',
    },
  }
  const question: AutomationRequest = {
    id: 'auto',
    automationId: 'a1',
    automationName: 'Automation',
    factoryId: 'f2',
    runId: 'r2',
    kind: 'question',
    body: 'Automation request',
    createdAt: '2026-11-09T11:00:00Z',
  }
  const all = {
    ...props,
    items: [old, recent],
    plans: [plan],
    questions: [question],
    factories: [factory(), factory({ id: 'f2', name: 'Other' })],
    onOpenPlan,
    onOpenQuestion,
  }
  const view = render(<Inbox {...all} selected="recent" />)
  const headlines = () =>
    [...view.container.querySelectorAll('[data-headline]')].map((el) => el.textContent)
  expect(headlines()).toEqual([
    'Recent request',
    'Plan request',
    'Automation request',
    'Old urgent request',
  ])
  await user().click(screen.getByText('Plan request', { exact: true }))
  expect(onOpenPlan).toHaveBeenCalledWith(plan)
  await user().click(screen.getByText('Automation request', { exact: true }))
  expect(onOpenQuestion).toHaveBeenCalledWith(question)

  view.rerender(<Inbox {...all} factoryId="f1" selected="recent" />)
  expect(headlines()).toEqual(['Recent request', 'Plan request', 'Old urgent request'])
  onOpenPlan.mockClear()
  props.onClear.mockClear()
  view.rerender(<Inbox {...all} factoryId="f1" items={[old]} selected="recent" />)
  expect(onOpenPlan).not.toHaveBeenCalled()
  expect(props.onClear).toHaveBeenCalledOnce()

  const newest = {
    ...recent,
    request: comment({ id: 'new', body: 'New request', createdAt: '2026-11-09T14:00:00Z' }),
  }
  props.onOpen.mockClear()
  onOpenPlan.mockClear()
  view.rerender(<Inbox {...all} items={[old, newest]} selected="plan" />)
  expect(headlines()).toEqual([
    'New request',
    'Plan request',
    'Automation request',
    'Old urgent request',
  ])
  expect(props.onOpen).not.toHaveBeenCalled()
  expect(onOpenPlan).not.toHaveBeenCalled()
  expect(screen.getByText('Plan request').closest('button')?.getAttribute('aria-current')).toBe(
    'true',
  )
})

test('Inbox equal timestamps keep a consistent order and Answered keeps answer-time order', () => {
  const props = inboxProps()
  const a = { task: task(), request: comment({ id: 'a', body: 'First', createdAt }) }
  const b = { task: task(), request: comment({ id: 'b', body: 'Second', createdAt }) }
  const view = render(<Inbox {...props} items={[b, a]} />)
  const headlines = () =>
    [...view.container.querySelectorAll('[data-headline]')].map((el) => el.textContent)
  expect(headlines()).toEqual(['First', 'Second'])
  view.rerender(<Inbox {...props} items={[a, b]} />)
  expect(headlines()).toEqual(['First', 'Second'])
  view.rerender(
    <Inbox
      {...props}
      showAnswered
      answered={[
        {
          ...a,
          request: { ...a.request, answer: { kind: 'answered', at: '2026-11-09T14:00:00Z' } },
        },
        {
          ...b,
          request: {
            ...b.request,
            createdAt: '2026-11-09T13:00:00Z',
            answer: { kind: 'answered', at: '2026-11-09T13:30:00Z' },
          },
        },
      ]}
    />,
  )
  expect(headlines()).toEqual(['First', 'Second'])
})

test('empty Inbox opens New Task and Show answered opens the empty Answered view', async () => {
  const a = appState()
  a.mount()
  const inbox = await screen.findByRole('region', { name: 'Inbox' })
  await user().click(await within(inbox).findByRole('button', { name: 'New Task…' }))
  const dialog = await screen.findByRole('dialog', { name: 'New Task' })
  await user().click(within(dialog).getByRole('button', { name: 'Close' }))
  await a.emitTask(task())
  await user().click(within(inbox).getByRole('button', { name: 'Show answered' }))
  expect(within(inbox).getByText('Nothing answered in the last 30 days')).toBeTruthy()
})

test('Inbox right-click offers request actions, then Task or plan actions, and never Open request', async () => {
  const props = inboxProps()
  const { handle } = requestApi()
  const stopTask = vi.fn(() => ({}))
  const stopPlan = vi.fn(() => ({}))
  const deletePlan = vi.fn(() => ({}))
  handle('stopTask', stopTask)
  handle('stopPlan', stopPlan)
  handle('deletePlan', deletePlan)
  handle('listTasks', () => [])
  const request = comment({ body: 'First line\nSecond line' })
  const item = { task: task({ preparation: 'ready' }), request }
  const question = {
    id: 'aq',
    kind: 'question' as const,
    automationId: 'a',
    runId: 'r',
    factoryId: 'f1',
    automationName: 'Weekly triage',
    body: 'Automation question\nFull details',
    choices: [],
    createdAt,
  }
  const onOpenQuestion = vi.fn()
  const onOpenPlan = vi.fn()
  const plan = {
    plan: {
      id: 'p1',
      factoryId: 'f1',
      factoryKey: 'NB',
      title: 'Planning menus',
      message: 'Plan menus',
      agent: 'claude' as const,
      status: 'waiting' as const,
      createdAt,
      lastAt: createdAt,
      createdTasks: 0,
      chatAgent: plannerAgent,
    },
    request: {
      id: 'pr1',
      planId: 'p1',
      runId: 'p1',
      kind: 'round' as const,
      author: 'run' as const,
      title: 'Planning question',
      body: 'Planning details\nSecond line',
      createdAt,
    },
  }
  render(
    <Inbox
      {...props}
      items={[item]}
      questions={[question]}
      plans={[plan]}
      onOpenQuestion={onOpenQuestion}
      onOpenPlan={onOpenPlan}
    />,
  )
  const u = user()
  const copy = vi.spyOn(navigator.clipboard, 'writeText')
  const labels = () => screen.getAllByRole('menuitem').map((e) => e.textContent)
  fireEvent.contextMenu(screen.getByText('First line'))
  expect(labels()).toEqual([
    'Snooze…',
    'Copy message text',
    'Stop Task',
    'Priority ›',
    'Copy Task ID',
    'Archive…',
    'Delete…',
  ])
  expect(within(screen.getByRole('menu')).getAllByRole('separator')).toHaveLength(1)
  await u.click(screen.getByRole('menuitem', { name: 'Copy message text' }))
  expect(copy).toHaveBeenCalledWith('First line\nSecond line')
  expect(props.onOpen).not.toHaveBeenCalled()
  fireEvent.contextMenu(screen.getByText('First line'))
  await u.click(screen.getByRole('menuitem', { name: 'Copy Task ID' }))
  expect(copy).toHaveBeenCalledWith('NB-1')
  fireEvent.contextMenu(screen.getByText('First line'))
  await u.click(screen.getByRole('menuitem', { name: 'Stop Task' }))
  await waitFor(() => expect(stopTask).toHaveBeenCalledWith('NB-1'))
  fireEvent.contextMenu(screen.getByText('First line'))
  await u.click(screen.getByRole('menuitem', { name: 'Archive…' }))
  await u.click(
    within(await screen.findByRole('dialog', { name: 'Archive NB-1?' })).getByRole('button', {
      name: 'Cancel',
    }),
  )
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.contextMenu(screen.getByText('Automation question'))
  expect(labels()).toEqual(['Snooze…', 'Copy message text'])
  expect(within(screen.getByRole('menu')).queryByRole('separator')).toBeNull()
  fireEvent.contextMenu(screen.getByText('Planning question'))
  expect(labels()).toEqual(['Snooze…', 'Copy message text', 'Stop plan', 'Delete plan…'])
  await u.click(screen.getByRole('menuitem', { name: 'Copy message text' }))
  expect(copy).toHaveBeenCalledWith('Planning details\nSecond line')
  fireEvent.contextMenu(screen.getByText('Planning question'))
  await u.click(screen.getByRole('menuitem', { name: 'Stop plan' }))
  await waitFor(() => expect(stopPlan).toHaveBeenCalledWith('p1'))
  fireEvent.contextMenu(screen.getByText('Planning question'))
  await u.click(screen.getByRole('menuitem', { name: 'Delete plan…' }))
  const confirm = await screen.findByRole('dialog', { name: 'Delete this planning chat?' })
  expect(deletePlan).not.toHaveBeenCalled()
  await u.click(within(confirm).getByRole('button', { name: 'Delete' }))
  await waitFor(() => expect(deletePlan).toHaveBeenCalledWith('p1'))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(onOpenQuestion).not.toHaveBeenCalled()
  expect(onOpenPlan).not.toHaveBeenCalled()
})
