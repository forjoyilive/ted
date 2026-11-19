import { setTimePreferences } from '../src/renderer/time.ts'

beforeEach(() => setTimePreferences({ timeFormat: '24-hour', timeZone: 'Europe/London' }))

import type { Automation, AutomationRun, AutomationSchedule } from '@ted/protocol'
import { beforeEach, describe, expect, test } from 'vitest'
import {
  agentModel,
  draftOf,
  duplicateOf,
  duration,
  firingDate,
  historyResult,
  lastResult,
  nextFiring,
  nowChip,
  retryable,
  scheduleOf,
  templateScheduleText,
  trigger,
} from '../src/renderer/automations.ts'

const now = Date.parse('2026-11-10T09:00:00Z')
const minutes = (n: number) => new Date(now + n * 60_000).toISOString()

const run = (fields: Partial<AutomationRun>): AutomationRun => ({
  id: 'r',
  automationId: 'a',
  trigger: 'scheduled',
  at: minutes(-60),
  result: { kind: 'no-new-tasks' },
  ...fields,
})

const automation = (fields: Partial<Automation> = {}): Automation => ({
  id: 'a',
  factoryId: 'nb',
  factoryKey: 'NB',
  name: 'Daily triage',
  prompt: 'Triage',
  schedule: { kind: 'weekdays', at: '09:00' },
  timeZone: 'Europe/London',
  scheduleText: 'Weekdays at 09:00 · Europe/London',
  agent: 'claude',
  model: 'sonnet',
  effort: 'medium',
  on: true,
  createdAt: minutes(-10_000),
  nextFirings: [],
  priority: 'high',
  failuresInARow: 0,
  totals: { runs: 0, tasksCreated: 0 },
  ...fields,
})

describe('the schedule field', () => {
  test('each kind turns into a schedule, and back', () => {
    const cases: AutomationSchedule[] = [
      { kind: 'every', every: 30, unit: 'minutes' },
      { kind: 'daily', at: '13:45' },
      { kind: 'weekdays', at: '09:00' },
      { kind: 'weekly', days: ['mon', 'thu'], at: '14:00' },
      { kind: 'custom', expression: '0 9 * * 1-5' },
    ]
    for (const schedule of cases) expect(scheduleOf(draftOf(schedule))).toEqual(schedule)
  })

  test('an empty or broken field says what is wrong instead of a schedule', () => {
    const draft = draftOf({ kind: 'every', every: 30, unit: 'minutes' })
    expect(scheduleOf({ ...draft, every: '' })).toBe('Enter how often.')
    expect(scheduleOf({ ...draft, every: '2.5' })).toBe('Enter a whole number.')
    expect(scheduleOf({ ...draft, kind: 'daily', at: '' })).toBe('Enter a time.')
    expect(scheduleOf({ ...draft, kind: 'weekly', days: [] })).toBe('Pick at least one day.')
    expect(scheduleOf({ ...draft, kind: 'custom', expression: ' ' })).toBe('Enter a cron or RRULE.')
  })

  test('template cards show the schedule without the zone', () => {
    expect(templateScheduleText({ kind: 'every', every: 30, unit: 'minutes' })).toBe(
      'Every 30 minutes',
    )
    expect(templateScheduleText({ kind: 'weekdays', at: '09:00' })).toBe('Weekdays at 09:00')
  })
})

