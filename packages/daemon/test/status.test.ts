import { describe, expect, test } from 'vitest'
import { type TaskFacts, taskActivity, taskMarkers, taskStatus } from '../src/tasks/status.ts'

const at = (facts: Partial<TaskFacts>): TaskFacts => ({ stage: 'work', runs: [], ...facts })

describe('taskStatus', () => {
  test('an unstarted Backlog Task and a Done Task have no status', () => {
    expect(taskStatus(at({ stage: 'backlog' }))).toBeUndefined()
    expect(taskStatus(at({ stage: 'done', runs: ['working'] }))).toBeUndefined()
  })

  test('a started Task with nothing going on has no status', () => {
    expect(taskStatus(at({ runs: ['idle'] }))).toBeUndefined()
    expect(taskStatus(at({ runs: ['finished'] }))).toBeUndefined()
  })

  test('a working Run or TED work under way makes the Task Working', () => {
    expect(taskStatus(at({ runs: ['idle', 'working'] }))).toEqual({ kind: 'working' })
    expect(taskStatus(at({ tedWorking: true }))).toEqual({ kind: 'working' })
  })

  test('an open request or a Run waiting on the human makes it Waiting on you', () => {
    expect(taskStatus(at({ openRequests: 2, runs: ['working'] }))).toEqual({
      kind: 'waiting-on-you',
    })
    expect(taskStatus(at({ runs: ['waiting', 'working'] }))).toEqual({ kind: 'waiting-on-you' })
  })

  test('each status wins over every status below it', () => {
    const ladder: [Partial<TaskFacts>, string][] = [
      [{ failed: true }, 'failed'],
      [{ partlyMerged: true }, 'partly-merged'],
      [{ openRequests: 1 }, 'waiting-on-you'],
      [{ paused: 'Claude usage limit, resets 14:20' }, 'paused'],
      [{ runs: ['working'] }, 'working'],
      [{ stopped: true }, 'stopped'],
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
})
