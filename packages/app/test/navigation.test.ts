import { describe, expect, test } from 'vitest'
import {
  type DashboardViewState,
  dashboardState,
  pickFactories,
  rememberDashboard,
  shownFactoryIds,
} from '../src/renderer/dashboard.ts'
import {
  backLink,
  currentFactoryId,
  type History,
  type HistoryAction,
  historyReducer,
  initialNavigation,
  type Navigation,
  navigate,
  newPlan,
  startHistory,
  withHistory,
} from '../src/renderer/navigation.ts'

const tasks = [
  { id: 't1', factoryId: 'nb' },
  { id: 't2', factoryId: 'ms' },
]

function after(...actions: Parameters<typeof navigate>[1][]): Navigation {
  return actions.reduce(navigate, initialNavigation)
}

describe('navigation', () => {
  test('opening a Planning request retains its target and clears it on ordinary navigation', () => {
    const targeted = navigate(after({ type: 'open-factory', factoryId: 'nb' }), {
      type: 'open-plan',
      factoryId: 'nb',
      planId: 'p1',
      requestId: 'round2',
    })
    expect(targeted).toMatchObject({
      planId: 'p1',
      requestId: 'round2',
      screen: { kind: 'factory', factoryId: 'nb', view: 'agents' },
    })
    expect(
      navigate(targeted, { type: 'open-plan', factoryId: 'nb', planId: 'p1' }).requestId,
    ).toBeUndefined()
  })

  test('starts on the Inbox with no current Factory', () => {
    expect(initialNavigation.screen).toEqual({ kind: 'inbox' })
    expect(currentFactoryId(initialNavigation, tasks)).toBeUndefined()
  })

  test('opening a Factory shows the Dashboard narrowed to it the first time and its last-used View after', () => {
    expect(after({ type: 'open-factory', factoryId: 'nb' })).toMatchObject({
      screen: { kind: 'dashboard', dashboard: { factoryIds: ['nb'] } },
      lastFactoryId: 'nb',
    })

    const back = after(
      { type: 'open-factory', factoryId: 'nb' },
      { type: 'open', screen: { kind: 'factory', factoryId: 'nb', view: 'list' } },
      { type: 'open-factory', factoryId: 'ms' },
      { type: 'open-factory', factoryId: 'nb' },
    )
    expect(back.screen).toEqual({ kind: 'factory', factoryId: 'nb', view: 'list' })
  })

  test('the current Factory is the one on screen, and the last one when nothing is open', () => {
    const onBoard = after({ type: 'open-factory', factoryId: 'nb' })
    expect(currentFactoryId(onBoard, tasks)).toBe('nb')

    const inbox = navigate(onBoard, { type: 'open', screen: { kind: 'inbox' } })
    expect(currentFactoryId(inbox, tasks)).toBe('nb')

    const taskOpen = after(
      { type: 'open-factory', factoryId: 'nb' },
      { type: 'open', screen: { kind: 'all-tasks' } },
      { type: 'open-task', taskId: 't2', factoryId: 'ms' },
    )
    expect(currentFactoryId(taskOpen, tasks)).toBe('ms')

    const closed = navigate(taskOpen, { type: 'close-task' })
    expect(currentFactoryId(closed, tasks)).toBe('ms')
  })

  test('a Task opened from the Board, the List or All Tasks has a back link to it', () => {
    expect(
      backLink(
        after({ type: 'open-factory', factoryId: 'nb' }, { type: 'open-task', taskId: 't1' }),
      ),
    ).toBe('← Dashboard')
    expect(
      backLink(
        after(
          { type: 'open', screen: { kind: 'factory', factoryId: 'nb', view: 'list' } },
          { type: 'open-task', taskId: 't1' },
        ),
      ),
    ).toBe('← List')
    expect(
      backLink(
        after({ type: 'open', screen: { kind: 'all-tasks' } }, { type: 'open-task', taskId: 't1' }),
      ),
    ).toBe('← All Tasks')
    expect(
      backLink(
        after(
          { type: 'open-plan', factoryId: 'nb', planId: 'p1' },
          { type: 'open-task', taskId: 't1' },
        ),
      ),
    ).toBe('← Agents')
    expect(backLink(after({ type: 'open', screen: { kind: 'all-tasks' } }))).toBeUndefined()
  })

  test('opening another screen closes the open Task', () => {
    const state = after(
      { type: 'open', screen: { kind: 'all-tasks' } },
      { type: 'open-task', taskId: 't1' },
      { type: 'open', screen: { kind: 'inbox' } },
    )

    expect(state.taskId).toBeUndefined()
  })

  test('Settings opens over where the human was, on General', () => {
    const before = after(
      { type: 'open-factory', factoryId: 'nb' },
      { type: 'open-task', taskId: 't1', factoryId: 'nb' },
    )

    const settings = navigate(before, { type: 'open-settings' })

    expect(settings.settings).toEqual({ section: 'general' })
    expect(navigate(settings, { type: 'close-settings' })).toEqual(before)
  })

  test('Settings opens on General again after the human left another section', () => {
    const inDeveloper = after(
      { type: 'open-settings' },
      { type: 'open-settings', section: 'developer' },
    )
    expect(navigate(inDeveloper, { type: 'open-settings' }).settings).toEqual({
      section: 'developer',
    })

    const reopened = after(
      { type: 'open-settings', section: 'developer' },
      { type: 'close-settings' },
      { type: 'open-settings' },
    )
    expect(reopened.settings).toEqual({ section: 'general' })
  })

  test('a Factory row in Settings leaves Settings for that Factory’s settings page', () => {
    const state = after(
      { type: 'open', screen: { kind: 'all-tasks' } },
      { type: 'open-settings' },
      { type: 'open', screen: { kind: 'factory', factoryId: 'ms', view: 'settings' } },
    )

    expect(state.settings).toBeUndefined()
    expect(state.screen).toEqual({ kind: 'factory', factoryId: 'ms', view: 'settings' })
    expect(currentFactoryId(state, tasks)).toBe('ms')
  })

  test('an Automation opens on its Factory’s Automations page, and back goes one level up', () => {
    const run = after(
      { type: 'open-automation', automationId: 'a1', factoryId: 'nb' },
      { type: 'open-automation', automationId: 'a1', factoryId: 'nb', runId: 'r1' },
    )
    expect(run.screen).toEqual({ kind: 'factory', factoryId: 'nb', view: 'automations' })
    expect(run.automation).toEqual({ id: 'a1', runId: 'r1' })
    expect(currentFactoryId(run, tasks)).toBe('nb')

    const view = navigate(run, { type: 'close-automation' })
    expect(view.automation).toEqual({ id: 'a1' })
    expect(navigate(view, { type: 'close-automation' }).automation).toBeUndefined()
    expect(navigate(run, { type: 'open', screen: { kind: 'all-tasks' } }).automation).toBe(
      undefined,
    )
  })

  test('an Automation question opens its Run beside the Inbox; back opens the Automation', () => {
    const inbox = after(
      { type: 'open-task', taskId: 't1' },
      {
        type: 'open-automation',
        automationId: 'a1',
        factoryId: 'nb',
        runId: 'r1',
        requestId: 'q1',
      },
    )
    expect(inbox.screen).toEqual({ kind: 'inbox' })
    expect(inbox.taskId).toBeUndefined()
    expect(inbox.requestId).toBe('q1')
    expect(inbox.automation).toEqual({ id: 'a1', runId: 'r1' })

    const back = navigate(inbox, { type: 'close-automation' })
    expect(back.screen).toEqual({ kind: 'factory', factoryId: 'nb', view: 'automations' })
    expect(back.automation).toEqual({ id: 'a1' })
    expect(back.requestId).toBeUndefined()

    expect(navigate(inbox, { type: 'open-task', taskId: 't2' }).automation).toBeUndefined()
  })
})

