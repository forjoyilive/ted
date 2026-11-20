import { expect, test } from 'vitest'
import { parsePresenceReport } from '../src/presence.ts'

test('a presence report is just whether the user is away', () => {
  expect(parsePresenceReport({ away: true })).toEqual({ away: true })
  expect(parsePresenceReport({ away: false, extra: 1 })).toEqual({ away: false })
  expect(() => parsePresenceReport({ away: 'yes' })).toThrow(/away/)
  expect(() => parsePresenceReport(null)).toThrow(/presence/)
})
