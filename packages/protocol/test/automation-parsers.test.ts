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
  checkout: true,
  priority: 'urgent',
} as const
const check = {
  command: 'pnpm check --wait-for-quiet',
  timeout: '2h',
  runBy: '07:00',
  agentStep: 'always',
  startTasks: true,
} as const
roundTrip(P.parseCreateAutomationRequest, {
  ...core,
  factory: 'Ted',
  template: 'linear',
  runNow: true,
  check,
})
roundTrip(P.parseEditAutomationRequest, { ...core, check })
roundTrip(P.parseEditAutomationRequest, {
  ...core,
  model: null,
  effort: null,
  check: { ...check, runBy: null },
})
roundTrip(P.parseAutomationCheck, check)
roundTrip(P.parseDraftAutomationPromptRequest, {
  factory: 'Ted',
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
roundTrip(P.parseAutomationNoteTaskRequest, { body: 'It failed again for the same cause.' })
roundTrip(P.parseAutomationReportRequest, { summary: 'Two flaky tests; filed NB-4.' })
rejects(P.parseAutomationCheck, { command: 'x', agentStep: 'sometimes' }, 'check.agentStep')
rejects(P.parseEditAutomationRequest, { priority: 'soon' }, 'priority')
rejects(P.parseAutomationCheck, { command: 'x', startTasks: 'yes' }, 'check.startTasks')
rejects(P.parseAutomationNoteTaskRequest, { body: ' ' }, 'body is required')
rejects(P.parseAutomationNoteTaskRequest, { body: 'x'.repeat(20_001) }, 'at most 20000')
rejects(P.parseAutomationReportRequest, {}, 'summary is required')
rejects(P.parseAutomationReportRequest, { summary: 'x'.repeat(4_001) }, 'at most 4000')
rejects(P.parseAutomationSchedule, { kind: 'daily', at: '25:00' }, 'time as HH:MM')
rejects(P.parseCreateAutomationRequest, {}, 'name is required')
rejects(P.parseAutomationCheck, { command: ' ' }, 'check.command is required')
rejects(P.parseAutomationCheck, { command: 'x', timeout: '25h' }, 'at most 24h')
rejects(P.parseAutomationCheck, { command: 'x', timeout: '10' }, 'like 90m or 2h')
rejects(P.parseAutomationCheck, { command: 'x', runBy: '7:00' }, 'check.runBy must be')
rejects(
  P.parseCreateAutomationRequest,
  { name: 'Nightly', schedule, check: { command: 'x', runBy: null } },
  'check.runBy must be',
)

test('a scheduled Check needs no prompt', () => {
  expect(
    P.parseCreateAutomationRequest({ name: 'Nightly', schedule, check: { command: 'pnpm check' } }),
  ).toEqual({ name: 'Nightly', prompt: '', schedule, check: { command: 'pnpm check' } })
})
rejects(P.parseEditAutomationRequest, { template: 'linear' }, 'template is chosen at creation')
rejects(P.parseEditAutomationRequest, { checkout: 'yes' }, 'checkout must be true or false')
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
