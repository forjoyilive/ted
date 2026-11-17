import { expect, test } from 'vitest'
import type { Task } from '../src/task.ts'
import {
  movePlanKey,
  moveRefusal,
  parseMoveToFactoryRequest,
  type TaskMovePlan,
  type TaskMovePlanTask,
} from '../src/task-move.ts'

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

test('a move plan’s key ignores the new number but not what the move discards', () => {
  const plan: TaskMovePlan = {
    factoryId: 'web',
    factoryName: 'Website',
    repos: ['website'],
    tasks: [
      {
        id: 't1',
        displayId: 'NB-1',
        title: 'Offline editing',
        newDisplayId: 'WEB-4',
        stage: 'backlog',
        lands: 'backlog',
        startsLead: false,
        worktrees: 0,
        branches: [],
        pullRequests: [],
        openRequests: 0,
        unlinked: [],
      },
    ],
  }
  const changed = (task: Partial<TaskMovePlanTask>): TaskMovePlan => ({
    ...plan,
    tasks: plan.tasks.map((t) => ({ ...t, ...task })),
  })
  expect(movePlanKey(changed({ newDisplayId: 'WEB-5' }))).toBe(movePlanKey(plan))
  expect(movePlanKey(changed({ stage: 'work', startsLead: true }))).not.toBe(movePlanKey(plan))
  expect(movePlanKey(changed({ worktrees: 1 }))).not.toBe(movePlanKey(plan))
  expect(movePlanKey(changed({ pullRequests: [{ repo: 'notes', number: 3 }] }))).not.toBe(
    movePlanKey(plan),
  )
  expect(
    movePlanKey({
      ...plan,
      tasks: [...plan.tasks, { ...plan.tasks[0], id: 't2' } as TaskMovePlanTask],
    }),
  ).not.toBe(movePlanKey(plan))
  expect(parseMoveToFactoryRequest({ factoryId: 'web', planKey: movePlanKey(plan) })).toEqual({
    factoryId: 'web',
    planKey: movePlanKey(plan),
  })
  expect(() => parseMoveToFactoryRequest({ factoryId: 'web', planKey: '' })).toThrow(
    'planKey must be the key of a move plan',
  )
  expect(() => parseMoveToFactoryRequest({ factoryId: 'web', planKey: 3 })).toThrow(
    'planKey must be text',
  )
})
