import type { Factory, StageId, TaskStatus } from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import { guideCard, setupTaskOf, shownGuide } from '../src/renderer/guide.ts'
import { comment, factory, task } from './support/fixtures.ts'

const setup = (stage: StageId, status?: TaskStatus) =>
  task({ id: 't1', setup: true, stage, ...(status && { status }) })

const guided = (setUp = false, f: Factory = factory()) => ({
  factory: f,
  guide: { factoryId: f.id, addedAt: '2026-11-01T00:00:00.000Z', setUp },
})

const card = (...args: Parameters<typeof guideCard>) => {
  const { text, button } = guideCard(...args)
  return { text, button }
}

describe('the guide card follows the setup Task', () => {
  test('while cloning, and when a clone fails', () => {
    const cloning = factory({ cloned: false, setup: [{ repo: 'acme/widgets', state: 'cloning' }] })
    expect(card(guided(false, cloning), undefined, [])).toEqual({
      text: 'Ted is cloning your repos.',
    })
    const failed = factory({ cloned: false, setup: [{ repo: 'acme/widgets', state: 'failed' }] })
    expect(card(guided(false, failed), undefined, [])).toEqual({
      text: 'Ted couldn’t clone your repos. See the banner at the top.',
    })
  })

  test.each([
    ['intake', 'The Task Lead is reading your repos. It will ask how you work.'],
    ['clarify', 'The Task Lead is reading your repos. It will ask how you work.'],
    ['design', 'The Task Lead is trying your checks and Apps.'],
    ['work', 'The Task Lead is writing the settings and checking them.'],
    ['validate', 'The Task Lead is writing the settings and checking them.'],
    ['review', 'The Task Lead is writing the settings and checking them.'],
  ] as const)('working in %s', (stage, text) => {
    expect(card(guided(), setup(stage, { kind: 'working' }), [])).toEqual({
      text,
      button: { label: 'Open the Task', open: 'task' },
    })
  })

  test('each open request names what it opens', () => {
    const round = comment({ id: 'r1', taskId: 't1', kind: 'round', stage: 'clarify' })
    expect(card(guided(), setup('clarify'), [round])).toEqual({
      text: 'The Task Lead has questions for you.',
      button: { label: 'Open questions', open: 'request', requestId: 'r1' },
    })
    const proposal = comment({ id: 'p1', taskId: 't1', kind: 'review', stage: 'design' })
    expect(card(guided(), setup('design'), [proposal])).toEqual({
      text: 'Review the proposed setup.',
      button: { label: 'Open the proposal', open: 'request', requestId: 'p1' },
    })
    const signOff = comment({ id: 's1', taskId: 't1', kind: 'signoff', stage: 'review' })
    expect(card(guided(), setup('review'), [signOff])).toEqual({
      text: 'Approve the settings to merge them.',
      button: { label: 'Open the sign-off', open: 'request', requestId: 's1' },
    })
    const permission = comment({ id: 'q1', taskId: 't1', kind: 'permission', stage: 'work' })
    expect(card(guided(), setup('work'), [permission])).toEqual({
      text: 'The Task Lead needs you.',
      button: { label: 'Open the request', open: 'request', requestId: 'q1' },
    })
    const elsewhere = comment({ id: 'x1', taskId: 'other', kind: 'round' })
    const answered = comment({
      id: 'a1',
      taskId: 't1',
      kind: 'round',
      answer: { kind: 'answered', at: '2026-11-09T12:00:00.000Z' },
    })
    expect(card(guided(), setup('clarify'), [elsewhere, answered]).button).toEqual({
      label: 'Open the Task',
      open: 'task',
    })
  })

  test('merging, done, stopped and failed', () => {
    expect(card(guided(), setup('merge'), [])).toEqual({
      text: 'Ted is merging the pull request.',
    })
    const newTask = { label: 'New Task…', open: 'new-task' }
    expect(card(guided(true), setup('done'), [])).toEqual({
      text: 'Your Factory is set up. Create your first Task.',
      button: newTask,
    })
    expect(card(guided(true), setup('backlog'), []).button).toEqual(newTask)
    expect(card(guided(false), setup('backlog'), [])).toEqual({
      text: 'The Task Lead is reading your repos. It will ask how you work.',
      button: { label: 'Open the Task', open: 'task' },
    })
    expect(card(guided(), setup('work', { kind: 'stopped' }), [])).toEqual({
      text: 'Setup is stopped. Open the Task to start it again.',
      button: { label: 'Open the Task', open: 'task' },
    })
    const failure = comment({ id: 'f1', taskId: 't1', kind: 'question', stage: 'validate' })
    expect(card(guided(), setup('validate', { kind: 'failed' }), [failure])).toEqual({
      text: 'Setup failed. Open the Task to see what went wrong.',
      button: { label: 'Open the Task', open: 'task' },
    })
  })
})

test('the newest live guide whose Factory exists is shown, with its first open setup Task', () => {
  const one = factory({ id: 'one', name: 'One' })
  const two = factory({ id: 'two', name: 'Two' })
  const guides = [
    { factoryId: 'one', addedAt: '2026-11-01T00:00:00.000Z', setUp: false },
    { factoryId: 'gone', addedAt: '2026-11-03T00:00:00.000Z', setUp: false },
    { factoryId: 'two', addedAt: '2026-11-02T00:00:00.000Z', setUp: false },
  ]
  expect(shownGuide(guides, [one, two])?.factory.id).toBe('two')
  expect(shownGuide(guides.slice(0, 2), [one, two])?.factory.id).toBe('one')
  expect(shownGuide([], [one])).toBeUndefined()

  const tasks = [
    task({ id: 'later', factoryId: 'one', setup: true, createdAt: '2026-11-05T00:00:00.000Z' }),
    task({
      id: 'archived',
      factoryId: 'one',
      setup: true,
      archived: { at: '', ended: { kind: 'never-started' } },
    }),
    task({ id: 'plain', factoryId: 'one' }),
    task({ id: 'first', factoryId: 'one', setup: true, createdAt: '2026-11-04T00:00:00.000Z' }),
  ]
  expect(setupTaskOf('one', tasks)?.id).toBe('first')
  expect(setupTaskOf('two', tasks)).toBeUndefined()
})
