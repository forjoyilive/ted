import type {
  FactorySettingsView,
  PullRequestCiFound,
  RepoSettingsInput,
} from '@ted/protocol/factory-settings'
import { describe, expect, test } from 'vitest'
import {
  changeCount,
  driftLine,
  editedFields,
  instructionRunText,
  lastRunText,
  lastValidLine,
  missingCopies,
  remoteFor,
  settingsAccessChanges,
  settingsChanges,
  settingsDraft,
  stageEdited,
  unsavedChanges,
  unsavedLine,
  unsavedSections,
  unsavedSummary,
} from '../src/renderer/factory-settings.ts'
import { markdownBlocks, markdownSpans } from '../src/renderer/markdown.ts'
import { ciFoundText } from '../src/renderer/pull-request-ci.ts'

const app: RepoSettingsInput = {
  was: 'app',
  repo: 'kriya/app',
  name: 'app',
  setup: { run: 'npm ci' },
  env: [{ name: 'EXPO_NO_TELEMETRY', value: '1' }],
  copy: ['.env'],
  apps: [],
}
const api: RepoSettingsInput = {
  was: 'api',
  repo: 'kriya/api',
  remote: 'git@github.com:kriya/api.git',
  name: 'api',
  env: [],
  copy: [],
  apps: [],
}
const loaded = [app, api]

describe('Factory settings save bar', () => {
  test('counts each edited field, as the save bar and Edited chips show', () => {
    const draft = [
      { ...app, mergeMethod: 'rebase' as const, env: [...app.env, { name: 'A', value: '1' }] },
      { ...api, copy: ['.env', 'config/master.key'] },
    ]
    expect([...editedFields(draft[0] as RepoSettingsInput, loaded)]).toEqual(['mergeMethod', 'env'])
    expect(changeCount(draft, loaded)).toBe(3)
    expect(unsavedLine(3)).toBe('3 unsaved changes to .ted/workflow.yaml')
    expect(unsavedLine(1)).toBe('1 unsaved change to .ted/workflow.yaml')
  })

  test('choosing the default merge method or a blank row is no change', () => {
    const draft = [
      { ...app, mergeMethod: 'squash' as const, env: [...app.env, { name: '', value: '' }] },
      api,
    ]
    expect(changeCount(draft, loaded)).toBe(0)
  })

  test('a new repo and a reorder each count once', () => {
    const added: RepoSettingsInput = { repo: 'kriya/web', name: 'web', env: [], copy: [], apps: [] }
    expect(changeCount([app, api, added], loaded)).toBe(1)
    const web = { ...added, was: 'web' }
    expect(changeCount([app, web, api], [app, api, web])).toBe(1)
  })

  test('a new repo keeps the remote form it was given', () => {
    expect(remoteFor('kriya/web', 'git@github.com:kriya/web.git')).toBe(
      'git@github.com:kriya/web.git',
    )
    expect(remoteFor('kriya/web', 'kriya/web')).toBe('https://github.com/kriya/web.git')
  })

  test('a missing local folder names the files that won’t be copied', () => {
    expect(missingCopies(['.env', 'config/master.key'])).toBe(
      '.env and config/master.key won’t be copied into new worktrees until you locate it.',
    )
  })
})

const view: FactorySettingsView = {
  agentFiles: [],
  factoryId: 'f1',
  repo: 'kriya/app',
  defaultBranch: 'main',
  source: 'file',
  version: 'v1',
  repos: [{ ...app, was: 'app', primary: true }],
  problems: [],
  github: { ready: true },
  stages: [
    { id: 'backlog', name: 'Backlog', inOrder: true, enabled: true, gate: false, from: 'ted' },
    {
      id: 'design',
      name: 'Design',
      inOrder: true,
      enabled: true,
      gate: true,
      maxBack: 3,
      from: 'ted',
    },
    {
      id: 'review',
      name: 'Review',
      inOrder: true,
      enabled: true,
      gate: true,
      maxBack: 3,
      from: 'ted',
      inherited: { layer: 'ted', text: '# Review\n' },
    },
  ],
  ignoredStageFiles: [],
  checks: [{ was: 0, name: 'Typecheck', run: 'npm run typecheck' }],
  instructionChecks: [],
  cleanup: { enabled: false, steps: [] },
  tries: [],
  agents: [
    { role: 'lead', inherited: { agent: 'claude' }, inheritedFrom: 'ted', from: 'ted' },
    {
      role: 'reviewer',
      own: { agent: 'codex' },
      inherited: { agent: 'claude' },
      inheritedFrom: 'ted',
      from: 'factory',
    },
    { role: 'planner', inherited: { agent: 'claude' }, inheritedFrom: 'ted', from: 'ted' },
  ],
  permissions: 'auto',
  machineMaxWorkingRuns: 6,
  sandboxSockets: [],
  electronApps: [],
  notes: '',
}

