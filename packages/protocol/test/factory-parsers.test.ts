import { expect, test } from 'vitest'
import * as P from '../src/index.ts'
import { rejects, roundTrip, variant } from './parser-cases.ts'

const repos = [
  {
    was: 'owner/ted',
    repo: 'owner/ted',
    remote: 'https://github.com/owner/ted.git',
    name: 'ted',
    baseBranch: 'main',
    mergeMethod: 'merge',
    setup: { run: 'pnpm install', timeout: '1m' },
    teardown: { run: 'cleanup', timeout: '1m' },
    env: [{ name: 'KEY', value: 'value' }],
    copy: ['.env'],
    apps: [
      { was: 0, name: 'Dev', kind: 'web', run: 'pnpm dev', url: 'http://localhost:3000' },
      { name: 'Phone', kind: 'android-emulator', run: './gradlew installDebug', device: 'Pixel_8' },
    ],
  },
] satisfies P.RepoSettingsInput[]
const library = {
  stages: {
    work: {
      enabled: true,
      gate: false,
      maxBack: 2,
      depth: 'few',
      effort: 'high',
      leadClosesFailures: true,
    },
    validate: { p1OnlyFrom: 3, subAgents: true },
    merge: { commitTitles: false },
  },
  stageFiles: { work: '# Work', review: null },
  keepStageFiles: ['work'],
  agents: { lead: { agent: 'codex', model: 'gpt-5.5', effort: 'high' }, reviewer: null },
} satisfies Required<P.LibraryChanges>
const settings = {
  ...library,
  repos,
  checks: [{ was: 0, name: 'Check', run: 'pnpm typecheck', repo: 'ted', timeout: '30s' }],
  cleanup: {
    enabled: true,
    steps: [
      { name: 'Tell Asana', instruction: 'Comment on the Asana task.' },
      { name: 'Stop stack', command: 'docker compose down', timeout: '2m' },
      { name: 'Prune', command: 'pnpm prune' },
    ],
  },
  permissions: 'auto',
  maxWorkingRuns: 2,
  notes: '# Notes',
} satisfies Required<P.FactorySettingsChanges>
roundTrip(P.parseMergeSettingsRequest, { receipt: 'a'.repeat(32) })
rejects(P.parseMergeSettingsRequest, { receipt: '../bad' }, 'receipt must be')
roundTrip(P.parseAutoStartBacklogRequest, { enabled: true })
roundTrip(P.parseCreateFactoryRequest, {
  name: 'TED',
  key: 'TED',
  repos: [
    { name: 'ted', source: { remote: 'https://github.com/owner/ted' } },
    { name: 'local', source: { folder: '/tmp/local' } },
  ],
})
roundTrip(P.parseReorderFactoriesRequest, { factoryIds: ['one', 'two'] })
roundTrip(P.parseFactoryLayout, {
  items: [
    { factoryId: 'one' },
    { group: { id: 'acme-1', name: 'Acme', factoryIds: ['two', 'three'] } },
    { group: { id: 'empty', name: 'Personal', factoryIds: [] } },
  ],
})
roundTrip(P.parseRemoveFactoryRequest, { key: 'TED', closePullRequests: true })
roundTrip(P.parseCheckRepoRequest, {
  source: { remote: 'https://github.com/owner/ted' },
  primary: true,
})
roundTrip(P.parseCheckRepoRequest, { source: { folder: '/tmp/local' }, primary: false })
roundTrip(P.parseSetLocalFolderRequest, { path: '/tmp/local' })
roundTrip(P.parseGitHubSetupPlanRequest, { folder: '/tmp/local' })
roundTrip(P.parseGitHubNameRequest, { owner: 'acme', name: 'ted_and.bill-2' })
roundTrip(
  P.parseGitHubSetupStepRequest,
  {
    folder: '/tmp/local',
    step: 'commit',
    owner: 'acme',
    name: 'notes',
    description: ' Notes\tand more ',
    branch: 'release/v1',
    leaveOut: ['node_modules/', '/.env'],
  },
  {
    folder: '/tmp/local',
    step: 'commit',
    owner: 'acme',
    name: 'notes',
    description: 'Notes and more',
    branch: 'release/v1',
    leaveOut: ['node_modules/', '/.env'],
  },
)
rejects(P.parseGitHubSetupPlanRequest, { folder: 'relative' }, 'folder must be an absolute path')
rejects(P.parseGitHubNameRequest, { owner: '-bad', name: 'x' }, 'owner must be')
rejects(P.parseGitHubNameRequest, { owner: 'acme', name: '..' }, 'name:')
rejects(
  P.parseGitHubSetupStepRequest,
  { folder: '/tmp', step: 'delete', owner: 'acme', name: 'x', branch: 'main' },
  'step must be one of',
)
rejects(
  P.parseGitHubSetupStepRequest,
  { folder: '/tmp', step: 'push', owner: 'acme', name: 'x', branch: '-f' },
  'branch:',
)
rejects(
  P.parseGitHubSetupStepRequest,
  { folder: '/tmp', step: 'ignore', owner: 'acme', name: 'x', branch: 'main', leaveOut: ['a\nb'] },
  'leaveOut must be',
)
roundTrip(P.parseSetRepoFolderRequest, { path: '/tmp/local' })
roundTrip(P.parseStopCheckTryRequest, { name: 'Check' })
roundTrip(P.parseAddFactoryRequest, { repo: 'owner/ted', key: 'TED', localFolder: '/tmp/local' })
roundTrip(P.parseCheckTryRequest, {
  name: 'Check',
  run: 'pnpm typecheck',
  repo: 'ted',
  timeout: '30s',
})
roundTrip(P.parseFactorySettingsChanges, settings)
roundTrip(P.parseSaveSettingsRequest, {
  changes: settings,
  mode: 'merge',
  version: 'rev',
  confirmBypass: true,
})
roundTrip(P.parseSaveSettingsRequest, {
  changes: settings,
  mode: 'pull-request',
  version: 'rev',
  confirmBypass: false,
})
roundTrip(P.parseRenameFactoryRequest, { name: 'New name' })
roundTrip(P.parseSetFactoryIconRequest, {
  icon: { kind: 'symbol', name: 'git-branch', color: 'teal' },
})
roundTrip(P.parseSetFactoryIconRequest, { icon: { kind: 'letter', color: 'orange' } })
roundTrip(P.parseSetFactoryIconRequest, { icon: { kind: 'emoji', emoji: '🐙' } })
roundTrip(P.parseSetFactoryIconRequest, {
  icon: {
    kind: 'image',
    dataUrl:
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  },
})
roundTrip(P.parseSetFactoryIconRequest, { icon: null })
roundTrip(P.parseLibraryChanges, library)
roundTrip(P.parseSaveLibraryRequest, { changes: library, version: 'rev' })

