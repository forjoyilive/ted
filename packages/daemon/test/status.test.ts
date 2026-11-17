import { describe, expect, test } from 'vitest'
import {
  commentBox,
  leadAskedAtMerge,
  statusWithoutBlocker,
  type TaskFacts,
  taskActivity,
  taskCanResume,
  taskIsMerged,
  taskMarkers,
  taskStatus,
  taskStatuses,
} from '../src/tasks/status.ts'

const at = (facts: Partial<TaskFacts>): TaskFacts => ({ stage: 'work', runs: [], ...facts })

describe('interrupted Tasks', () => {
  test('offers continuation and explains it without claiming the human stopped the Task', () => {
    const facts = at({ interrupted: true, agentActivity: 'Old activity' })
    expect(taskCanResume(facts)).toBe(true)
    expect(taskStatus(facts)).toBeUndefined()
    expect(commentBox(facts, taskStatus(facts))).toBe('stopped')
    expect(taskActivity(facts)).toBe('The Task Lead has stopped. Resume to carry on.')
    expect(taskCanResume(at({}))).toBe(false)
  })

  test.each<Partial<TaskFacts>>([
    { stage: 'backlog' },
    { stage: 'done' },
    { stage: 'merge' },
    { archived: true },
    { failed: true },
    { partlyMerged: { merged: ['api'], open: ['app'] } },
    { paused: 'Offline' },
    { runs: ['working'] },
    { runs: ['idle'] },
    { runs: ['waiting'] },
    { leadLive: true },
    { openRequests: 1 },
    { queue: { place: 1 } },
    { queue: { hold: 'Disk full' } },
    { checksActive: true },
    { settingUp: true },
    { checking: { name: 'Lint', index: 1, total: 1 } },
    { github: 'ci' },
    { mergePending: true },
    { blockedBy: ['NB-2'] },
    { planningInChat: true },
    { stopped: { at: '2026-11-09T20:00:00Z', runs: 1, why: 'human' } },
  ])('does not offer interrupted continuation during another state: %j', (other) => {
    expect(taskCanResume(at({ interrupted: true, ...other }))).toBe(false)
  })
})