describe('Factory settings draft', () => {
  test('an untouched draft has nothing to save', () => {
    const loaded = settingsDraft(view)
    expect(unsavedChanges(settingsDraft(view), loaded)).toEqual({ count: 0, files: [] })
    expect(settingsChanges(settingsDraft(view), loaded)).toEqual({ repos: loaded.repos })
  })

  test('turning the Design Gate off, adding a Check and overriding review.md count per file', () => {
    const loaded = settingsDraft(view)
    const draft = settingsDraft(view)
    draft.stages.design = { enabled: true, gate: false, maxBack: 3 }
    draft.checks.push({ name: 'Unit tests', run: 'npm test' })
    draft.stageFiles.review = '# Review\n'
    const changes = settingsChanges(draft, loaded)
    expect(changes.stages).toEqual({ design: { gate: false } })
    expect(changes.checks).toHaveLength(2)
    expect(changes.stageFiles).toEqual({ review: '# Review\n' })
    const unsaved = unsavedChanges(draft, loaded)
    expect(unsaved).toEqual({ count: 3, files: ['.ted/workflow.yaml', '.ted/stages/review.md'] })
    expect(unsavedSummary(unsaved)).toBe('3 unsaved changes to 2 files in .ted/')
    expect([...unsavedSections(draft, loaded)]).toEqual(['workflow', 'checks'])
    expect([...unsavedSections(settingsDraft(view), loaded)]).toEqual([])
    expect([...stageEdited(draft, loaded, 'review')]).toEqual(['file'])
  })

  test('editing an instruction Check sends only the instruction Checks, keeping each was', () => {
    const withInstruction: FactorySettingsView = {
      ...view,
      instructionChecks: [{ was: 1, name: 'Docs drift', instruction: 'Fix stale docs.' }],
    }
    const loaded = settingsDraft(withInstruction)
    const draft = settingsDraft(withInstruction)
    expect(settingsChanges(draft, loaded).instructionChecks).toBeUndefined()
    const docs = { was: 1, name: 'Docs drift', instruction: 'Fix stale docs.' }
    draft.instructionChecks = [
      { ...docs, fix: true, effort: 'high' },
      { name: 'Copy', instruction: 'Check the UI text.' },
    ]
    const changes = settingsChanges(draft, loaded)
    expect(changes.checks).toBeUndefined()
    expect(changes.instructionChecks).toEqual([
      { was: 1, name: 'Docs drift', instruction: 'Fix stale docs.', fix: true, effort: 'high' },
      { name: 'Copy', instruction: 'Check the UI text.' },
    ])
    expect(unsavedChanges(draft, loaded)).toEqual({ count: 2, files: ['.ted/workflow.yaml'] })
    expect([...unsavedSections(draft, loaded)]).toEqual(['checks'])
    draft.instructionChecks = [{ ...docs, fix: false }]
    expect(settingsChanges(draft, loaded).instructionChecks).toBeUndefined()
  })

  test('turning Cleanup on with two steps sends cleanup and counts each edit in workflow.yaml', () => {
    const loaded = settingsDraft(view)
    const draft = settingsDraft(view)
    draft.cleanup = {
      enabled: true,
      steps: [
        {
          name: ' Tell Asana ',
          kind: 'instruction',
          instruction: 'Comment.',
          command: 'x',
          timeout: '',
        },
        {
          name: 'Stop stack',
          kind: 'command',
          instruction: 'kept',
          command: 'make down',
          timeout: '2m',
        },
      ],
    }
    expect(settingsChanges(draft, loaded).cleanup).toEqual({
      enabled: true,
      steps: [
        { name: 'Tell Asana', instruction: 'Comment.' },
        { name: 'Stop stack', command: 'make down', timeout: '2m' },
      ],
    })
    expect(unsavedChanges(draft, loaded)).toEqual({ count: 3, files: ['.ted/workflow.yaml'] })
    expect([...unsavedSections(draft, loaded)]).toEqual(['cleanup'])
    draft.cleanup = { enabled: false, steps: [] }
    expect(settingsChanges(draft, loaded).cleanup).toBeUndefined()
  })

  test('Keep mine sends keepStageFiles and counts as a workflow.yaml change', () => {
    const loaded = settingsDraft(view)
    const draft = settingsDraft(view)
    draft.keepStageFiles = ['review']
    expect(settingsChanges(draft, loaded).keepStageFiles).toEqual(['review'])
    expect(unsavedChanges(draft, loaded)).toEqual({ count: 1, files: ['.ted/workflow.yaml'] })
    expect([...unsavedSections(draft, loaded)]).toEqual(['workflow'])
    expect([...stageEdited(draft, loaded, 'review')]).toEqual(['kept'])
  })

  test('the drift line names what changed and what the copy is based on', () => {
    const drift = {
      basedOn: '9a01b7d',
      current: '3c4d5e6',
      diffOf: 'inherited' as const,
      diff: [],
    }
    expect(driftLine('review', { ...drift, layer: 'ted', changedIn: '1.4.0' }, 'Inherited')).toBe(
      'Inherited version changed. Ted’s default review.md changed in Ted 1.4.0. Your copy is based on 9a01b7d.',
    )
    expect(driftLine('review', { ...drift, layer: 'library' }, 'Inherited')).toBe(
      'Inherited version changed. Your Library’s review.md changed. Your copy is based on 9a01b7d.',
    )
    expect(driftLine('design', { ...drift, layer: 'ted' }, 'Default')).toBe(
      'Default version changed. Ted’s default design.md changed. Your copy is based on 9a01b7d.',
    )
  })

  test('notes alone name .ted/notes.md, and resetting an agent sends null', () => {
    const loaded = settingsDraft(view)
    const draft = settingsDraft(view)
    draft.notes = '# Notebook\n'
    draft.agents.reviewer = null
    draft.maxWorkingRuns = '3'
    const changes = settingsChanges(draft, loaded)
    expect(changes.agents).toEqual({ reviewer: null })
    expect(changes.maxWorkingRuns).toBe(3)
    expect(changes.notes).toBe('# Notebook\n')
    draft.repos = draft.repos.slice(0, -1)
    expect([...unsavedSections(draft, loaded)]).toEqual(['repos', 'agents', 'permissions', 'notes'])
    const notesOnly = settingsDraft(view)
    notesOnly.notes = 'x'
    expect(unsavedSummary(unsavedChanges(notesOnly, loaded))).toBe(
      '1 unsaved change to .ted/notes.md',
    )
  })

  test('a Check’s last run reads like the Checks table', () => {
    const now = Date.parse('2026-11-09T12:00:00Z')
    const base = { factoryId: 'f1', name: 'Tests', repo: 'app', startedAt: '2026-11-09T10:00:00Z' }
    expect(
      lastRunText(
        { ...base, state: 'passed', durationMs: 38_000, finishedAt: '2026-11-09T10:00:38Z' },
        now,
      ),
    ).toBe('✓ 38s · 1h 59m ago')
    expect(
      lastRunText(
        { ...base, state: 'failed', exitCode: 1, finishedAt: '2026-11-09T11:00:00Z' },
        now,
      ),
    ).toBe('✗ Exit 1 · 1h ago')
    expect(lastRunText({ ...base, state: 'running', startedAt: '2026-11-09T11:58:56Z' }, now)).toBe(
      'Running · 1m 04s',
    )
    expect(lastRunText({ ...base, state: 'running', waiting: true }, now)).toBe(
      'Waiting for other checks to finish',
    )
    expect(lastRunText({ ...base, state: 'failed', exitCode: 1, setupFailed: true }, now)).toBe(
      '✗ Setup failed · 2h ago',
    )
    const tried = { ...base, instruction: true as const, taskDisplayId: 'NB-2' }
    expect(
      instructionRunText({ ...tried, state: 'running', startedAt: '2026-11-09T11:59:30Z' }, now),
    ).toBe('Running on NB-2 · 30s')
    expect(
      instructionRunText({ ...tried, state: 'passed', finishedAt: '2026-11-09T11:00:00Z' }, now),
    ).toBe('✓ Passed on NB-2 · 1h ago')
    expect(instructionRunText({ ...tried, state: 'failed', noReport: 'no result line' }, now)).toBe(
      '✗ No report on NB-2 · 2h ago',
    )
  })

  test('the invalid-file notice says which version Ted is using', () => {
    expect(
      lastValidLine(
        {
          file: '.ted/workflow.yaml',
          line: 12,
          column: 18,
          message: 'x',
          url: 'https://github.com/kriya/app/blob/main/.ted/workflow.yaml#L12',
          lastValid: { version: '3f9c2e1', at: '2026-11-07T11:00:00Z' },
        },
        Date.parse('2026-11-09T12:00:00Z'),
      ),
    ).toBe(
      'Ted is using the last valid version, from 3f9c2e1, 2d ago. This panel shows that version. Saving from here replaces the broken file, and the Save diff shows it.',
    )
  })
})