describe('the Automations page', () => {
  test('next firing reads as a countdown today and a date later; off reads Off', () => {
    expect(nextFiring(automation({ nextFirings: [minutes(12)] }), now)).toBe('in 12m')
    expect(nextFiring(automation({ nextFirings: [minutes(80)] }), now)).toBe('in 1h 20m')
    expect(nextFiring(automation({ nextFirings: [minutes(360)] }), now)).toBe('in 6h')
    expect(nextFiring(automation({ nextFirings: [minutes(60 * 24 * 7)] }), now)).toBe(
      firingDate(minutes(60 * 24 * 7)),
    )
    expect(nextFiring(automation({ on: false }), now)).toBe('Off')
    expect(firingDate('2026-11-11T09:00:00Z')).toBe('Wed 11 Nov 09:00')
  })

  test('the last result names created Tasks, failures and skips with their age', () => {
    expect(lastResult(undefined, now)).toBeUndefined()
    expect(
      lastResult(
        run({
          finishedAt: minutes(-18),
          result: {
            kind: 'created',
            tasks: [{ id: 't', displayId: 'NB-53', title: 'x', stage: 'backlog' }],
          },
        }),
        now,
      ),
    ).toEqual({ text: 'Created', tasks: ['NB-53'], age: '18m ago' })
    expect(
      lastResult(run({ finishedAt: minutes(-300), result: { kind: 'failed', error: 'x' } }), now),
    ).toEqual({ text: 'Failed', failed: true, age: '5h ago' })
    expect(lastResult(run({ result: { kind: 'skipped' } }), now)).toEqual({ text: 'Skipped' })
    expect(lastResult(run({ finishedAt: minutes(-60), result: { kind: 'stopped' } }), now)).toEqual(
      { text: 'Stopped by you', age: '1h ago' },
    )
  })

  test('Now shows the open Run’s state', () => {
    expect(nowChip(undefined)).toBeUndefined()
    expect(nowChip({ kind: 'working' })).toEqual({ text: 'Working', tone: 'working' })
    expect(nowChip({ kind: 'waiting' })).toEqual({ text: 'Waiting on you', tone: 'waiting' })
    expect(nowChip({ kind: 'queued', place: 1 })).toEqual({ text: 'Queued · 1st', tone: 'working' })
    expect(nowChip({ kind: 'queued', place: 2 })?.text).toBe('Queued · 2nd')
    expect(nowChip({ kind: 'paused', reason: 'Codex usage limit' })).toEqual({
      text: 'Paused · Codex usage limit',
      tone: 'neutral',
    })
  })

  test('Provider · model names what a scheduled Check’s agent step runs, and is blank when it runs none', () => {
    const check = { command: 'pnpm test', timeout: '1h', startTasks: false }
    expect(agentModel(automation())).toBe('Claude · sonnet')
    expect(agentModel(automation({ check: { ...check, agentStep: 'on-failure' } }))).toBe(
      'Claude · sonnet',
    )
    expect(agentModel(automation({ check: { ...check, agentStep: 'always' } }))).toBe(
      'Claude · sonnet',
    )
    expect(agentModel(automation({ check: { ...check, agentStep: 'never' } }))).toBe('')
  })
})

