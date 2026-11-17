import type { Comment, RunSummary, Task, TaskBrief, TaskPullRequest, TaskRepo } from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import {
  briefLines,
  briefPart,
  briefSummary,
  briefUpdatedLine,
  codeSummary,
  runsCollapsedSummary,
} from '../src/renderer/details.ts'

const now = Date.parse('2026-11-09T12:00:00Z')
const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString()

const briefText = [
  '## Goal\n\nStop the TypeError in SearchPanel.',
  '## Decisions so far\n\n- Guard in SearchPanel.\n- Empty list for an empty query.',
  '## Current state\n\nBoth pull requests open.',
  '## Open questions\n\nNone.',
  '## Next step\n\nYour sign-off.\n',
].join('\n\n')

const brief = (stage: TaskBrief['stage'], at: string): TaskBrief => ({
  taskId: 't1',
  version: 1,
  text: briefText,
  stage,
  createdAt: at,
})

const comment = (fields: Partial<Comment>): Comment => ({
  id: 'c1',
  taskId: 't1',
  kind: 'note',
  body: '',
  author: { kind: 'human' },
  createdAt: minutesAgo(0),
  ...fields,
})

const run = (fields: Partial<RunSummary>): RunSummary => ({
  id: 'r1',
  name: 'Task Lead',
  role: 'lead',
  agent: 'claude',
  state: 'idle',
  startedAt: minutesAgo(60),
  current: true,
  ...fields,
})

const repo = (fields: Partial<TaskRepo>): TaskRepo =>
  ({
    name: 'widgets',
    repo: 'acme/widgets',
    branch: 'nb-1-fix',
    worktree: '/w',
    ...fields,
  }) as TaskRepo

describe('Task details summaries', () => {
  test('the brief’s parts come from its fixed headings', () => {
    expect(briefPart(briefText, 'Goal')).toBe('Stop the TypeError in SearchPanel.')
    expect(briefPart(briefText, 'Next step')).toBe('Your sign-off.')
    expect(briefPart('## Goal\n\n', 'Next step')).toBeUndefined()
    expect(briefLines('- Guard in SearchPanel.\n* Empty list.\nPlain')).toEqual([
      '• Guard in SearchPanel.',
      '• Empty list.',
      'Plain',
    ])
  })

  test('a brief written just before a sign-off request says it was at that Sign-off', () => {
    const written = brief('review', minutesAgo(31))
    const gate = comment({
      kind: 'signoff',
      stage: 'review',
      createdAt: minutesAgo(30),
      gate: { approveLabel: 'Approve' },
    })
    expect(briefUpdatedLine(written, [gate], now)).toBe(
      'Updated by the Task Lead at the Review sign-off · 31m ago',
    )
    expect(briefUpdatedLine(written, [], now)).toBe('Updated by the Task Lead in Review · 31m ago')
    const earlier = { ...gate, createdAt: minutesAgo(40) }
    expect(briefUpdatedLine(written, [earlier], now)).toBe(
      'Updated by the Task Lead in Review · 31m ago',
    )
    expect(briefSummary(written, now)).toBe('updated 31m ago')
    expect(briefSummary(null, now)).toBe('not written yet')
  })

  test('Runs collapse to the Task Lead’s state, live sub-agents and stopped Runs', () => {
    expect(
      runsCollapsedSummary([
        run({}),
        run({ id: 'r2', state: 'finished' }),
        run({ id: 'r3', state: 'finished', role: 'sub-agent' }),
        run({ id: 'r4', state: 'finished' }),
      ]),
    ).toBe('Task Lead idle · 0 active sub-agents · 3 stopped')
    expect(
      runsCollapsedSummary([
        run({ state: 'working', onSubAgents: true }),
        run({ id: 'r2', role: 'sub-agent', parentRunId: 'r1', state: 'working' }),
      ]),
    ).toBe('Task Lead on sub-agents · 1 active sub-agent')
    expect(runsCollapsedSummary([run({ state: 'finished' })])).toBe(
      '0 active sub-agents · 1 stopped',
    )
  })

  test('Code collapses to the pull request, the branch or the repo count', () => {
    const task = (repos: TaskRepo[]) => ({ repos }) as unknown as Task
    expect(codeSummary(task([]))).toBe('no worktree yet')
    expect(codeSummary(task([repo({})]))).toBe('nb-1-fix')
    expect(
      codeSummary(
        task([repo({ pullRequest: { number: 482, state: 'draft' } as TaskPullRequest })]),
      ),
    ).toBe('PR #482 · draft')
    expect(codeSummary(task([repo({}), repo({ name: 'api' })]))).toBe('2 repos')
    expect(codeSummary(task([repo({ removed: { at: minutesAgo(5) } })]))).toBe('worktree removed')
  })
})