describe('back and forward (⌘[ and ⌘])', () => {
  function walk(...actions: HistoryAction[]): History {
    return actions.reduce(withHistory, startHistory(initialNavigation))
  }

  test('Factory settings pages are places, and opening the Factory again starts on General', () => {
    const settings = { kind: 'factory', factoryId: 'nb', view: 'settings' } as const
    const state = walk(
      { type: 'open', screen: settings },
      { type: 'open', screen: { ...settings, section: 'checks' } },
      { type: 'open', screen: { ...settings, section: 'notes' } },
      { type: 'back' },
    )
    expect(state.now.screen).toEqual({ ...settings, section: 'checks' })
    const again = withHistory(withHistory(state, { type: 'open', screen: { kind: 'inbox' } }), {
      type: 'open-factory',
      factoryId: 'nb',
    })
    expect(again.now.screen).toEqual(settings)
  })

  test('back returns to each earlier place in turn, and forward retraces them', () => {
    const state = walk(
      { type: 'open', screen: { kind: 'all-tasks' } },
      { type: 'open-task', taskId: 't1', factoryId: 'nb' },
      { type: 'open-settings' },
      { type: 'back' },
    )
    expect(state.now.settings).toBeUndefined()
    expect(state.now.taskId).toBe('t1')

    const twice = walk(
      { type: 'open', screen: { kind: 'all-tasks' } },
      { type: 'open-task', taskId: 't1', factoryId: 'nb' },
      { type: 'back' },
      { type: 'back' },
    )
    expect(twice.now.screen).toEqual({ kind: 'inbox' })
    expect(twice.now.taskId).toBeUndefined()

    const again = withHistory(withHistory(twice, { type: 'forward' }), { type: 'forward' })
    expect(again.now.screen).toEqual({ kind: 'all-tasks' })
    expect(again.now.taskId).toBe('t1')
  })

  test('going somewhere new after going back drops the forward places', () => {
    const state = walk(
      { type: 'open', screen: { kind: 'all-tasks' } },
      { type: 'back' },
      { type: 'open-factory', factoryId: 'nb' },
      { type: 'forward' },
    )
    expect(state.now.screen).toEqual({ kind: 'dashboard', dashboard: { factoryIds: ['nb'] } })
  })

  test('history retains a continuation source without leaking it into another place or new plan', () => {
    let history = walk({ type: 'open-plan', factoryId: 'nb', from: 'p1' })
    history = withHistory(history, { type: 'open', screen: { kind: 'inbox' } })
    expect(history.now.planFrom).toBeUndefined()

    history = withHistory(history, { type: 'back' })
    expect(history.now).toMatchObject({
      screen: { kind: 'factory', factoryId: 'nb', view: 'agents' },
      planId: newPlan,
      planFrom: 'p1',
    })
    history = withHistory(history, { type: 'forward' })
    expect(history.now.screen).toEqual({ kind: 'inbox' })
    expect(history.now.planFrom).toBeUndefined()

    history = withHistory(history, { type: 'back' })
    history = withHistory(history, { type: 'open-plan', factoryId: 'nb' })
    expect(history.now.planId).toBe(newPlan)
    expect(history.now.planFrom).toBeUndefined()
    history = withHistory(history, { type: 'back' })
    expect(history.now.planFrom).toBe('p1')
    history = withHistory(history, { type: 'forward' })
    expect(history.now.planId).toBe(newPlan)
    expect(history.now.planFrom).toBeUndefined()
  })

  test('the chat Agents picks replaces the plain Agents place, so Back returns to that chat', () => {
    const agents = { kind: 'factory', factoryId: 'nb', view: 'agents' } as const
    let history = walk(
      { type: 'open', screen: agents },
      { type: 'open', screen: { ...agents, chatId: 'a' }, replace: true },
    )
    expect(history.back.map((p) => p.screen)).toEqual([{ kind: 'inbox' }])
    history = withHistory(history, { type: 'open', screen: { ...agents, chatId: 'b' } })
    history = withHistory(history, { type: 'back' })
    expect(history.now.screen).toEqual({ ...agents, chatId: 'a' })
    history = withHistory(history, {
      type: 'open-plan',
      factoryId: 'nb',
      planId: 'p1',
      replace: true,
    })
    expect(history.now).toMatchObject({ screen: agents, planId: 'p1' })
    expect(history.forward).toHaveLength(1)
  })

  test('back with nowhere to go, and actions that stay in place, change nothing', () => {
    const start = startHistory(initialNavigation)
    expect(withHistory(start, { type: 'back' })).toBe(start)
    const state = walk(
      { type: 'open', screen: { kind: 'all-tasks' } },
      { type: 'open', screen: { kind: 'all-tasks' } },
      { type: 'back' },
    )
    expect(state.now.screen).toEqual({ kind: 'inbox' })
  })
})