rejects(P.parseAutoStartBacklogRequest, { enabled: 1 }, 'enabled must be')
rejects(P.parseReorderFactoriesRequest, { factoryIds: 'one' }, 'factoryIds must be a list')
rejects(P.parseFactoryLayout, { items: 'one' }, 'items must be a list')
rejects(P.parseFactoryLayout, { items: [{ factoryId: 1 }] }, 'a Factory id must be text')
rejects(
  P.parseFactoryLayout,
  { items: [{ group: { id: 'a/b', name: 'Acme', factoryIds: [] } }] },
  'a group id must be',
)
rejects(
  P.parseFactoryLayout,
  { items: [{ group: { id: 'a', name: '  ', factoryIds: [] } }] },
  'name the group',
)
rejects(
  P.parseFactoryLayout,
  { items: [{ group: { id: 'a', name: 'x'.repeat(41), factoryIds: [] } }] },
  'at most 40 characters',
)
rejects(
  P.parseFactoryLayout,
  { items: [{ group: { id: 'a', name: 'Acme', factoryIds: 'one' } }] },
  'factoryIds must be a list',
)
rejects(P.parseRemoveFactoryRequest, {}, 'key must be text')
rejects(P.parseSetLocalFolderRequest, {}, 'path is required')
rejects(P.parseSetRepoFolderRequest, { path: '' }, 'path is required')
rejects(P.parseStopCheckTryRequest, { name: 1 }, 'name must be text')
rejects(P.parseAddFactoryRequest, {}, 'repo and key are required')
rejects(
  P.parseCheckTryRequest,
  { name: 'Check', run: 'command', timeout: '30' },
  'timeout must be a duration',
)
rejects(P.parseFactorySettingsChanges, { repos: [] }, 'a Factory has 1 to 10 repos')
rejects(
  P.parseFactorySettingsChanges,
  { ...settings, stages: { work: { gate: 'yes' } } },
  'gate must be true or false',
)
rejects(
  P.parseFactorySettingsChanges,
  {
    ...settings,
    cleanup: { enabled: true, steps: [{ name: 'Both', instruction: 'a', command: 'b' }] },
  },
  'an instruction or a command, not both',
)
rejects(
  P.parseFactorySettingsChanges,
  {
    ...settings,
    cleanup: { enabled: true, steps: [{ name: 'Say', instruction: 'a', timeout: '1m' }] },
  },
  'only a Cleanup step with a command takes a timeout',
)
rejects(
  P.parseFactorySettingsChanges,
  { ...settings, cleanup: { steps: [] } },
  'cleanup.enabled must be',
)
rejects(
  P.parseLibraryChanges,
  { stages: { validate: { p1OnlyFrom: 1 } } },
  'validate.p1OnlyFrom must be a round number, 2 or more, or false, on Validate',
)
rejects(
  P.parseLibraryChanges,
  { stages: { work: { p1OnlyFrom: 3 } } },
  'work.p1OnlyFrom must be a round number',
)
rejects(
  P.parseLibraryChanges,
  { stages: { validate: { subAgents: 'yes' } } },
  'validate.subAgents must be true or false, on Validate',
)
rejects(
  P.parseLibraryChanges,
  { stages: { work: { subAgents: true } } },
  'work.subAgents must be true or false, on Validate',
)
rejects(
  P.parseLibraryChanges,
  { stages: { validate: { leadClosesFailures: true } } },
  'validate.leadClosesFailures must be true or false, on Work',
)
rejects(
  P.parseLibraryChanges,
  { stages: { work: { commitTitles: true } } },
  'work.commitTitles must be true or false, on Merge',
)
rejects(
  P.parseSaveSettingsRequest,
  { mode: 'other', version: 'v', changes: settings },
  'mode must be',
)
rejects(P.parseRenameFactoryRequest, { name: 1 }, 'name is required')
rejects(P.parseSetFactoryIconRequest, {}, 'icon.kind must be')
rejects(
  P.parseSetFactoryIconRequest,
  { icon: { kind: 'symbol', name: 'skull', color: 'teal' } },
  'not a known icon',
)
rejects(
  P.parseSetFactoryIconRequest,
  { icon: { kind: 'letter', color: '#ff0000' } },
  'not a known colour',
)
rejects(
  P.parseSetFactoryIconRequest,
  { icon: { kind: 'emoji', emoji: '💩' } },
  'not one of the offered emoji',
)
rejects(
  P.parseSetFactoryIconRequest,
  { icon: { kind: 'image', dataUrl: `data:image/svg+xml;base64,${btoa('<svg/>')}` } },
  'must be a PNG data URL',
)
rejects(
  P.parseSetFactoryIconRequest,
  { icon: { kind: 'image', dataUrl: `data:image/png;base64,${btoa('GIF89a')}` } },
  'must be a PNG',
)
rejects(
  P.parseSetFactoryIconRequest,
  { icon: { kind: 'image', dataUrl: `data:image/png;base64,${'A'.repeat(50_000)}` } },
  'too large',
)
rejects(
  P.parseSetFactoryIconRequest,
  {
    icon: {
      kind: 'image',
      dataUrl: `data:image/png;base64,${btoa(`\x89PNG\r\n\x1a\n${'x'.repeat(32 * 1024 + 1 - 8)}`)}`,
    },
  },
  'too large',
)
rejects(P.parseLibraryChanges, { keepStageFiles: ['other'] }, 'unknown Stage')
rejects(P.parseSaveLibraryRequest, { changes: library }, 'version is required')

