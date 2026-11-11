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

test('a file covers the middle pane, restores the Run or shell, and is scoped to an active repo', () => {
  const file = { repo: 'web', path: 'unchanged.ts' }
  const state = middlePaneStep(
    middlePaneStep({}, task.id, { kind: 'shell', repo: 'web' }),
    task.id,
    { kind: 'file', file },
  )
  expect(middlePane(state, task, true)).toMatchObject({ file, covered: true, shell: 'web' })
  expect(
    middlePane(middlePaneStep(state, task.id, { kind: 'file', file: undefined }), task, true),
  ).toMatchObject({ file: undefined, covered: false, shell: 'web' })
  expect(middlePane(state, { ...task, id: 'other' }, true).file).toBeUndefined()
  expect(middlePane(state, { ...task, repos: [] }, true).file).toBeUndefined()
  expect(
    middlePane(
      middlePaneStep(state, task.id, {
        kind: 'changes',
        view: {
          kind: 'diff',
          file: { ...file, baseBranch: 'main', added: 0, removed: 0, uncommitted: false },
        },
      }),
      task,
      true,
    ).file,
  ).toBeUndefined()
})

test('a file temporarily covers All changes or Full brief and restores it on return', () => {
  for (const action of [
    { kind: 'brief', open: true },
    { kind: 'changes', view: { kind: 'all' } },
  ] as const) {
    const original = middlePaneStep({}, task.id, action)
    const opened = middlePaneStep(original, task.id, {
      kind: 'file',
      file: { repo: 'web', path: 'a.ts' },
    })
    expect(middlePane(opened, task, true)).toMatchObject({
      file: { path: 'a.ts' },
      all: false,
      brief: false,
      changes: undefined,
    })
    const closed = middlePaneStep(opened, task.id, { kind: 'file', file: undefined })
    expect(closed).toEqual(original)
    expect(middlePane(closed, task, true)).toMatchObject({ file: undefined, covered: true })
  }
})

test('PR changes retain their source while loading and restore the underlying thread', () => {
  const state = middlePaneStep({}, task.id, {
    kind: 'changes',
    view: { kind: 'all', source: 'pull-request' },
  })
  expect(middlePane(state, task, false)).toMatchObject({
    all: true,
    covered: true,
    changes: { source: 'pull-request' },
  })
  expect(
    middlePane(middlePaneStep(state, task.id, { kind: 'changes', view: undefined }), task, true),
  ).toMatchObject({ covered: false })
  expect(middlePane(state, { ...task, id: 'other' }, true).changes).toBeUndefined()
})