test('Tasks opens the last-used of Board, List and Map, and a Task opened from Map returns there', () => {
  const tasksView = (state: typeof initialNavigation) =>
    navigate(state, { type: 'open-tasks', factoryId: 'nb' }).screen
  expect(tasksView(initialNavigation)).toEqual({ kind: 'factory', factoryId: 'nb', view: 'board' })
  const map = { kind: 'factory', factoryId: 'nb', view: 'map' } as const
  const onAgents = [
    { type: 'open', screen: map } as const,
    { type: 'open', screen: { kind: 'factory', factoryId: 'nb', view: 'agents' } } as const,
  ].reduce(navigate, initialNavigation)
  expect(tasksView(onAgents)).toEqual(map)
  expect(navigate(onAgents, { type: 'open-tasks', factoryId: 'ms' }).screen).toMatchObject({
    factoryId: 'ms',
    view: 'board',
  })
  const history = [
    { type: 'open', screen: map } as const,
    { type: 'open', screen: { kind: 'factory', factoryId: 'nb', view: 'list' } } as const,
    { type: 'back' } as const,
    { type: 'open', screen: { kind: 'inbox' } } as const,
  ].reduce(withHistory, startHistory(initialNavigation))
  expect(tasksView(history.now)).toEqual(map)
  const opened = navigate(navigate(initialNavigation, { type: 'open', screen: map }), {
    type: 'open-task',
    taskId: 't1',
    factoryId: 'nb',
  })
  expect(backLink(opened)).toBe('← Map')
})