describe('Factory notes preview', () => {
  test('reads headings, lists, paragraphs and code', () => {
    expect(
      markdownBlocks('# Notebook\n\n## Repos\n- app: Expo\n- api: Rails\n\nRun `npm ci` first.\n'),
    ).toEqual([
      { kind: 'heading', level: 1, text: 'Notebook' },
      { kind: 'heading', level: 2, text: 'Repos' },
      { kind: 'list', ordered: false, items: ['app: Expo', 'api: Rails'] },
      { kind: 'paragraph', text: 'Run `npm ci` first.' },
    ])
    expect(markdownSpans('Run `npm ci` **first**.')).toEqual([
      { kind: 'text', text: 'Run ' },
      { kind: 'code', text: 'npm ci' },
      { kind: 'text', text: ' ' },
      { kind: 'strong', text: 'first' },
      { kind: 'text', text: '.' },
    ])
  })
})

describe('Pull request CI row', () => {
  const when = () => '2h ago'
  const found = (signals: PullRequestCiFound['signals']): PullRequestCiFound => ({
    signals,
    task: 'NB-4',
    at: '2026-11-16T10:00:00.000Z',
  })

  test('says what Ted found and when, and whether the setting overrides it', () => {
    expect(ciFoundText(undefined, 'auto', when)).toBe(
      'Not checked yet. Ted checks when a Task first pushes to this repo.',
    )
    expect(ciFoundText(found([]), 'auto', when)).toBe(
      'None found when NB-4 pushed, 2h ago. Ted doesn’t wait for CI on this repo’s pull requests.',
    )
    expect(ciFoundText(found(['recent-pull-requests']), 'none', when)).toBe(
      'Found when NB-4 pushed, 2h ago: recent pull requests had checks. This setting overrides it.',
    )
    expect(ciFoundText(found(['required-checks']), 'none', when)).toContain(
      'Ted still waits for the required check',
    )
  })

  test('changing it counts as an edit, and Detect is the same as no value', () => {
    const before: RepoSettingsInput = {
      repo: 'acme/app',
      name: 'app',
      was: 'app',
      env: [],
      copy: [],
      apps: [],
    }
    expect([...editedFields({ ...before, pullRequestCi: 'auto' }, [before])]).toEqual([])
    expect([...editedFields({ ...before, pullRequestCi: 'none' }, [before])]).toEqual([
      'pullRequestCi',
    ])
  })
})

