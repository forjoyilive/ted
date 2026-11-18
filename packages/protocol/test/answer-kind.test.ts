import { expect, test } from 'vitest'
import { answerKind } from '../src/task.ts'

test('answerKind says which questions take only their buttons', () => {
  expect(answerKind({ purpose: { kind: 'asana-unfinished' } })).toBe('choice-only')
  expect(answerKind({ purpose: { kind: 'asana-missing' } })).toBe('choice-only')
  expect(answerKind({ linearTeam: { name: 'Design', key: 'DES' } })).toBe('choice-only')
  expect(
    answerKind({
      purpose: { kind: 'tracker-group', tracker: 'asana', group: { key: 'p1', name: 'Website' } },
    }),
  ).toBe('choice-only')
  expect(answerKind({ purpose: { kind: 'memory-kill' } })).toBe('choice-and-note')
  expect(answerKind({ purpose: { kind: 'cleanup-failure' } })).toBe('choice-and-note')
  expect(answerKind({ purpose: { kind: 'question' } })).toBe('open')
  expect(answerKind({})).toBe('open')
})
