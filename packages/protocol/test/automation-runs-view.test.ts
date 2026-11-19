import { expect, test } from 'vitest'
import type { AutomationRunRow } from '../src/automation.ts'
import {
  activeRunFilters,
  automationRunCount,
  defaultAutomationRunsView,
  filterRuns,
  nextRunsSort,
  parseAutomationRunsView,
  runStatus,
  sortRuns,
} from '../src/automation-runs-view.ts'
import type { RunSlots } from '../src/slots.ts'

const row = (id: string, fields: Partial<AutomationRunRow> = {}): AutomationRunRow => ({
  run: {
    id,
    automationId: `a-${id}`,
    trigger: 'scheduled',
    at: '2026-11-18T09:00:00.000Z',
    result: { kind: 'no-new-tasks' },
  },
  automationName: id,
  factoryId: 'nb',
  priority: 'high',
  state: 'ended',
  ...fields,
})

const ids = (rows: AutomationRunRow[]) => rows.map((r) => r.run.id)
const factoryName = (id: string) => (id === 'nb' ? 'Notebook' : id === 'ws' ? 'Website' : id)

const running = row('running', {
  state: 'running',
  run: {
    ...row('running').run,
    startedAt: '2026-11-18T09:05:00.000Z',
    result: { kind: 'running' },
  },
})
const first = row('first', {
  state: 'queued',
  place: 1,
  priority: 'low',
  run: { ...row('first').run, at: '2026-11-18T09:10:00.000Z', result: { kind: 'queued' } },
})
const fourth = row('fourth', {
  state: 'queued',
  place: 4,
  priority: 'urgent',
  factoryId: 'ws',
  run: { ...row('fourth').run, at: '2026-11-18T09:01:00.000Z', result: { kind: 'queued' } },
})
const failed = row('failed', {
  scheduledCheck: true,
  run: {
    ...row('failed').run,
    finishedAt: '2026-11-18T08:00:00.000Z',
    result: { kind: 'check-failed', tasks: [] },
  },
})
const stopped = row('stopped', {
  priority: 'none',
  run: {
    ...row('stopped').run,
    finishedAt: '2026-11-18T08:30:00.000Z',
    result: { kind: 'dropped' },
  },
})

test('each row has one status for the Status filter', () => {
  expect([running, first, failed, stopped, row('done')].map(runStatus)).toEqual([
    'running',
    'queued',
    'failed',
    'stopped',
    'finished',
  ])
})

test('filters narrow by Factory, Automation, status, priority and kind, and count what’s on', () => {
  const rows = [running, first, fourth, failed, stopped]
  expect(ids(filterRuns(rows, {}))).toEqual(ids(rows))
  expect(ids(filterRuns(rows, { factories: ['ws'] }))).toEqual(['fourth'])
  expect(ids(filterRuns(rows, { automations: ['a-first', 'a-failed'] }))).toEqual([
    'first',
    'failed',
  ])
  expect(ids(filterRuns(rows, { statuses: ['queued', 'stopped'] }))).toEqual([
    'first',
    'fourth',
    'stopped',
  ])
  expect(ids(filterRuns(rows, { priorities: ['urgent', 'none'] }))).toEqual(['fourth', 'stopped'])
  expect(ids(filterRuns(rows, { kinds: ['check'] }))).toEqual(['failed'])
  expect(ids(filterRuns(rows, { kinds: ['agent'], factories: ['nb'] }))).toEqual([
    'running',
    'first',
    'stopped',
  ])
  expect(activeRunFilters({ kinds: ['agent'], factories: ['nb', 'ws'] })).toBe(3)
})

test('Start order puts queued Runs by place and others newest first; Descending reverses it', () => {
  expect(ids(sortRuns([fourth, first], 'start', 'ascending', factoryName))).toEqual([
    'first',
    'fourth',
  ])
  expect(ids(sortRuns([failed, stopped], 'start', 'ascending', factoryName))).toEqual([
    'stopped',
    'failed',
  ])
  expect(ids(sortRuns([failed, stopped], 'start', 'descending', factoryName))).toEqual([
    'failed',
    'stopped',
  ])
})

test('each column sorts both ways, and ties keep start order', () => {
  const queued = [first, fourth]
  expect(ids(sortRuns(queued, 'priority', 'descending', factoryName))).toEqual(['fourth', 'first'])
  expect(ids(sortRuns(queued, 'priority', 'ascending', factoryName))).toEqual(['first', 'fourth'])
  expect(ids(sortRuns(queued, 'automation', 'descending', factoryName))).toEqual([
    'fourth',
    'first',
  ])
  expect(ids(sortRuns(queued, 'factory', 'ascending', factoryName))).toEqual(['first', 'fourth'])
  expect(ids(sortRuns(queued, 'factory', 'descending', factoryName))).toEqual(['fourth', 'first'])
  expect(ids(sortRuns(queued, 'time', 'ascending', factoryName))).toEqual(['fourth', 'first'])
  const tied = [row('b', { state: 'queued', place: 2 }), row('a', { state: 'queued', place: 1 })]
  expect(ids(sortRuns(tied, 'priority', 'descending', factoryName))).toEqual(['a', 'b'])
})

test('a column header sorts by it, then flips the direction', () => {
  const byName = nextRunsSort(defaultAutomationRunsView, 'automation')
  expect(byName).toMatchObject({ sort: 'automation', direction: 'ascending' })
  expect(nextRunsSort(byName, 'automation')).toMatchObject({ direction: 'descending' })
})

test('the saved view keeps known values and drops the rest', () => {
  expect(
    parseAutomationRunsView({
      filters: {
        factories: ['nb', 3],
        statuses: ['queued', 'later'],
        priorities: ['urgent'],
        kinds: [],
      },
      sort: 'priority',
      direction: 'descending',
    }),
  ).toEqual({
    filters: { factories: ['nb'], statuses: ['queued'], priorities: ['urgent'] },
    sort: 'priority',
    direction: 'descending',
  })
  expect(() =>
    parseAutomationRunsView({ filters: {}, sort: 'size', direction: 'ascending' }),
  ).toThrow('sort')
})

test('the sidebar counts running and queued Automation Runs', () => {
  const automation = { runId: 'r1', automationId: 'a', name: 'Intake', factoryId: 'nb' }
  const slots: Pick<RunSlots, 'holders' | 'queue'> = {
    holders: [
      { kind: 'automation', ...automation, runs: 1 },
      { kind: 'planning', runId: 'p', planId: 'p', name: 'Plan', factoryId: 'nb', runs: 1 },
    ],
    queue: [{ kind: 'automation', ...automation, runId: 'r2', place: 1 }],
  }
  expect(automationRunCount(slots)).toBe(2)
})
