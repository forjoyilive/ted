import {
  type AsanaIntakeScope,
  defaultMachineSettings,
  type GitHubIntakeScope,
  type LinearIntakeScope,
  type MachineSettings,
  type Task,
} from '@ted/protocol'
import { describe, expect, test } from 'vitest'
import type { RootCheck } from '../src/asana/intake.ts'
import type { GitHubIssue, GitHubIssueRead } from '../src/github/issues.ts'
import {
  asanaIntakeHold,
  automationGitHubTask,
  automationIntake,
  githubIntakeHold,
  intakeLines,
  linearIntakeHold,
  planGitHubIntake,
  refuseAsanaRoot,
  refuseLinearList,
} from '../src/tasks/intake.ts'
import type { SourceClash } from '../src/tasks/sources.ts'

function settingsStore(initial: Partial<MachineSettings> = {}) {
  let settings: MachineSettings = { ...defaultMachineSettings, ...initial }
  return {
    settings: () => settings,
    set(next: Partial<MachineSettings>) {
      settings = { ...settings, ...next }
    },
  }
}

const tracked: SourceClash = { kind: 'open', task: { displayId: 'NB-4' } as Task }

describe('Linear', () => {
  const url = 'https://linear.app/acme/issue/NB-1'
  const scope: LinearIntakeScope = {
    kind: 'project',
    id: 'project-one',
    name: 'One',
    workspace: 'acme',
    workspaceId: 'workspace-acme',
  }
  const membership = {
    workspace: 'acme',
    workspaceId: 'workspace-acme',
    teamId: 'team-NB',
    projectId: 'project-one',
  }
  const linearIntake = (
    store: ReturnType<typeof settingsStore>,
    intakeMembership: (() => Promise<typeof membership>) | undefined,
    factoryId = 'f',
    sourceUrl = url,
  ) =>
    automationIntake({
      store,
      linear: intakeMembership && { intakeMembership: async () => intakeMembership() },
      factoryId,
      sourceUrl,
    })

  test('an issue in scope passes', async () => {
    const store = settingsStore({ linearIntakeScopes: { f: scope } })
    const intake = linearIntake(store, async () => membership)
    await intake.verify()
    expect(() => intake.unchanged()).not.toThrow()
  })

  test('rejects scope changes during membership lookup and before commit', async () => {
    const store = settingsStore({ linearIntakeScopes: { f: scope } })
    await expect(
      linearIntake(store, async () => {
        store.set({ linearIntakeScopes: { f: { ...scope, id: 'project-two' } } })
        return membership
      }).verify(),
    ).rejects.toThrow('scope changed')
    store.set({ linearIntakeScopes: { f: scope } })
    const intake = linearIntake(store, async () => membership)
    await intake.verify()
    store.set({ linearIntakeScopes: { f: { ...scope, id: 'project-two' } } })
    expect(() => intake.unchanged()).toThrow(
      'The Factory’s Linear intake scope changed. Try creating the Task again.',
    )
  })

  test.each([
    { ...membership, workspaceId: 'different' },
    { ...membership, workspace: 'elsewhere' },
    { ...membership, projectId: null },
    { ...membership, projectId: 'different' },
  ])('rejects membership outside the scope: %j', async (result) => {
    const store = settingsStore({ linearIntakeScopes: { f: scope } })
    await expect(
      linearIntake(store, async () => result as typeof membership).verify(),
    ).rejects.toThrow('outside this Factory')
  })

  const teamScope: LinearIntakeScope = { ...scope, kind: 'team', id: 'team-NB', name: 'Widgets' }

  test.each([
    { scope: teamScope, result: membership, accepted: true },
    { scope: teamScope, result: { ...membership, projectId: 'project-two' }, accepted: true },
    { scope: teamScope, result: { ...membership, projectId: null }, accepted: true },
    { scope: teamScope, result: { ...membership, teamId: 'team-OT' }, accepted: false },
    {
      scope: teamScope,
      result: { ...membership, teamId: 'team-OT', projectId: null },
      accepted: false,
    },
    { scope: teamScope, result: { ...membership, workspaceId: 'different' }, accepted: false },
    { scope, result: { ...membership, teamId: 'team-OT' }, accepted: true },
    { scope, result: { ...membership, projectId: 'project-two' }, accepted: false },
  ])('a team or project scope checks only its own kind of membership: %j', async (row) => {
    const store = settingsStore({ linearIntakeScopes: { f: row.scope } })
    const check = linearIntake(store, async () => row.result as typeof membership).verify()
    if (row.accepted) await expect(check).resolves.toBeUndefined()
    else
      await expect(check).rejects.toThrow(
        `NB-1 is outside this Factory’s Linear intake scope (${row.scope.kind}: ${row.scope.name}). Leave it for another Factory or import it manually.`,
      )
  })

  test('does not apply Linear scope to another source or to an unscoped Factory', async () => {
    const store = settingsStore({ linearIntakeScopes: { f: scope } })
    await expect(linearIntake(store, undefined, 'other').verify()).resolves.toBeUndefined()
    await expect(
      linearIntake(store, undefined, 'f', 'https://github.com/acme/widgets/issues/1').verify(),
    ).resolves.toBeUndefined()
  })

  test('a scoped Factory without Linear connected is refused', async () => {
    const store = settingsStore({ linearIntakeScopes: { f: scope } })
    await expect(linearIntake(store, undefined).verify()).rejects.toThrow(
      'Couldn’t verify the Factory’s Linear intake scope. Connect Linear in App Settings → Integrations and try again.',
    )
  })

  test('a Linear Follow-up is allowed; its scope is checked like any issue', async () => {
    const store = settingsStore({ linearIntakeScopes: { f: scope } })
    const intake = automationIntake({
      store,
      linear: { intakeMembership: async () => ({ ...membership, projectId: 'different' }) },
      factoryId: 'f',
      sourceUrl: url,
      followUpSourceUrl: url,
    })
    await expect(intake.verify()).rejects.toThrow('outside this Factory')
  })

  test('bulk intake needs a saved scope in the connected workspace and stops when the scope changes', () => {
    const factory = { id: 'f', name: 'Notebook' }
    expect(() => linearIntakeHold(settingsStore(), factory, () => false)).toThrow(
      'Ted imports Linear work in bulk only from Notebook’s Linear intake scope. Choose a Linear Team or Project in Configuration → Linear intake first.',
    )
    const store = settingsStore({ linearIntakeScopes: { f: scope } })
    let gone = false
    const hold = linearIntakeHold(store, factory, () => gone)
    expect(hold.scope).toEqual(scope)
    expect(() => refuseLinearList(scope, membership)).not.toThrow()
    expect(() =>
      refuseLinearList(scope, { workspace: 'other', workspaceId: 'workspace-other' }),
    ).toThrow(
      'The connected Linear workspace (other) isn’t the one this Factory’s Linear intake scope is in (acme).',
    )
    gone = true
    expect(() => hold.unchanged()).toThrow('Notebook is being removed')
    gone = false
    store.set({ linearIntakeScopes: { f: { ...scope, id: 'project-two' } } })
    expect(() => hold.unchanged()).toThrow(
      'Notebook’s Linear intake scope changed during the import. Ted stopped; the next run uses the new scope.',
    )
  })
})

