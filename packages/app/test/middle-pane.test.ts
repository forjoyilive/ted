import type { Task } from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import {
  type MiddlePaneAction,
  type MiddlePaneState,
  middlePane,
  middlePaneStep,
} from '../src/renderer/middle-pane.ts'

type PaneTask = Pick<Task, 'id' | 'tabs' | 'repos'>

const task = {
  id: 't1',
  tabs: [{ runId: 'r1', name: 'Reviewer', state: 'working' }],
  repos: [{ name: 'web', removed: false }],
} as unknown as PaneTask

const file = {
  repo: 'web',
  path: 'a.ts',
  baseBranch: 'main',
  added: 1,
  removed: 0,
  uncommitted: false,
}

const after = (...actions: MiddlePaneAction[]) =>
  middlePane(
    actions.reduce<MiddlePaneState>((s, a) => middlePaneStep(s, task.id, a), {}),
    task,
    true,
  )

describe('middle pane', () => {
  test('a diff covers the thread and keeps the Run tab and shell underneath', () => {
    const pane = after(
      { kind: 'run', runId: 'r1' },
      { kind: 'shell', repo: 'web' },
      { kind: 'changes', view: { kind: 'diff', file } },
    )
    expect(pane).toMatchObject({ run: 'r1', shell: 'web', covered: true, all: false })
    const back = after(
      { kind: 'run', runId: 'r1' },
      { kind: 'shell', repo: 'web' },
      { kind: 'changes', view: { kind: 'diff', file } },
      { kind: 'changes', view: undefined },
    )
    expect(back).toMatchObject({ run: 'r1', shell: 'web', covered: false })
  })

  test('the Full brief and an App log close the shell', () => {
    expect(after({ kind: 'shell', repo: 'web' }, { kind: 'brief', open: true })).toMatchObject({
      shell: undefined,
      brief: true,
      covered: true,
    })
    expect(
      after({ kind: 'shell', repo: 'web' }, { kind: 'app', app: { repo: 'web', name: 'site' } }),
    ).toMatchObject({ shell: undefined, app: { repo: 'web', name: 'site' }, covered: false })
  })

  test('showing a Run closes everything else', () => {
    const pane = after(
      { kind: 'app', app: { repo: 'web', name: 'site' } },
      { kind: 'changes', view: { kind: 'all' } },
      { kind: 'run', runId: 'r1' },
    )
    expect(pane).toMatchObject({ run: 'r1', app: undefined, changes: undefined, covered: false })
  })

  test('an answer resets everything but the shell', () => {
    const pane = after(
      { kind: 'run', runId: 'r1' },
      { kind: 'shell', repo: 'web' },
      { kind: 'changes', view: { kind: 'all' } },
      { kind: 'answered' },
    )
    expect(pane).toMatchObject({ run: undefined, shell: 'web', changes: undefined })
  })

  test('state for another Task, a closed Run tab or a removed repo is not shown', () => {
    const state = middlePaneStep(
      middlePaneStep({}, 'other', { kind: 'shell', repo: 'web' }),
      'other',
      { kind: 'brief', open: true },
    )
    expect(middlePane(state, task, true)).toMatchObject({ brief: false, shell: undefined })
    expect(after({ kind: 'run', runId: 'gone' }).run).toBeUndefined()
    expect(after({ kind: 'shell', repo: 'api' }).shell).toBeUndefined()
  })

  test('All changes waits for the changes to load', () => {
    const state = middlePaneStep({}, task.id, { kind: 'changes', view: { kind: 'all' } })
    expect(middlePane(state, task, false)).toMatchObject({ all: false, covered: false })
  })
})
