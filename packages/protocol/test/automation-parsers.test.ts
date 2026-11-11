import { expect, test } from 'vitest'
import * as P from '../src/index.ts'
import { rejects, roundTrip } from './parser-cases.ts'

for (const schedule of [
  { kind: 'every', every: 5, unit: 'minutes' },
  { kind: 'daily', at: '09:00' },
  { kind: 'weekdays', at: '09:00' },
  { kind: 'weekly', days: ['mon', 'fri'], at: '09:00' },
  { kind: 'custom', expression: '0 9 * * *' },
] satisfies P.AutomationSchedule[])
  roundTrip(P.parseAutomationSchedule, schedule)
const schedule = { kind: 'daily', at: '09:00' } as const
const core = {
  name: 'Daily',
  prompt: 'Review',
  schedule,
  agent: 'codex',
  model: 'gpt-5.5',
  effort: 'high',
  on: true,
} as const
roundTrip(P.parseCreateAutomationRequest, {
  ...core,
  factory: 'TED',
  template: 'linear',
  runNow: true,
})
roundTrip(P.parseEditAutomationRequest, core)
roundTrip(P.parseEditAutomationRequest, { ...core, model: null, effort: null })
roundTrip(P.parseDraftAutomationPromptRequest, {
  factory: 'TED',
  request: 'Draft',
  name: 'Daily',
  prompt: 'Existing prompt',
  agent: 'codex',
  model: 'gpt-5.5',
  effort: 'high',
})
roundTrip(P.parseSchedulePreviewRequest, { schedule })
roundTrip(P.parseAutomationCommentRequest, { body: 'Proceed?', choices: ['Yes', 'No'] })
roundTrip(P.parseAnswerAutomationRequest, { choice: 'Yes', text: 'Continue' })
rejects(P.parseAutomationSchedule, { kind: 'daily', at: '25:00' }, 'time as HH:MM')
rejects(P.parseCreateAutomationRequest, {}, 'name is required')
rejects(P.parseEditAutomationRequest, { template: 'linear' }, 'template is chosen at creation')
rejects(P.parseDraftAutomationPromptRequest, {}, 'factory and request are required text')
rejects(P.parseSchedulePreviewRequest, { schedule: { kind: 'other' } }, 'schedule.kind must be')
rejects(P.parseAutomationCommentRequest, { body: '' }, 'body is required')
rejects(P.parseAnswerAutomationRequest, { text: 1 }, 'text must be text')

test('prompt limit preserves byte count and 413 status', () => {
  expect(() => P.parseEditAutomationRequest({ prompt: '😀'.repeat(25_001) })).toThrow(
    'prompt is too long',
  )
  try {
    P.parseEditAutomationRequest({ prompt: 'x'.repeat(100_001) })
  } catch (error) {
    expect(error).toBeInstanceOf(P.RequestValidationError)
    expect(error).toMatchObject({ status: 413 })
  }
  expect(P.parseEditAutomationRequest({ prompt: 'x'.repeat(100_000) }).prompt).toHaveLength(100_000)
})

test('weekly days are deduplicated and null optional text is omitted', () => {
  expect(P.parseAutomationSchedule({ kind: 'weekly', days: ['mon', 'mon'], at: '09:00' })).toEqual({
    kind: 'weekly',
    days: ['mon'],
    at: '09:00',
  })
  expect(P.parseAnswerAutomationRequest({ choice: null, text: null })).toEqual({})
})