test('legacy Factory normalization and defaults', () => {
  expect(P.parseCreateFactoryRequest(null)).toEqual({
    name: '',
    key: '',
    repos: [],
  })
  expect(
    P.parseCreateFactoryRequest({ name: 'TED', key: 'TED', repos: [], showTutorial: true }),
  ).toEqual({ name: 'TED', key: 'TED', repos: [] })
  expect(P.parseCheckRepoRequest(null)).toEqual({ source: { remote: '' }, primary: false })
  expect(P.parseRemoveFactoryRequest({ key: 'TED' })).toEqual({
    key: 'TED',
    closePullRequests: true,
  })
  expect(P.parseLibraryChanges({ unknown: true })).toEqual({})
  expect(
    P.parseSaveSettingsRequest({ mode: 'merge', version: 'v', changes: settings }).confirmBypass,
  ).toBe(false)
})

test('a P1-only round of false is kept, so a layer can turn it off', () => {
  expect(P.parseLibraryChanges({ stages: { validate: { p1OnlyFrom: false } } })).toEqual({
    stages: { validate: { p1OnlyFrom: false } },
  })
})

test('Stage effort keeps null and rejects effort on a nonworking Stage', () => {
  expect(P.parseLibraryChanges({ stages: { work: { effort: null } } })).toEqual({
    stages: { work: { effort: null } },
  })
  expect(() => P.parseLibraryChanges({ stages: { backlog: { effort: 'high' } } })).toThrow(
    'effort must be an effort level or null on a working Stage',
  )
})

roundTrip(P.parseSetFactoryNotificationsRequest, { inboxItems: false, taskMerged: true })
variant(P.parseSetFactoryNotificationsRequest, { taskMerged: false })
rejects(P.parseSetFactoryNotificationsRequest, {}, 'give inboxItems or taskMerged')
rejects(
  P.parseSetFactoryNotificationsRequest,
  { inboxItems: 'no' },
  'inboxItems must be true or false',
)
rejects(
  P.parseSetFactoryNotificationsRequest,
  { taskMerged: 1 },
  'taskMerged must be true or false',
)
roundTrip(P.parseSetFactoryPermissionsRequest, { mode: 'bypass', confirmBypass: true })
roundTrip(P.parseSetFactoryPermissionsRequest, { mode: 'auto', confirmBypass: false })
test('permission confirmation is optional for Auto', () => {
  expect(P.parseSetFactoryPermissionsRequest({ mode: 'auto' })).toEqual({ mode: 'auto' })
})
rejects(P.parseSetFactoryPermissionsRequest, { mode: 'invalid' }, 'mode must be auto or bypass')
test('permission confirmation accepts only literal true', () => {
  expect(P.parseSetFactoryPermissionsRequest({ mode: 'bypass', confirmBypass: 'true' })).toEqual({
    mode: 'bypass',
    confirmBypass: false,
  })
})
