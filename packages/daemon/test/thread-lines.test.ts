import { describe, expect, test } from 'vitest'
import type { LoggedEvent } from '../src/store/index.ts'
import { threadEvents } from '../src/tasks/thread.ts'

let seq = 0
const at = (minute: number) => `2026-11-08T10:${String(minute).padStart(2, '0')}:00.000Z`
const entry = (name: string, minute: number, data: Record<string, unknown> = {}): LoggedEvent => ({
  id: `${++seq}.0`,
  name,
  data,
  at: at(minute),
})

const lines = (log: LoggedEvent[], waitingFor: string[] = []) =>
  threadEvents('t1', log, {
    comments: [],
    displayIdOf: (id) => (id === 'b1' ? 'NB-46' : id),
    waitingFor,
  }).map(({ tone, text }) => ({ tone, text }))

describe('event lines', () => {
  test('copy notes and setup results show for each repo', () => {
    expect(
      lines([
        entry('v1.TaskWorktreeCreated', 1, {
          name: 'app',
          copied: ['.env'],
          skipped: [{ path: 'config/local.json', reason: 'missing' }],
        }),
        entry('v1.TaskWorktreeCreated', 1, { name: 'api', copied: [], skipped: [] }),
        entry('v1.TaskWorktreeSetupStarted', 2, { name: 'app', command: 'npm ci' }),
        entry('v1.TaskWorktreeSetupFinished', 3, { name: 'app', outcome: 'failed', exitCode: 1 }),
        entry('v1.TaskWorktreeSetupFinished', 4, { name: 'api', outcome: 'timed-out' }),
      ]),
    ).toEqual([
      {
        tone: 'quiet',
        text: 'Copied .env into app · didn’t copy config/local.json: not in the local folder',
      },
      { tone: 'run', text: 'Setting up app · npm ci' },
      { tone: 'failure', text: 'Setup failed in app with exit code 1' },
      { tone: 'failure', text: 'Setup timed out in api' },
    ])
  })

  test('a held Run shows Paused, and Continued only after it was held', () => {
    expect(
      lines([
        entry('v1.TaskRunReleased', 1),
        entry('v1.TaskRunHeld', 2, { agent: 'claude' }),
        entry('v1.TaskRunReleased', 3),
      ]),
    ).toEqual([
      { tone: 'quiet', text: 'Paused · Claude can’t run right now' },
      { tone: 'quiet', text: 'Continued' },
    ])
  })

  test('blockers name the Task, and who set them', () => {
    expect(
      lines(
        [
          entry('v2.TaskBlockerAdded', 1, { blockerId: 'b1', runId: 'r1' }),
          entry('v1.TaskWaitingForBlockers', 2),
          entry('v1.TaskRequeuedAfterBlockers', 3),
        ],
        ['NB-46'],
      ),
    ).toEqual([
      { tone: 'edit', text: 'Task Lead made this Task wait for NB-46' },
      { tone: 'quiet', text: 'Waiting for NB-46 to merge' },
      { tone: 'run', text: 'Blockers merged · Task queued to carry on' },
    ])
  })

  test('a Run names its agent, model and effort', () => {
    expect(
      lines([
        entry('v3.RunStarted', 1, { agent: 'codex', model: 'gpt-5', effort: 'high' }),
        entry('v1.TaskLeadSet', 2, { agent: 'claude', model: null, effort: null }),
      ]),
    ).toEqual([
      { tone: 'run', text: 'Task Lead started · Codex · gpt-5 · high effort' },
      { tone: 'edit', text: 'Task Lead set to Claude' },
    ])
  })
})
