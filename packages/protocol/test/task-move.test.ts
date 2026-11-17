import { expect, test } from 'vitest'
import type { Task } from '../src/task.ts'
import {
  type MoveAnswer,
  type MoveAsk,
  maxMoveReason,
  movePlanKey,
  moveRefusal,
  parseMoveAnswer,
  parseMoveToFactoryRequest,
  parseRequestMoveRequest,
  type RequestMoveRequest,
  readMoveAsk,
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

test('an agent’s move request names a Factory and gives one reason line', () => {
  const all: Required<RequestMoveRequest> = { factory: 'WEB', reason: 'It changes the site' }
  expect(parseRequestMoveRequest(all)).toEqual(all)
  expect(parseRequestMoveRequest({ factory: ' WEB ', reason: ' Two\n lines ' })).toEqual({
    factory: 'WEB',
    reason: 'Two lines',
  })
  expect(() => parseRequestMoveRequest({ reason: 'Why' })).toThrow('factory must be a Factory')
  expect(() => parseRequestMoveRequest({ factory: 'WEB', reason: ' ' })).toThrow('give a reason')
  expect(() =>
    parseRequestMoveRequest({ factory: 'WEB', reason: 'x'.repeat(maxMoveReason + 1) }),
  ).toThrow(`at most ${maxMoveReason} characters`)
})

test('a Move answer names the chosen Factory and the plan the user saw', () => {
  const all: Required<MoveAnswer> = { factoryId: 'f-2', planKey: '{"factoryId":"f-2"}' }
  expect(parseMoveAnswer(all)).toEqual(all)
  expect(() => parseMoveAnswer({ factoryId: 'f-2' })).toThrow('move.planKey')
  expect(() => parseMoveAnswer({ factoryId: ' ', planKey: 'k' })).toThrow('move.factoryId')
})

test('a stored move ask reads back, and a damaged one is left out', () => {
  const all: Required<MoveAsk> = {
    factoryId: 'f-2',
    reason: 'Wrong Factory',
    askedBy: 'coordinator',
    chatId: 'chat-1',
  }
  expect(readMoveAsk(JSON.stringify(all))).toEqual(all)
  expect(
    readMoveAsk(JSON.stringify({ factoryId: 'f-2', reason: 'Why', askedBy: 'task-lead' })),
  ).toEqual({ factoryId: 'f-2', reason: 'Why', askedBy: 'task-lead' })
  expect(readMoveAsk(JSON.stringify({ ...all, askedBy: 'someone' }))).toBeUndefined()
  expect(readMoveAsk('not json')).toBeUndefined()
})