describe('taskStatus', () => {
  test('an unstarted Backlog Task and a Done Task have no status', () => {
    expect(taskStatus(at({ stage: 'backlog' }))).toBeUndefined()
    expect(taskStatus(at({ stage: 'done', runs: ['working'] }))).toBeUndefined()
  })

  test('a started Task with nothing going on has no status', () => {
    expect(taskStatus(at({ runs: ['idle'] }))).toBeUndefined()
    expect(taskStatus(at({ runs: ['finished'] }))).toBeUndefined()
  })

  test('a working Run, worktree setup or Cleanup commands make the Task Working', () => {
    expect(taskStatus(at({ runs: ['idle', 'working'] }))).toEqual({ kind: 'working' })
    expect(taskStatus(at({ settingUp: true }))).toEqual({ kind: 'working' })
    expect(taskActivity(at({ settingUp: true }))).toBe('Setting up the worktree')
    const cleanup = at({ stage: 'cleanup', checksActive: true, cleanupCommandsRunning: true })
    expect(taskStatus(cleanup)).toEqual({ kind: 'working' })
    expect(taskStatuses(cleanup)).toEqual(['working'])
  })

  test('TED’s Checks alone show their chip and no Working status', () => {
    const running = at({ checksActive: true, checking: { name: 'Tests', index: 1, total: 2 } })
    const waitingForSlot = at({ checksActive: true, checksWaiting: { place: 2 } })
    const waitingForTests = at({
      ...running,
      testActivity: { running: 0, waiting: 0, checksWaiting: true },
    })
    for (const [facts, label] of [
      [running, 'Running checks'],
      [waitingForSlot, 'Waiting for checks'],
      [waitingForTests, 'Waiting for checks'],
    ] as const) {
      expect(taskStatus(facts)).toBeUndefined()
      expect(taskStatuses(facts)).toEqual([])
      expect(taskCanResume({ ...facts, interrupted: true })).toBe(false)
      expect(taskMarkers(facts, undefined)).toMatchObject([{ kind: 'test-activity', label }])
    }
    expect(taskStatus({ ...running, runs: ['working'] })).toEqual({ kind: 'working' })
    expect(taskStatus({ ...running, blockedBy: ['NB-2'] })).toEqual({ kind: 'blocked', by: 'NB-2' })
    expect(taskStatus({ ...running, stage: 'merge', github: 'ci' })).toEqual({
      kind: 'waiting-for-github',
      on: 'ci',
    })
    expect(taskActivity(at({ checksActive: true, checksWaiting: { place: 2 } }))).toBe(
      'Waiting to run Checks · 2nd',
    )
    expect(taskActivity(at({ checksActive: true, movingAfterChecks: true }))).toBe(
      'Running Checks before moving on',
    )
    expect(
      taskActivity(
        at({
          checksActive: true,
          movingAfterChecks: true,
          checking: { name: 'Tests', index: 1, total: 2 },
        }),
      ),
    ).toBe('Running Checks before moving on · Tests (1 of 2)')
  })

  test('an open request or a Run waiting on the human makes it Waiting on you', () => {
    expect(taskStatus(at({ openRequests: 2, runs: ['working'] }))).toEqual({
      kind: 'waiting-on-you',
    })
    expect(taskStatus(at({ runs: ['waiting', 'working'] }))).toEqual({ kind: 'waiting-on-you' })
  })

  test('when every open request is snoozed, Waiting on you carries the first return time', () => {
    const until = '2099-11-11T09:00:00.000Z'
    expect(
      taskStatus(at({ openRequests: 2, runs: ['waiting'], requestsSnoozedUntil: until })),
    ).toEqual({ kind: 'waiting-on-you', snoozedUntil: until })
    expect(taskStatus(at({ failed: true, openRequests: 1, requestsSnoozedUntil: until }))).toEqual({
      kind: 'failed',
    })
  })

  test('each status wins over every status below it', () => {
    const ladder: [Partial<TaskFacts>, string][] = [
      [{ failed: true }, 'failed'],
      [{ partlyMerged: { merged: ['app'], open: ['api'] } }, 'partly-merged'],
      [{ openRequests: 1 }, 'waiting-on-you'],
      [{ paused: 'Claude usage limit, resets 14:20' }, 'paused'],
      [{ runs: ['working'] }, 'working'],
      [{ stopped: { at: '2026-11-08T10:00:00.000Z', runs: 3, why: 'human' } }, 'stopped'],
      [{ blockedBy: ['NB-44'] }, 'blocked'],
      [{ queue: { place: 2 } }, 'queued'],
      [{ github: 'ci' }, 'waiting-for-github'],
    ]
    for (const [i, [facts, kind]] of ladder.entries()) {
      const withEverythingBelow = Object.assign({}, ...ladder.slice(i).map(([f]) => f))
      expect(taskStatus(at({ stage: 'merge', ...withEverythingBelow }))?.kind).toBe(kind)
      expect(taskStatus(at({ stage: 'merge', ...facts }))?.kind).toBe(kind)
    }
  })

  test('a blocked Task also carries the status it would have without its blocker', () => {
    const without = (facts: Partial<TaskFacts>) => {
      const all = at(facts)
      return statusWithoutBlocker(all, taskStatus(all))
    }
    expect(without({ stage: 'intake', blockedBy: ['NB-44'], queue: { place: 2 } })).toEqual({
      kind: 'queued',
      place: 2,
    })
    expect(without({ blockedBy: ['NB-44'], github: 'ci' })).toEqual({
      kind: 'waiting-for-github',
      on: 'ci',
    })
    expect(without({ blockedBy: ['NB-44'] })).toBeUndefined()
    expect(without({ blockedBy: ['NB-44'], runs: ['working'] })).toBeUndefined()
    expect(without({ stage: 'intake', queue: { place: 2 } })).toBeUndefined()
  })

  test('statuses carry what their chip shows', () => {
    expect(taskStatus(at({ paused: 'Codex usage limit' }))).toEqual({
      kind: 'paused',
      reason: 'Codex usage limit',
    })
    expect(taskStatus(at({ blockedBy: ['NB-44', 'NB-45'] }))).toEqual({
      kind: 'blocked',
      by: 'NB-44',
    })
    expect(taskStatus(at({ stage: 'intake', queue: { place: 2 } }))).toEqual({
      kind: 'queued',
      place: 2,
    })
    expect(taskStatus(at({ stage: 'intake', queue: { hold: 'disk full' } }))).toEqual({
      kind: 'queued',
      hold: 'disk full',
    })
    const busy = { memoryAvailable: 0.07 }
    expect(taskStatus(at({ stage: 'intake', queue: { place: 2 }, busy }))).toEqual({
      kind: 'queued',
      hold: 'this computer is busy',
      busy,
    })
    expect(taskStatus(at({ stage: 'intake', queue: { hold: 'disk full' }, busy }))).toEqual({
      kind: 'queued',
      hold: 'disk full',
    })
    expect(
      taskStatus(at({ stage: 'validate', queue: { place: 3, after: 'checks-passed' }, busy })),
    ).toEqual({ kind: 'queued', place: 3, after: 'checks-passed' })
    expect(taskStatus(at({ runs: ['working'], busy }))).toEqual({ kind: 'working' })
    expect(taskStatus(at({ stage: 'merge', github: 'review' }))).toEqual({
      kind: 'waiting-for-github',
      on: 'review',
    })
  })

  test('a blocked Task in Backlog has no status; the blocker is a marker', () => {
    const facts = at({ stage: 'backlog', blockedBy: ['NB-41'], needsPlanning: true })
    expect(taskStatus(facts)).toBeUndefined()
    expect(taskMarkers(facts, taskStatus(facts))).toEqual([
      { kind: 'needs-planning' },
      { kind: 'blocked-by', by: 'NB-41' },
    ])
  })

  test('a Task that needs planning says so in its activity line', () => {
    expect(taskActivity(at({ stage: 'backlog', needsPlanning: true }))).toBe(
      'Waiting for a plan made outside TED',
    )
  })

  test('a blocked Task with a higher status shows Blocked by as a marker', () => {
    const facts = at({ failed: true, blockedBy: ['MS-7'] })
    expect(taskStatus(facts)).toEqual({ kind: 'failed' })
    expect(taskMarkers(facts, taskStatus(facts))).toEqual([{ kind: 'blocked-by', by: 'MS-7' }])
  })

  test('Blocked as the status is not repeated as a marker', () => {
    const facts = at({ blockedBy: ['NB-46'] })
    expect(taskMarkers(facts, taskStatus(facts))).toEqual([])
  })
})

