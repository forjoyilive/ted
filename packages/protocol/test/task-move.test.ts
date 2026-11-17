import { expect, test } from 'vitest'
import type { Task } from '../src/task.ts'
import { moveRefusal, parseMoveToFactoryRequest } from '../src/task-move.ts'

type Facts = Parameters<typeof moveRefusal>[0]

const facts = (fields: Partial<Facts> = {}): Facts => ({
  stage: 'work',
  statuses: [],
  repos: [],
  ...fields,
})

const repo = (state: string) =>
  ({ name: 'widgets', pullRequest: { number: 1, state } }) as Task['repos'][number]

test('a Task can move unless it is Done, archived, merged or a setup Task', () => {
  expect(moveRefusal(facts())).toBeUndefined()
  expect(moveRefusal(facts({ stage: 'backlog' }))).toBeUndefined()
  expect(moveRefusal(facts({ stage: 'merge', repos: [repo('open')] }))).toBeUndefined()

  expect(moveRefusal(facts({ stage: 'done' }))).toBe('done')
  expect(
    moveRefusal(
      facts({ archived: { at: '2026-11-12T00:00:00.000Z', ended: { kind: 'never-started' } } }),
    ),
  ).toBe('archived')
  expect(moveRefusal(facts({ stage: 'merge', statuses: ['partly-merged'] }))).toBe('merged')
  expect(moveRefusal(facts({ repos: [repo('merged')] }))).toBe('merged')
  expect(moveRefusal(facts({ setup: true }))).toBe('setup')
})

test('a move request names the Factory to move to', () => {
  expect(parseMoveToFactoryRequest({ factoryId: ' f-2 ' })).toEqual({ factoryId: 'f-2' })
  expect(() => parseMoveToFactoryRequest({})).toThrow('factoryId must be a Factory ID')
  expect(() => parseMoveToFactoryRequest({ factoryId: ' ' })).toThrow(
    'factoryId must be a Factory ID',
  )
  expect(() => parseMoveToFactoryRequest(null)).toThrow('move request must be an object')
})
