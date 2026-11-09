import { describe, expect, test } from 'vitest'
import {
  backLink,
  currentFactoryId,
  initialNavigation,
  type Navigation,
  navigate,
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
})