describe('GitHub', () => {
  const repos = ['acme/widgets', 'acme/gadgets']
  const issueUrl = 'https://github.com/acme/widgets/issues/7'
  const parentUrl = 'https://github.com/acme/widgets/issues/3'
  const parent = { owner: 'acme', repo: 'widgets', number: 3, url: parentUrl }

  function found(overrides: Partial<GitHubIssue> = {}): GitHubIssueRead {
    return {
      state: 'found',
      issue: {
        url: issueUrl,
        repo: 'acme/widgets',
        number: 7,
        title: 'Crash on start',
        state: 'open',
        locked: false,
        body: { author: '@owner', maintainer: true, body: '', html: '', createdAt: '' },
        comments: [],
        totalComments: 0,
        hiddenComments: 0,
        labels: ['bug', 'Ready for Ted'],
        allLabels: true,
        subIssues: [],
        subIssuesComplete: true,
        ...overrides,
      },
    }
  }

  const githubIntake = (scope?: GitHubIntakeScope) =>
    automationIntake({
      store: settingsStore({ githubIntakeScopes: scope ? { f: scope } : {} }),
      linear: undefined,
      factoryId: 'f',
      sourceUrl: issueUrl,
    })

  function refusal(
    read: GitHubIssueRead | undefined,
    scope: GitHubIntakeScope | undefined,
    clash?: SourceClash,
  ): string | undefined {
    try {
      githubIntake(scope).judgeGitHub({
        label: 'acme/widgets#7',
        read,
        repos,
        tracked: (url) => (url === parentUrl ? clash : undefined),
      })
      return undefined
    } catch (error) {
      return (error as Error).message
    }
  }

  test('an open issue in a Factory repo passes with no label set, and with the label in any case', () => {
    expect(refusal(found(), undefined)).toBeUndefined()
    expect(refusal(found(), { label: 'ready for ted' })).toBeUndefined()
  })

  test('each refusal says which rule the issue broke', () => {
    const label = { label: 'ready for Ted' }
    expect(refusal({ state: 'outside-factory' }, undefined)).toBe(
      'acme/widgets#7 isn’t in one of this Factory’s repos (acme/widgets, acme/gadgets). Leave it for another Factory.',
    )
    expect(refusal(found({ state: 'closed' }), undefined)).toContain('is closed on GitHub')
    expect(refusal(found({ labels: ['bug'] }), label)).toBe(
      'acme/widgets#7 doesn’t have the label "ready for Ted", which this Factory’s GitHub intake requires. Leave it until a maintainer adds the label.',
    )
    expect(refusal(found({ labels: ['bug'], allLabels: false }), label)).toContain(
      'couldn’t read all of acme/widgets#7’s labels',
    )
  })

  test('an issue Ted can’t read is refused', () => {
    expect(refusal({ state: 'unreadable', reason: 'signed-out' }, undefined)).toContain(
      'the GitHub CLI isn’t signed in',
    )
    expect(refusal(undefined, undefined)).toBe(
      'Ted can’t read GitHub here, so it can’t check acme/widgets#7 against this Factory’s GitHub intake. Leave it.',
    )
  })

  test('a sub-issue is refused only while its parent issue is tracked in the Factory', () => {
    expect(refusal(found({ parent }), undefined)).toBeUndefined()
    expect(refusal(found({ parent }), undefined, tracked)).toBe(
      'acme/widgets#7 is a sub-issue of acme/widgets#3, which this Factory already tracks as NB-4. Leave it; that Task covers it.',
    )
  })

  test('the parent check made again before the commit gives the same reason', () => {
    const intake = githubIntake()
    expect(() => intake.refuseTrackedParent(parent, undefined)).not.toThrow()
    expect(() => intake.refuseTrackedParent(parent, tracked)).toThrow(
      refusal(found({ parent }), undefined, tracked),
    )
  })

  test('a change to the setting between the read and the commit is refused', () => {
    const store = settingsStore({ githubIntakeScopes: { f: { label: 'ready' } } })
    const intake = automationIntake({
      store,
      linear: undefined,
      factoryId: 'f',
      sourceUrl: issueUrl,
    })
    expect(intake.github?.scope).toEqual({ label: 'ready' })
    store.set({ githubIntakeScopes: { f: { label: 'ready' } } })
    expect(() => intake.unchanged()).not.toThrow()
    store.set({ githubIntakeScopes: {} })
    expect(() => intake.unchanged()).toThrow(
      'The Factory’s GitHub intake setting changed. Try creating the Task again.',
    )
  })

  test('--start and a Follow-up of a GitHub issue are refused', () => {
    const store = settingsStore()
    expect(() =>
      automationIntake({
        store,
        linear: undefined,
        factoryId: 'f',
        sourceUrl: issueUrl,
        start: true,
      }),
    ).toThrow(
      'Tasks an Automation creates from GitHub issues wait in Backlog for the human. Leave out --start.',
    )
    expect(() =>
      automationIntake({
        store,
        linear: undefined,
        factoryId: 'f',
        sourceUrl: undefined,
        followUpSourceUrl: issueUrl,
      }),
    ).toThrow(
      'An Automation can’t make a Follow-up of a GitHub issue, because a Follow-up starts on its own. Leave it for the existing Task.',
    )
    expect(
      automationIntake({
        store,
        linear: undefined,
        factoryId: 'f',
        sourceUrl: 'https://linear.app/acme/issue/NB-1',
        start: true,
      }).github,
    ).toBeUndefined()
  })

  test('only a Task an Automation made from a GitHub issue is kept from starting on its own', () => {
    const github = { url: issueUrl }
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
})

describe('Asana', () => {
  const factory = { id: 'f', name: 'Notebook' }
  const scope: AsanaIntakeScope = {
    workspace: { gid: '1', name: 'Acme' },
    project: { gid: '2', name: 'Inbox' },
  }
  const item = { gid: '10', name: 'Fix login', url: 'https://app.asana.com/0/0/10' }

  test('an item in scope with nothing tracked above it passes', () => {
    const store = settingsStore({ asanaIntakeScopes: { f: scope } })
    const hold = asanaIntakeHold(store, factory, () => false)
    expect(hold.scope).toEqual(scope)
    expect(() => hold.unchanged()).not.toThrow()
    expect(() =>
      refuseAsanaRoot({ ...item, kind: 'root', ancestors: ['9'] }, factory, () => undefined),
    ).not.toThrow()
  })

  test('a Factory without an Asana intake project is refused', () => {
    expect(() => asanaIntakeHold(settingsStore(), factory, () => false)).toThrow(
      'An Automation imports Asana work only from Notebook’s Asana intake project. Choose one in Configuration first.',
    )
  })

  test('an item outside the scope, unreadable, or under a tracked item is refused', () => {
    const outside: RootCheck = { ...item, kind: 'outside', reason: 'it isn’t assigned to you' }
    expect(() => refuseAsanaRoot(outside, factory, () => undefined)).toThrow(
      'Fix login isn’t work Notebook’s Asana intake takes: it isn’t assigned to you.',
    )
    const unreadable: RootCheck = { ...item, kind: 'unreadable', reason: 'Asana didn’t answer' }
    expect(() => refuseAsanaRoot(unreadable, factory, () => undefined)).toThrow(
      'Fix login isn’t work Notebook’s Asana intake takes: Asana didn’t answer.',
    )
    expect(() =>
      refuseAsanaRoot({ ...item, kind: 'root', ancestors: ['8', '9'] }, factory, (gid) =>
        gid === '9' ? tracked : undefined,
      ),
    ).toThrow(
      'Fix login sits under NB-4, which Ted already tracks. Add it to that tree from the app instead.',
    )
  })

  test('a scope change or the Factory’s removal during the import stops it', () => {
    const store = settingsStore({ asanaIntakeScopes: { f: scope } })
    let gone = false
    const hold = asanaIntakeHold(store, factory, () => gone)
    gone = true
    expect(() => hold.unchanged()).toThrow('Notebook is being removed')
    gone = false
    store.set({ asanaIntakeScopes: { f: { ...scope, project: { gid: '3', name: 'Other' } } } })
    expect(() => hold.unchanged()).toThrow(
      'Notebook’s Asana intake choice changed during the import. Ted stopped; the next run uses the new choice.',
    )
  })

  test('a Follow-up of Asana work is refused', () => {
    expect(() =>
      automationIntake({
        store: settingsStore(),
        linear: undefined,
        factoryId: 'f',
        sourceUrl: undefined,
        followUpSourceUrl: 'https://app.asana.com/0/0/10',
      }),
    ).toThrow(
      'An Automation can’t make a Follow-up of Asana work. Ted imports each Asana task once; leave it for the existing Task.',
    )
  })
})

test('the prompt’s intake lines follow each Factory’s Linear and GitHub settings', () => {
  const store = settingsStore({
    linearIntakeScopes: {
      f: { kind: 'team', id: 't1', name: 'Widgets', workspace: 'acme', workspaceId: 'w1' },
    },
    githubIntakeScopes: { f: { label: 'ready' } },
  })
  const [linear, github] = intakeLines(store, 'f')
  expect(linear).toContain('Linear intake scope: team "Widgets" (ID t1), workspace acme (ID w1).')
  expect(github).toContain('GitHub intake: only issues with the label "ready".')
  expect(intakeLines(store, 'other')).toEqual([
    'Linear intake scope: Unscoped. Your instructions may search all Linear teams and projects.',
    'GitHub intake: any open issue in this Factory’s repos. Ted refuses an issue that is closed, outside this Factory’s repos, or a sub-issue of an issue this Factory already tracks.',
  ])
})

describe('bulk GitHub intake', () => {
  const factory = { id: 'factory', name: 'Notebook' }
  const issue = (number: number, parent?: number) => ({
    url: `https://github.com/acme/notebook/issues/${number}`,
    ...(parent !== undefined && {
      parent: { url: `https://github.com/acme/notebook/issues/${parent}` },
    }),
  })

  test('without a label the bulk import is refused, and a changed label stops it', () => {
    expect(() => githubIntakeHold(settingsStore(), factory, () => false)).toThrow(
      'Choose a label in Notebook’s Configuration → GitHub intake first.',
    )
    const store = settingsStore({ githubIntakeScopes: { factory: { label: 'ready' } } })
    const hold = githubIntakeHold(store, factory, () => false)
    expect(hold.scope).toEqual({ label: 'ready' })
    expect(() => hold.unchanged()).not.toThrow()
    store.set({ githubIntakeScopes: { factory: { label: 'later' } } })
    expect(() => hold.unchanged()).toThrow('GitHub intake label changed during the import')
  })

  test('tracked issues, sub-issues of tracked issues and sub-issues of listed issues are left out', () => {
    const trackedUrls = new Set([issue(1).url, issue(2).url])
    const plan = planGitHubIntake(
      [issue(1), issue(3, 2), issue(4), issue(5, 4), issue(6, 9), issue(4)],
      (url) => trackedUrls.has(url),
    )
    expect(plan.tracked).toBe(2)
    expect(plan.candidates.map((i) => i.url)).toEqual([issue(4).url, issue(6).url])
  })
})
