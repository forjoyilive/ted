import type { CheckRun } from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import type { LoggedEvent } from '../src/store/index.ts'
import { runNowAgents, threadEvents } from '../src/tasks/thread.ts'

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

  test('marking a Task done names who did it', () => {
    const done = (who: string) =>
      `${who} marked the Task done after its pull requests merged on GitHub`
    expect(
      lines([
        entry('v1.TaskMarkedDone', 1),
        entry('v2.TaskMarkedDone', 2, { by: 'human' }),
        entry('v2.TaskMarkedDone', 3, { by: 'lead' }),
        entry('v2.TaskMarkedDone', 4, { by: 'coordinator' }),
      ]).map(({ text }) => text),
    ).toEqual([done('You'), done('You'), done('The Task Lead'), done('The Coordinator')])
  })

  test('a stop names Ted when Ted stopped the Task', () => {
    expect(
      lines([
        entry('v1.TaskStopped', 1, { runs: 0 }),
        entry('v1.TaskStopped', 2, { runs: 2, why: 'human' }),
        entry('v1.TaskStopped', 3, { runs: 1, why: 'repair-incorporation' }),
        entry('v1.TaskStopped', 4, { runs: 1, why: 'something-new' }),
      ]),
    ).toEqual([
      { tone: 'edit', text: 'You stopped the Task' },
      { tone: 'edit', text: 'You stopped the Task · 2 Runs stopped' },
      {
        tone: 'quiet',
        text: 'Ted stopped the Task: the merged repair couldn’t be brought in · Resume to have the Task Lead try again',
      },
      { tone: 'quiet', text: 'Ted stopped the Task · 1 Run stopped' },
    ])
  })

  test('a push record Ted brought up to date names both commits', () => {
    expect(
      lines([
        entry('v1.TaskPushRecordReconciled', 1, {
          name: 'app',
          recorded: '9eaef80d0000000000000000000000000000aaaa',
          remote: '2ac276ea0000000000000000000000000000bbbb',
        }),
      ]),
    ).toEqual([
      {
        tone: 'quiet',
        text: 'The app branch on GitHub was at 2ac276ea, ahead of Ted’s recorded push 9eaef80d · the commit being pushed includes it, so Ted updated its record',
      },
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
          entry('v2.TaskRequeuedAfterBlockers', 4, { why: 'merged' }),
          entry('v2.TaskRequeuedAfterBlockers', 5, { why: 'removed' }),
        ],
        ['NB-46'],
      ),
    ).toEqual([
      { tone: 'edit', text: 'Task Lead made this Task wait for NB-46' },
      { tone: 'quiet', text: 'Waiting for NB-46 to merge' },
      { tone: 'run', text: 'Blockers merged · Task queued to carry on' },
      { tone: 'run', text: 'Blockers merged · Task queued to carry on' },
      { tone: 'run', text: 'Blockers removed · carrying on' },
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

  test('a Run now agent on the Task leaves no line, even beside a Validate Check of the same name, and a Validate instruction Check’s agent does', () => {
    const sub = (minute: number, runId: string) =>
      entry('v5.RunStarted', minute, {
        runId,
        agent: 'codex',
        model: null,
        effort: null,
        parentRunId: 'lead',
        name: 'Check · Docs drift',
      })
    const log = [sub(2, 'validate'), sub(2, 'now'), sub(5, 'try'), sub(6, 'explore')]
    const checkRuns: Pick<CheckRun, 'checks' | 'startedAt' | 'finishedAt'>[] = [
      {
        startedAt: at(1),
        finishedAt: at(3),
        checks: [
          { name: 'Docs drift', instruction: 'Fix the docs.', timeout: '20m', state: 'passed' },
        ],
      },
    ]
    const runNow = runNowAgents(
      log,
      (runId) =>
        runId === 'explore' ? undefined : runId === 'now' ? 'run-now-check' : 'instruction-check',
      checkRuns,
    )
    expect([...runNow]).toEqual(['now', 'try'])
    expect(
      threadEvents('t1', log, {
        comments: [],
        displayIdOf: (id) => id,
        waitingFor: [],
        runNowAgents: runNow,
      }).map(({ text }) => text),
    ).toEqual([
      'Sub-agent “Check · Docs drift” started · Codex',
      'Sub-agent “Check · Docs drift” started · Codex',
    ])
  })

  test('entering a Stage while the Factory’s settings are broken says which version Ted used', () => {
    const broken = {
      layer: 'factory',
      status: 'last-valid',
      version: 'a1b2c3d',
      problems: [
        { severity: 'error', file: '.ted/workflow.yaml', line: 12, column: 3, message: 'x' },
      ],
    }
    expect(
      lines([
        entry('v2.TaskStageEntered', 1, {
          stage: 'work',
          layers: JSON.stringify([{ layer: 'ted', status: 'valid', problems: [] }, broken]),
        }),
        entry('v2.TaskStageEntered', 2, {
          stage: 'validate',
          layers: JSON.stringify([{ layer: 'factory', status: 'valid', problems: [] }]),
        }),
      ]),
    ).toEqual([
      { tone: 'edit', text: 'Task moved to Work' },
      { tone: 'quiet', text: 'Used last valid Ted settings: .ted/workflow.yaml has an error' },
      { tone: 'edit', text: 'Task moved to Validate' },
    ])
  })
})

test('each line names a custom Stage by the name recorded when it was written', () => {
  const entered = (minute: number, stage: string, name: string) =>
    entry('v4.TaskStageEntered', minute, {
      stage,
      layers: JSON.stringify([]),
      names: JSON.stringify({ security: name }),
    })
  expect(
    lines([
      entered(1, 'security', 'Security review'),
      entered(2, 'work', 'Release approval'),
      entered(3, 'security', 'Release approval'),
    ]).map(({ text }) => text),
  ).toEqual([
    'Task moved to Security review',
    'Task moved to Work',
    'Task moved to Release approval',
  ])
})

test('snooze changes are recorded without embedding an unformatted time in the thread', () => {
  expect(
    lines([
      entry('v1.TaskSnoozed', 1, { until: '2099-11-11T03:45:00.000Z' }),
      entry('v1.TaskSnoozeCleared', 2),
    ]),
  ).toEqual([
    { tone: 'edit', text: 'Task snoozed' },
    { tone: 'edit', text: 'Snooze cleared' },
  ])
})

test('a start with a cause shows the cause in place of Task started, once', () => {
  const started = (minute: number, cause: string, blockers: string[] = []) => [
    entry('v1.TaskQueued', minute, { stage: 'intake' }),
    entry('v1.TaskStartCause', minute, { cause, blockers }),
  ]
  expect(
    lines([
      entry('v1.TaskQueued', 1, { stage: 'intake' }),
      ...started(2, 'factory-setting'),
      entry('v1.TaskSnoozed', 3, { until: '2099-11-11T03:45:00.000Z' }),
      entry('v1.TaskSnoozeCleared', 4),
      ...started(4, 'snooze'),
      ...started(5, 'blockers-merged', ['TED-480']),
      ...started(6, 'blockers-merged', ['TED-480', 'TED-481']),
      ...started(7, 'blockers-merged', ['TED-1', 'TED-2', 'TED-3']),
      ...started(8, 'blockers-merged'),
      ...started(9, 'coordinator'),
      ...started(10, 'automation'),
      entry('v1.TaskStartedByAutomation', 11, { name: 'Nightly triage' }),
      ...started(12, 'automation'),
      entry('v1.TaskStartedAfterPlanning', 13, { stage: 'clarify' }),
      entry('v1.TaskStartCause', 13, { cause: 'factory-setting', blockers: [] }),
    ]).map(({ text }) => text),
  ).toEqual([
    'Task started',
    'Started because Start Backlog Tasks automatically is on',
    'Task snoozed',
    'Started because its snooze ended',
    'Started because TED-480 merged',
    'Started because TED-480 and TED-481 merged',
    'Started because TED-1, TED-2 and TED-3 merged',
    'Started because its blockers merged',
    'Started by the Coordinator',
    'The Automation “Nightly triage” started this Task',
    'Started by an Automation',
    'Started because Start Backlog Tasks automatically is on · after planning · Clarify',
  ])
})
