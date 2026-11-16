import { expect, test } from 'vitest'
import { chatsDue } from '../src/chat-expiry.ts'

test('only chats archived more than the given days ago are due', () => {
  const now = new Date('2026-11-16T12:00:00.000Z')
  const chats = [
    { agent: 'planner' as const, id: 'old', archivedAt: '2026-11-01T12:00:00.000Z' },
    { agent: 'coordinator' as const, id: 'edge', archivedAt: '2026-11-09T12:00:00.000Z' },
    { agent: 'coordinator' as const, id: 'new', archivedAt: '2026-11-15T12:00:00.000Z' },
  ]
  expect(chatsDue(chats, 7, now).map((c) => c.id)).toEqual(['old'])
  expect(chatsDue(chats, 1, now).map((c) => c.id)).toEqual(['old', 'edge'])
  expect(chatsDue(chats, 30, now)).toEqual([])
})