describe('taskActivity', () => {
  test('the agent’s text wins', () => {
    expect(taskActivity(at({ stage: 'backlog', agentActivity: 'Reading the code' }))).toBe(
      'Reading the code',
    )
  })

  test('TED fills in for a Backlog Task and a blocked Task', () => {
    expect(taskActivity(at({ stage: 'backlog' }))).toBe('Not started')
    expect(taskActivity(at({ stage: 'design', blockedBy: ['NB-46'] }))).toBe(
      'Starts when NB-46 merges',
    )
    expect(taskActivity(at({ runs: ['working'] }))).toBeUndefined()
  })

  test('a Partly merged Task names what merged and what hasn’t, unless the agent says more', () => {
    const partlyMerged = { merged: ['app'], open: ['api', 'web'] }
    expect(taskActivity(at({ stage: 'merge', partlyMerged }))).toBe(
      'app merged · api and web not yet',
    )
    expect(taskActivity(at({ partlyMerged, agentActivity: 'Fixing api’s tests' }))).toBe(
      'Fixing api’s tests',
    )
  })

  test('a blocked Task whose Task Lead carries on is not Blocked; the blocker is a marker', () => {
    const facts = at({ runs: ['idle'], blockedBy: ['NB-41'] })
    expect(taskStatus(facts)).toBeUndefined()
    expect(taskMarkers(facts, taskStatus(facts))).toEqual([{ kind: 'blocked-by', by: 'NB-41' }])
    expect(taskActivity(facts)).toBeUndefined()
  })
})

test('a snoozed Backlog Task carries its schedule alongside blockers without inventing a Stage', () => {
  const until = '2099-11-11T09:00:00.000Z'
  const facts = at({ stage: 'backlog', snoozedUntil: until, blockedBy: ['NB-2'] })
  expect(taskStatus(facts)).toBeUndefined()
  expect(taskMarkers(facts, undefined)).toEqual([
    { kind: 'snoozed', until },
    { kind: 'blocked-by', by: 'NB-2' },
  ])
  expect(taskActivity(at({ stage: 'backlog', snoozedUntil: until }))).toBe('Scheduled to start')
  expect(taskMarkers({ ...facts, archived: true }, undefined)).toEqual([])
})

describe('an answer at Merge', () => {
  const asked = {
    stage: 'merge',
    leadRunId: 'lead',
    askedBy: 'lead',
    leadEnded: 'stopped',
    openRequests: 0,
  } as const

  test('restarts a Task Lead that asked and was stopped while it waited', () => {
    expect(leadAskedAtMerge(asked)).toBe(true)
  })

  test.each<Partial<Parameters<typeof leadAskedAtMerge>[0]>>([
    { stage: 'work' },
    { askedBy: undefined },
    { askedBy: 'sub-agent' },
    { leadEnded: undefined },
    { leadEnded: 'lost' },
    { openRequests: 1 },
  ])('leaves it when %o', (change) => {
    expect(leadAskedAtMerge({ ...asked, ...change })).toBe(false)
  })
})

describe('Cleanup', () => {
  test('a failed Cleanup waits on the user, and a Task in Cleanup or Done counts as merged', () => {
    const failed = at({ stage: 'cleanup', openRequests: 1, cleanupFailed: true })
    expect(taskStatus(failed)).toMatchObject({ kind: 'waiting-on-you' })
    expect(taskActivity(failed)).toBe('Cleanup failed · waiting on you')
    const merged = [{ number: 7, state: 'merged' }]
    expect(taskIsMerged('cleanup', merged)).toBe(true)
    expect(taskIsMerged('done', merged)).toBe(true)
    expect(taskIsMerged('merge', merged)).toBe(false)
    expect(taskIsMerged('cleanup', [{ number: 7, state: 'open' }])).toBe(false)
  })
})
