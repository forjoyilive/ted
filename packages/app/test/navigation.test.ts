import { describe, expect, test } from 'vitest'
import {
  backLink,
  currentFactoryId,
  type History,
  type HistoryAction,
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
  test('starts on the Inbox with no current Factory', () => {
    expect(initialNavigation.screen).toEqual({ kind: 'inbox' })
    expect(currentFactoryId(initialNavigation, tasks)).toBeUndefined()
  })

  test('opening a Factory shows its Board the first time and its last-used View after', () => {
    expect(after({ type: 'open-factory', factoryId: 'nb' }).screen).toEqual({
      kind: 'factory',
      factoryId: 'nb',
      view: 'board',
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
    ).toBe('← Board')
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

  test('Settings opens over where the human was, on General the first time', () => {
    const before = after(
      { type: 'open-factory', factoryId: 'nb' },
      { type: 'open-task', taskId: 't1', factoryId: 'nb' },
    )

    const settings = navigate(before, { type: 'open-settings' })

    expect(settings.settings).toEqual({ section: 'general' })
    expect(navigate(settings, { type: 'close-settings' })).toEqual(before)
  })

  test('Settings reopens on the last section the human looked at', () => {
    const state = after(
      { type: 'open-settings' },
      { type: 'open-settings', section: 'developer' },
      { type: 'close-settings' },
      { type: 'open-settings' },
    )

    expect(state.settings).toEqual({ section: 'developer' })
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
    expect(state.now.screen).toEqual({ kind: 'factory', factoryId: 'nb', view: 'board' })
  })

  test('history retains a continuation source without leaking it into another place or new plan', () => {
    let history = walk({ type: 'open-plan', factoryId: 'nb', from: 'p1' })
    history = withHistory(history, { type: 'open', screen: { kind: 'inbox' } })
    expect(history.now.planFrom).toBeUndefined()

    history = withHistory(history, { type: 'back' })
    expect(history.now).toMatchObject({
      screen: { kind: 'factory', factoryId: 'nb', view: 'plans' },
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