describe('Sandbox access changes before a save', () => {
  test('two Apps with the same name are each compared with their own saved entry', () => {
    const repo = {
      was: 'mobile',
      repo: 'kriya/mobile',
      name: 'mobile',
      primary: true,
      env: [],
      copy: [],
      apps: [
        { was: 0, name: 'Sim', kind: 'command' as const, run: 'a' },
        {
          was: 1,
          name: 'Sim',
          kind: 'command' as const,
          run: 'b',
          sandboxAccess: ['ios-xcode' as const],
        },
      ],
    }
    const changes = {
      repos: [
        {
          ...repo,
          apps: [
            { was: 1, name: 'Sim', kind: 'command' as const, run: 'b', sandboxAccess: [] },
            {
              was: 0,
              name: 'Sim',
              kind: 'command' as const,
              run: 'a',
              sandboxAccess: ['ios-xcode' as const],
            },
            { name: 'Sim', kind: 'command' as const, run: 'c' },
          ],
        },
      ],
    }
    expect(settingsAccessChanges({ repos: [repo], checks: [] }, changes)).toEqual([
      { kind: 'app', repo: 'mobile', name: 'Sim', gained: [], lost: ['ios-xcode'] },
      { kind: 'app', repo: 'mobile', name: 'Sim', gained: ['ios-xcode'], lost: [] },
    ])
  })
})
