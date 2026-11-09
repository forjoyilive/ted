import type { RepoSettingsInput } from '@ted/protocol/factory-settings'
import { describe, expect, test } from 'vitest'
import {
  changeCount,
  editedFields,
  missingCopies,
  remoteFor,
  unsavedLine,
} from '../src/renderer/factory-settings.ts'

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
