import { type AgentHealth, planChip, resetTime, usageLimitText } from '@ted/protocol'
import { describe, expect, test } from 'vitest'

const now = new Date(2026, 10, 9, 12, 0)
const at = (hours: number, minutes: number, day = 9) =>
  new Date(2026, 10, day, hours, minutes).toISOString()

const health = (changes: Partial<AgentHealth>): AgentHealth => ({
  agent: 'claude',
  state: 'ready',
  minimumVersion: '2.1.111',
  pausedRuns: 0,
  checkedAt: now.toISOString(),
  ...changes,
})

describe('plan usage chip', () => {
  test('shows at 85% in the fullest window with its reset time', () => {
    const chip = planChip(
      health({
        planUsage: {
          at: now.toISOString(),
          from: 'run',
          windows: [
            { window: 'five-hour', percent: 87.4, resetsAt: at(15, 40) },
            { window: 'weekly', percent: 41 },
          ],
        },
      }),
      now,
    )
    expect(chip).toBe('Claude 87% · resets 15:40')
  })

  test('stays hidden below 85% and while the kind is at its limit', () => {
    const windows = [{ window: 'five-hour' as const, percent: 84 }]
    expect(planChip(health({ planUsage: { at: '', from: 'run', windows } }), now)).toBeUndefined()
    expect(
      planChip(
        health({
          state: 'usage-limit',
          planUsage: { at: '', from: 'read', windows: [{ window: 'weekly', percent: 100 }] },
        }),
        now,
      ),
    ).toBeUndefined()
  })
})

describe('reset times', () => {
  test('today and the next 12 hours show the clock; further out adds the weekday', () => {
    expect(resetTime(at(14, 20), now)).toBe('14:20')
    expect(resetTime(at(23, 30, 9), new Date(2026, 10, 9, 22, 0))).toBe('23:30')
    expect(resetTime(at(1, 0, 10), new Date(2026, 10, 9, 22, 0))).toBe('01:00')
    expect(resetTime(at(9, 0, 10), now)).toBe('Tue 09:00')
    expect(resetTime(at(9, 0, 16), now)).toBe('Mon 09:00')
    expect(usageLimitText('codex', at(14, 20), now)).toBe('Codex usage limit, resets 14:20')
    expect(usageLimitText('claude', undefined, now)).toBe('Claude usage limit')
  })
})

test('usage resets follow the app clock format and calendar day in the selected zone', () => {
  const now = new Date('2026-11-09T10:00:00Z')
  const at = '2026-11-10T00:15:00Z'
  const preferences = { timeFormat: '12-hour', timeZone: 'America/Los_Angeles' } as const
  expect(resetTime(at, now, preferences)).toBe('04:15 pm')
  expect(resetTime(at, now, { timeFormat: '24-hour', timeZone: 'Asia/Tokyo' })).toBe('Tue 09:15')
  expect(usageLimitText('codex', at, now, preferences)).toBe('Codex usage limit, resets 04:15 pm')
  expect(
    planChip(
      health({
        planUsage: {
          at: now.toISOString(),
          from: 'run',
          windows: [{ window: 'weekly', percent: 90, resetsAt: at }],
        },
      }),
      now,
      preferences,
    ),
  ).toBe('Claude 90% · resets 04:15 pm')
})
