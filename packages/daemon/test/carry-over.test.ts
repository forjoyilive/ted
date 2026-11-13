import type { ChatItem } from '@ted/protocol'
import { expect, test } from 'vitest'
import { conversationText } from '../src/tasks/carry-over.ts'

const at = '2026-11-13T12:00:00.000Z'
const human = (id: string, text: string): ChatItem => ({ kind: 'human', id, text, at, sent: true })
const agent = (id: string, text: string): ChatItem => ({ kind: 'agent', id, text, at })

test('the copy keeps the user’s messages, replies and one line per command, without instructions', () => {
  const { text, cut } = conversationText([
    { kind: 'instructions', id: 'i', text: 'Preamble', lines: 1 },
    { kind: 'prompt', id: 'p', text: 'Stage instructions', lines: 1 },
    human('h1', 'Please fix the field'),
    {
      kind: 'tool',
      id: 't1',
      tool: 'Bash',
      title: 'pnpm\ntypecheck',
      status: 'done',
      output: 'ok',
    },
    agent('a1', 'Done.'),
    { kind: 'human', id: 'h2', text: 'Not sent yet', at, sent: false },
    { kind: 'ted', id: 'ted', title: 'TED moved this Task to Work', text: 'Long text' },
    { kind: 'interrupted', id: 'x', at },
  ])
  expect(cut).toBe(false)
  expect(text).toBe(
    [
      'The user: Please fix the field',
      'Ran: pnpm typecheck',
      'Task Lead: Done.',
      'TED: TED moved this Task to Work',
      '(The turn was interrupted.)',
    ].join('\n\n'),
  )
})

test('a long conversation keeps its start and newest part and says how many messages it left out', () => {
  const items = Array.from({ length: 100 }, (_, n) =>
    agent(`a${n}`, `reply ${n} ${'x'.repeat(80)}`),
  )
  const { text, cut, leftOut } = conversationText(items, 1200)
  expect(cut).toBe(true)
  expect(leftOut).toBeGreaterThan(80)
  expect(text.length).toBeLessThanOrEqual(1300)
  expect(text.startsWith('Task Lead: reply 0 ')).toBe(true)
  expect(text).toContain(
    `[${leftOut} messages left out here because the conversation was too long]`,
  )
  expect(text.endsWith(`reply 99 ${'x'.repeat(80)}`)).toBe(true)
})

test('one message longer than the limit is shortened in the middle', () => {
  const { text, cut, leftOut } = conversationText([agent('a', 'y'.repeat(5000))], 600)
  expect(cut).toBe(true)
  expect(leftOut).toBe(0)
  expect(text).toContain('[Part of a long message was left out here]')
  expect(text.length).toBeLessThan(800)
})