test('Task return and history preserve a Dashboard range, Factories and metric sample', () => {
  const screen = {
    kind: 'dashboard',
    dashboard: {
      range: '7d',
      factoryIds: ['nb'],
      sample: { metric: 'intake', period: 'previous', bucket: 2 },
    },
  } as const
  const start = startHistory(navigate(initialNavigation, { type: 'open', screen }))
  const opened = withHistory(start, { type: 'open-task', taskId: 't1', factoryId: 'nb' })
  expect(backLink(opened.now)).toBe('← Dashboard')
  expect(navigate(opened.now, { type: 'close-task' }).screen).toEqual(screen)
  expect(withHistory(opened, { type: 'back' }).now.screen).toEqual(screen)
})

test('Back returns to the Dashboard choice history recorded, not the one saved since', () => {
  let saved: DashboardViewState = { range: '30d' }
  const resolve = (partial: Partial<DashboardViewState> | undefined) => ({ ...saved, ...partial })
  const step = historyReducer(resolve)
  let history = step(startHistory(initialNavigation), {
    type: 'open',
    screen: { kind: 'dashboard' },
  })
  expect(history.now.screen).toEqual({ kind: 'dashboard', dashboard: { range: '30d' } })
  saved = { range: '7d', panel: 'stages', factoryIds: ['nb'] }
  history = step(history, { type: 'open', screen: { kind: 'dashboard', dashboard: saved } })
  history = step(history, { type: 'back' })
  expect(history.now.screen).toEqual({ kind: 'dashboard', dashboard: { range: '30d' } })
  history = step(history, { type: 'open-factory', factoryId: 'ms' })
  expect(history.now.screen).toEqual({
    kind: 'dashboard',
    dashboard: { range: '7d', panel: 'stages', factoryIds: ['ms'] },
  })
})

