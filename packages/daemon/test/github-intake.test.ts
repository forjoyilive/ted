import { defaultMachineSettings, type GitHubIntakeScope, type Task } from '@ted/protocol'
import { expect, test } from 'vitest'
import type { GitHubIssue, GitHubIssueRead } from '../src/github/issues.ts'
import {
  automationGitHubTask,
  githubIntakeRefusal,
  githubIntakeScope,
  trackedParentRefusal,
} from '../src/tasks/github-intake.ts'
import type { SourceClash } from '../src/tasks/sources.ts'

const repos = ['acme/widgets', 'acme/gadgets']
const parentUrl = 'https://github.com/acme/widgets/issues/3'

function found(overrides: Partial<GitHubIssue> = {}): GitHubIssueRead {
  return {
    state: 'found',
    issue: {
      url: 'https://github.com/acme/widgets/issues/7',
      repo: 'acme/widgets',
      number: 7,
      title: 'Crash on start',
      state: 'open',
      locked: false,
      body: { author: '@owner', maintainer: true, body: '', html: '', createdAt: '' },
      comments: [],
      totalComments: 0,
      hiddenComments: 0,
      labels: ['bug', 'Ready for TED'],
      allLabels: true,
      subIssues: [],
      subIssuesComplete: true,
      ...overrides,
    },
  }
}

const tracked: SourceClash = { kind: 'open', task: { displayId: 'NB-4' } as Task }

function refusal(
  read: GitHubIssueRead,
  scope: GitHubIntakeScope | undefined,
  clash?: SourceClash,
): string | undefined {
  return githubIntakeRefusal({
    label: 'acme/widgets#7',
    read,
    repos,
    scope,
    tracked: (url) => (url === parentUrl ? clash : undefined),
  })
}

test('an open issue in a Factory repo passes with no label set, and with the label in any case', () => {
  expect(refusal(found(), undefined)).toBeUndefined()
  expect(refusal(found(), { label: 'ready for ted' })).toBeUndefined()
})

test('each refusal says which rule the issue broke', () => {
  const label = { label: 'ready for TED' }
  expect(refusal({ state: 'outside-factory' }, undefined)).toBe(
    'acme/widgets#7 isn’t in one of this Factory’s repos (acme/widgets, acme/gadgets). Leave it for another Factory.',
  )
  expect(refusal({ state: 'unreadable', reason: 'signed-out' }, undefined)).toContain(
    'the GitHub CLI isn’t signed in',
  )
  expect(refusal(found({ state: 'closed' }), undefined)).toContain('is closed on GitHub')
  expect(refusal(found({ labels: ['bug'] }), label)).toBe(
    'acme/widgets#7 doesn’t have the label "ready for TED", which this Factory’s GitHub intake requires. Leave it until a maintainer adds the label.',
  )
  expect(refusal(found({ labels: ['bug'], allLabels: false }), label)).toContain(
    'couldn’t read all of acme/widgets#7’s labels',
  )
})

test('a sub-issue is refused only while its parent issue is tracked in the Factory', () => {
  const parent = { owner: 'acme', repo: 'widgets', number: 3, url: parentUrl }
  expect(refusal(found({ parent }), undefined)).toBeUndefined()
  expect(refusal(found({ parent }), undefined, tracked)).toBe(
    'acme/widgets#7 is a sub-issue of acme/widgets#3, which this Factory already tracks as NB-4. Leave it; that Task covers it.',
  )
})

test('a change to the setting between the read and the commit is refused', () => {
  let current: GitHubIntakeScope | undefined = { label: 'ready' }
  const store = {
    settings: () => ({
      ...defaultMachineSettings,
      githubIntakeScopes: current ? { f: current } : {},
    }),
  }
  const read = githubIntakeScope(store, 'f')
  expect(read.scope).toEqual({ label: 'ready' })
  current = { label: 'ready' }
  expect(() => read.unchanged()).not.toThrow()
  current = undefined
  expect(() => read.unchanged()).toThrow('GitHub intake setting changed')
})

test('the parent check made again before the commit gives the same reason', () => {
  const issue = {
    owner: 'acme',
    repo: 'widgets',
    number: 7,
    url: 'https://github.com/acme/widgets/issues/7',
  }
  const parent = { owner: 'acme', repo: 'widgets', number: 3, url: parentUrl }
  expect(trackedParentRefusal(issue, parent, tracked)).toBe(
    refusal(found({ parent }), undefined, tracked),
  )
})

test('only a Task an Automation made from a GitHub issue is kept from starting on its own', () => {
  const github = { url: 'https://github.com/acme/widgets/issues/7' }
  expect(automationGitHubTask({ createdBy: 'automation', source: github })).toBe(true)
  expect(automationGitHubTask({ createdBy: 'human', source: github })).toBe(false)
  expect(
    automationGitHubTask({
      createdBy: 'automation',
      source: { url: 'https://linear.app/acme/issue/NB-1' },
    }),
  ).toBe(false)
  expect(automationGitHubTask({ createdBy: 'automation' })).toBe(false)
})