describe('the Automation view', () => {
  test('triggers say why the Run started', () => {
    const history = [
      run({ id: 'retry', trigger: 'retry', retryOf: 'failed' }),
      run({ id: 'failed', at: '2026-10-31T09:00:00Z', retriedAt: '2026-10-31T09:21:00Z' }),
      run({ id: 'made', trigger: 'made-up', slotAt: '2026-11-05T09:00:00Z' }),
    ]
    expect(trigger(history[0] as AutomationRun, history)).toEqual({
      text: 'Retry',
      under: 'of 09:00',
    })
    expect(trigger(history[2] as AutomationRun, history)).toEqual({
      text: 'Made up',
      under: 'for Thu 5 Nov 09:00',
    })
    expect(trigger(run({ trigger: 'run-now' }), history)).toEqual({ text: 'Run now' })
    expect(trigger(run({}), history)).toEqual({ text: 'Scheduled' })
  })

  test('Retry shows only on the newest failed row, and only until it is retried', () => {
    const failed = (id: string, retriedAt?: string) =>
      run({
        id,
        result: { kind: 'failed', error: 'x' },
        ...(retriedAt !== undefined && { retriedAt }),
      })
    expect(retryable([failed('new'), failed('old')])).toBe('new')
    expect(retryable([run({ id: 'ok' }), failed('new'), failed('old')])).toBe('new')
    expect(retryable([failed('new', minutes(-1)), failed('old')])).toBeUndefined()
    expect(retryable([run({ id: 'ok' })])).toBeUndefined()
  })

  test('results read as sentences, and a retried row says when', () => {
    expect(historyResult(run({ result: { kind: 'failed', error: 'gh: auth' } }))).toEqual({
      text: 'Failed: gh: auth',
      failed: true,
    })
    expect(historyResult(run({ result: { kind: 'skipped' } })).text).toBe(
      'Skipped: previous Run still open',
    )
    expect(historyResult(run({ result: { kind: 'stopped' } })).text).toBe('Stopped by you')
    expect(historyResult(run({ message: 'Two new issues.' }))).toEqual({
      text: 'No new Tasks',
      under: 'Two new issues.',
    })
    expect(
      historyResult(
        run({ result: { kind: 'failed', error: 'x' }, retriedAt: '2026-10-31T09:21:00Z' }),
      ).under,
    ).toBe('Retried at 09:21')
  })

  test('scheduled Check rows say passed or what failed, with their notes and the Check’s own time', () => {
    const check = {
      state: 'failed' as const,
      durationMs: 754_000,
      failing: ['a.test.ts', 'b.test.ts'],
    }
    expect(
      historyResult(
        run({
          result: { kind: 'passed' },
          check: {
            ...check,
            state: 'passed',
            failing: [],
            ranWhileBusy: true,
            skipped: ['the Electron app tests'],
          },
        }),
      ),
    ).toEqual({
      text: 'Passed',
      under: 'Ran at its cutoff while the computer was busy · Skipped the Electron app tests',
    })
    expect(historyResult(run({ result: { kind: 'check-failed', tasks: [] }, check }))).toEqual({
      text: 'Failed · 2 failing test files',
      failed: true,
    })
    expect(
      historyResult(
        run({
          result: { kind: 'check-failed', tasks: [] },
          check: { ...check, state: 'timed-out' },
        }),
      ).text,
    ).toBe('Timed out')
    expect(duration(run({ startedAt: minutes(-60), check }), now)).toBe('12m 34s')
    expect(
      historyResult(
        run({ result: { kind: 'running' }, check: { ...check, agent: { state: 'running' } } }),
      ).text,
    ).toBe('Agent working')
    expect(
      lastResult(
        run({
          finishedAt: minutes(-5),
          result: { kind: 'check-failed', tasks: [] },
          check: {
            ...check,
            agent: {
              state: 'reported',
              noted: [{ id: 't3', displayId: 'NB-3', title: 'z', stage: 'backlog' }],
            },
          },
        }),
        now,
      ),
    ).toMatchObject({ tasks: ['NB-3'] })
    expect(
      lastResult(
        run({
          finishedAt: minutes(-5),
          result: {
            kind: 'check-failed',
            tasks: [{ id: 't1', displayId: 'NB-1', title: 'x', stage: 'backlog' }],
          },
          check: {
            ...check,
            updated: [{ id: 't2', displayId: 'NB-2', title: 'y', stage: 'work' }],
          },
        }),
        now,
      ),
    ).toMatchObject({ text: 'Check failed', failed: true, tasks: ['NB-1', 'NB-2'] })
  })

  test('durations are short, and a Run that never started has none', () => {
    expect(duration(run({ startedAt: minutes(-2), finishedAt: minutes(-0.8) }), now)).toBe('1m 12s')
    expect(duration(run({ startedAt: minutes(-1), finishedAt: minutes(-0.0333) }), now)).toBe('58s')
    expect(duration(run({ startedAt: minutes(-134), finishedAt: minutes(0) }), now)).toBe('2h 14m')
    expect(duration(run({}), now)).toBe('—')
  })

  test('Duplicate copies everything but turns the copy off', () => {
    expect(duplicateOf(automation({ checkout: true, priority: 'low' }))).toEqual({
      factory: 'NB',
      name: 'Daily triage copy',
      prompt: 'Triage',
      schedule: { kind: 'weekdays', at: '09:00' },
      agent: 'claude',
      model: 'sonnet',
      effort: 'medium',
      checkout: true,
      priority: 'low',
      on: false,
    })
  })
})
