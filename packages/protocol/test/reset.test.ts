import { expect, test } from 'vitest'
import { resetRefusal, type Task } from '../src/task.ts'

type Facts = Parameters<typeof resetRefusal>[0]

const facts = (fields: Partial<Facts> = {}): Facts => ({
  stage: 'work',
  statuses: [],
  repos: [],
  runs: [],
  ...fields,
})

const repo = (state: string) =>
  ({ name: 'widgets', pullRequest: { number: 1, state } }) as Task['repos'][number]

test('a started Task can be reset unless it is Done, archived or has merged anything', () => {
  expect(resetRefusal(facts())).toBeUndefined()
  expect(resetRefusal(facts({ statuses: ['stopped'] }))).toBeUndefined()
  expect(resetRefusal(facts({ statuses: ['failed'] }))).toBeUndefined()
  expect(resetRefusal(facts({ stage: 'merge', repos: [repo('open')] }))).toBeUndefined()
  expect(resetRefusal(facts({ stage: 'backlog', repos: [repo('closed')] }))).toBeUndefined()

  expect(resetRefusal(facts({ stage: 'backlog' }))).toBe('not-started')
  expect(resetRefusal(facts({ stage: 'done' }))).toBe('done')
  expect(
    resetRefusal(
      facts({ archived: { at: '2026-11-12T00:00:00.000Z', ended: { kind: 'never-started' } } }),
    ),
  ).toBe('archived')
  expect(resetRefusal(facts({ stage: 'merge', statuses: ['partly-merged'] }))).toBe('merged')
  expect(resetRefusal(facts({ stage: 'merge', repos: [repo('merged'), repo('open')] }))).toBe(
    'merged',
  )
})
