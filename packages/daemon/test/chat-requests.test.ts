import type { Round } from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import {
  answerable,
  chatTitle,
  type PostedRequest,
  planPost,
  proposalRows,
  refuseWhileWaiting,
  roundAnswerMessage,
} from '../src/chats/requests.ts'
import { RequestError } from '../src/errors.ts'

const open = (id: string, kind: string): PostedRequest => ({ id, kind })
const closed = (id: string, kind: string, answer = 'answered'): PostedRequest => ({
  id,
  kind,
  answer: { kind: answer },
})

interface Refusal {
  status: number
  message: string
}

function refusal(act: () => void): Refusal {
  try {
    act()
  } catch (error) {
    if (error instanceof RequestError) return { status: error.status, message: error.message }
    throw error
  }
  throw new Error('expected a refusal')
}

describe('planPost', () => {
  test('numbers rounds by the rounds not superseded, keeping the number of a replaced round', () => {
    const requests = [
      closed('r1', 'round'),
      closed('r2', 'round', 'superseded'),
      closed('r3', 'round'),
      closed('p1', 'proposal'),
    ]
    expect(planPost(requests, { kind: 'round' })).toEqual({ roundNumber: 3 })
    expect(
      planPost([...requests, open('r4', 'round')], { kind: 'round', supersedes: 'r4' }),
    ).toEqual({ supersedes: 'r4', roundNumber: 3 })
    expect(planPost([], { kind: 'proposal' })).toEqual({ roundNumber: 1 })
  })

  test('refuses a supersede of a missing, other-kind or answered request', () => {
    const requests = [open('p1', 'proposal'), closed('r1', 'round')]
    expect(refusal(() => void planPost(requests, { kind: 'round', supersedes: 'nope' }))).toEqual({
      status: 404,
      message: 'no request nope in this chat',
    })
    expect(refusal(() => void planPost(requests, { kind: 'round', supersedes: 'p1' }))).toEqual({
      status: 400,
      message: 'a round can replace only a round',
    })
    expect(refusal(() => void planPost(requests, { kind: 'round', supersedes: 'r1' }))).toEqual({
      status: 409,
      message: 'that request has already been answered',
    })
  })

  test('allows one open request per chat, and a new proposal over an open one needs --supersedes', () => {
    expect(refusal(() => void planPost([open('p1', 'proposal')], { kind: 'proposal' }))).toEqual({
      status: 409,
      message:
        'Your proposal (request p1) is still waiting on the human; wait for their answer, or replace it with --supersedes p1',
    })
    expect(refusal(() => void planPost([open('r1', 'round')], { kind: 'proposal' }))).toEqual({
      status: 409,
      message: 'Your round (request r1) is still waiting on the human; wait for their answer',
    })
    expect(planPost([open('p1', 'proposal')], { kind: 'proposal', supersedes: 'p1' })).toEqual({
      supersedes: 'p1',
      roundNumber: 0,
    })
  })

  test('a planning chat note is never an open request', () => {
    expect(planPost([open('n1', 'note')], { kind: 'round' })).toEqual({ roundNumber: 1 })
  })
})

test('refuseWhileWaiting offers --supersedes only for the same kind', () => {
  expect(() => refuseWhileWaiting([closed('q1', 'question')], 'outside-command')).not.toThrow()
  expect(refusal(() => refuseWhileWaiting([open('q1', 'question')], 'outside-command'))).toEqual({
    status: 409,
    message: 'Your question (request q1) is still waiting on the human; wait for their answer',
  })
})

test('proposalRows fills in priority none and no blockers, and keeps what was given', () => {
  expect(
    proposalRows([
      { title: 'A', scope: 'a' },
      { title: 'B', scope: 'b', description: 'more', priority: 'high', blockedBy: [1] },
    ]),
  ).toEqual([
    { title: 'A', scope: 'a', priority: 'none', blockedBy: [] },
    { title: 'B', scope: 'b', description: 'more', priority: 'high', blockedBy: [1] },
  ])
})

test('answerable refuses a superseded or answered request', () => {
  expect(() => answerable(open('r1', 'round'))).not.toThrow()
  expect(refusal(() => answerable(closed('r1', 'round', 'superseded')))).toEqual({
    status: 409,
    message: 'This request was replaced by a newer one',
  })
  expect(refusal(() => answerable(closed('r1', 'round', 'changes-requested')))).toEqual({
    status: 409,
    message: 'This request has already been answered',
  })
})

test('roundAnswerMessage lists each answer, marks changed ones and adds what to do next', () => {
  const round: Round = {
    number: 2,
    questions: [
      { question: 'Which colour?', recommended: 'Blue' },
      { question: 'How many?', recommended: 'Two' },
    ],
  }
  const answers = [
    { answer: 'Blue', changed: false },
    { answer: 'Three', changed: true, note: 'More is better' },
  ]
  expect(roundAnswerMessage({ id: 'r9', title: 'Style', round }, answers)).toBe(
    [
      'The human answered Round 2 “Style” (request r9):',
      [
        '1. Which colour?',
        '   Blue (recommended)',
        '2. How many?',
        '   Three (changed from your recommendation “Two”)',
        '   Note: More is better',
      ].join('\n'),
    ].join('\n\n'),
  )
  expect(roundAnswerMessage({ id: 'r9', title: 'Style', round }, answers, 'Carry on.')).toMatch(
    /\n\nCarry on\.$/,
  )
})

test('chatTitle trims, collapses spaces and refuses an empty or too-long title', () => {
  expect(chatTitle('  Plan   the\nsharing  ')).toBe('Plan the sharing')
  expect(refusal(() => void chatTitle('   '))).toEqual({
    status: 400,
    message: 'A chat needs a title',
  })
  expect(chatTitle('é'.repeat(200))).toHaveLength(200)
  expect(refusal(() => void chatTitle('x'.repeat(201)))).toEqual({
    status: 400,
    message: 'titles are at most 200 characters',
  })
})