test('the Dashboard reopens on the remembered Factories, period and tab', () => {
  const stored = new Map<string, string>()
  const storage = {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
  }
  expect(dashboardState(undefined, storage)).toEqual({ range: '30d' })
  rememberDashboard({ range: '90d', panel: 'stages', factoryIds: ['nb', 'ms'] }, storage)
  expect(dashboardState(undefined, storage)).toEqual({
    range: '90d',
    panel: 'stages',
    factoryIds: ['nb', 'ms'],
  })
  expect(dashboardState({ factoryIds: ['nb'] }, storage)).toEqual({
    range: '90d',
    panel: 'stages',
    factoryIds: ['nb'],
  })
  expect(dashboardState({ range: 'all' }, storage)).toEqual({ range: 'all' })
  stored.set('ted.dashboard', '{"range":"bad","factoryIds":[1]}')
  expect(dashboardState(undefined, storage)).toEqual({ range: '30d' })
  stored.set('ted.dashboard', '{"range":"7d","panel":"flow"}')
  expect(dashboardState(undefined, storage)).toEqual({ range: '7d' })
  stored.set('ted.dashboard', '{"range":"7d","panel":"stages"}')
  expect(dashboardState({ panel: 'flow' } as never, storage)).toEqual({ range: '7d' })
  const factories = [{ id: 'nb' }, { id: 'ms' }]
  expect(shownFactoryIds(['nb', 'gone'], factories)).toEqual(['nb'])
  expect(shownFactoryIds(['ms', 'nb'], factories)).toBeUndefined()
  expect(shownFactoryIds(['gone'], factories)).toBeUndefined()
})

test('picking Dashboard Factories narrows from all, toggles after and falls back to all', () => {
  const factories = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
  expect(pickFactories(undefined, ['b'], factories)).toEqual(['b'])
  expect(pickFactories(undefined, ['a', 'b'], factories)).toEqual(['a', 'b'])
  expect(pickFactories(['b'], ['d'], factories)).toEqual(['b', 'd'])
  expect(pickFactories(['b', 'd'], ['b'], factories)).toEqual(['d'])
  expect(pickFactories(['c'], ['a', 'b'], factories)).toEqual(['a', 'b', 'c'])
  expect(pickFactories(['a', 'b', 'c'], ['a', 'b'], factories)).toEqual(['c'])
  expect(pickFactories(['a', 'c'], ['a', 'b'], factories)).toEqual(['a', 'b', 'c'])
  expect(pickFactories(['b'], ['b'], factories)).toBeUndefined()
  expect(pickFactories(['a', 'b', 'c'], ['d'], factories)).toBeUndefined()
})

test('Inbox Planning requests preserve Inbox navigation, then yield to Tasks and Automations', () => {
  const opened = after(
    { type: 'open-task', taskId: 't1', factoryId: 'nb', requestId: 'c1' },
    { type: 'open-plan', factoryId: 'nb', planId: 'p1', requestId: 'round1' },
  )
  expect(opened).toMatchObject({
    screen: { kind: 'inbox' },
    planId: 'p1',
    requestId: 'round1',
    lastFactoryId: 'nb',
  })
  expect(opened.taskId).toBeUndefined()
  const taskOpen = navigate(opened, {
    type: 'open-task',
    taskId: 't2',
    factoryId: 'ms',
    requestId: 'c2',
  })
  expect(taskOpen.planId).toBeUndefined()
  expect(taskOpen.requestId).toBe('c2')
  const automationOpen = navigate(opened, {
    type: 'open-automation',
    automationId: 'a1',
    factoryId: 'ms',
    runId: 'r1',
    requestId: 'q1',
  })
  expect(automationOpen.planId).toBeUndefined()
  expect(automationOpen.requestId).toBe('q1')
  const left = navigate(opened, { type: 'open', screen: { kind: 'all-tasks' } })
  expect(left.planId).toBeUndefined()
  expect(left.requestId).toBeUndefined()
})

test('history restores an Inbox Planning request and its Factory after opening another Task', () => {
  let history = startHistory(initialNavigation)
  history = withHistory(history, {
    type: 'open-plan',
    factoryId: 'nb',
    planId: 'p1',
    requestId: 'round1',
  })
  history = withHistory(history, {
    type: 'open-task',
    taskId: 't2',
    factoryId: 'ms',
    requestId: 'c2',
  })
  history = withHistory(history, { type: 'back' })
  expect(history.now).toMatchObject({
    screen: { kind: 'inbox' },
    planId: 'p1',
    requestId: 'round1',
    lastFactoryId: 'nb',
  })
  expect(history.now.taskId).toBeUndefined()
  history = withHistory(history, { type: 'forward' })
  expect(history.now).toMatchObject({ taskId: 't2', requestId: 'c2' })
  expect(history.now.planId).toBeUndefined()
})
