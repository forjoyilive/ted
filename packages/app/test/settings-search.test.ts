import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import {
  findSettings,
  matchedParts,
  platformOf,
  searchFactory,
  settingIds,
} from '../src/renderer/settings-search.ts'

const widgets = { id: 'f1', name: 'widgets' }
const find = (query: string, options: Partial<Parameters<typeof findSettings>[1]> = {}) =>
  findSettings(query, { factory: widgets, platform: 'mac', limit: 50, ...options })

test('a setting is found by its name, group, page and description, with its page', () => {
  expect(find('awake')[0]).toEqual({
    id: 'app.general.startup.stay-awake',
    name: 'Stay Awake while Runs are working',
    where: 'Settings › General',
    target: { kind: 'app', section: 'general' },
  })
  expect(find('sleep').map((hit) => hit.id)).toEqual(['app.general.startup.stay-awake'])
  expect(find('startup').map((hit) => hit.id)).toEqual([
    'app.general.startup',
    'app.general.startup.login',
    'app.general.startup.quit',
    'app.general.startup.stay-awake',
  ])
  expect(find('notifications inbox')).toMatchObject([
    { name: 'Inbox items', where: 'Settings › Notifications' },
    { name: 'By Factory', where: 'Settings › Notifications' },
    { name: 'Notifications', where: 'widgets › Settings' },
  ])
  expect(find('linear api key')[0]).toMatchObject({
    id: 'app.integrations.linear.key',
    where: 'Settings › Integrations',
  })
  expect(find('devtools').map((hit) => hit.id)).toEqual(['app.developer.profile'])
  expect(find('diagnostics')[0]?.id).toBe('app.developer.diagnostics')
  expect(find('export format').map((hit) => hit.id)).toEqual(['app.storage.export.format'])
  expect(find('custom command')[0]?.id).toBe('app.general.editor.custom-command')
  expect(find('STAY  awake')).toHaveLength(1)
  expect(find('   ')).toEqual([])
  expect(find('zzz')).toEqual([])
})

test('a name match comes first, a setting before a heading with the same words', () => {
  expect(find('autopilot').map((hit) => hit.name)).toEqual([
    'Autopilot across all Factories',
    'Autopilot',
  ])
  expect(find('overnight').map((hit) => hit.name)).toEqual([
    'Autopilot across all Factories',
    'Autopilot',
  ])
  expect(find('linear').map((hit) => hit.id)).toEqual([
    'app.integrations.linear.sync',
    'app.integrations.linear',
    'factory.linear-intake',
    'app.integrations.linear.key',
    'factory.linear-intake.scope',
  ])
  expect(find('run', { limit: 3 })).toHaveLength(3)
})

test('Factory settings carry the Factory’s name and are left out without a Factory', () => {
  expect(find('teardown')[0]).toEqual({
    id: 'factory.repos.worktree.teardown',
    name: 'Teardown command',
    where: 'widgets › Settings › Repos',
    target: { kind: 'factory', factoryId: 'f1' },
  })
  expect(find('danger')[0]).toMatchObject({ name: 'Danger zone', where: 'widgets › Settings' })
  expect(find('working run limit')[0]).toMatchObject({
    id: 'factory.permissions.working-run-limit',
    where: 'widgets › Settings › Permissions',
  })
  expect(find('bypass').map((hit) => hit.id)).toEqual(['factory.permissions'])
  expect(find('deletes its tasks').map((hit) => hit.id)).toEqual(['factory.danger-zone.remove'])
  expect(find('fewer rounds').map((hit) => hit.id)).toEqual(['factory.workflow.p1-only'])
  expect(find('only you can accept').map((hit) => hit.id)).toEqual([
    'factory.workflow.lead-closes-failures',
  ])
  expect(find('newest five').map((hit) => hit.id)).toEqual(['app.developer.profile'])
  expect(find('local/bin')[0]?.id).toBe('app.general.editor.path')
  expect(find('teardown', { factory: undefined }).map((hit) => hit.id)).toEqual([
    'app.limits.low-priority',
  ])
  expect(find('danger', { factory: undefined })).toEqual([])
})

test('a setting that shows on one platform is found only there', () => {
  expect(find('tray', { platform: 'linux' }).map((hit) => hit.name)).toEqual(['Show tray icon'])
  expect(find('tray', { platform: 'mac' })).toEqual([])
  expect(find('simulators booted', { platform: 'mac' })).toHaveLength(1)
  expect(find('simulators booted', { platform: 'linux' })).toEqual([])
  expect(platformOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('mac')
  expect(platformOf('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux')
  expect(platformOf('Mozilla/5.0 (Windows NT 10.0)')).toBe('other')
})

test('the matched letters of a name are marked', () => {
  expect(matchedParts('Stay Awake', 'awa st')).toEqual([
    { text: 'St', matched: true },
    { text: 'ay ', matched: false },
    { text: 'Awa', matched: true },
    { text: 'ke', matched: false },
  ])
  expect(matchedParts('Sound', 'general')).toEqual([{ text: 'Sound', matched: false }])
})

test('the search uses the current Factory, or the first when none is current', () => {
  const factories = [{ id: 'f1' }, { id: 'f2' }]
  expect(searchFactory(factories, 'f2')).toEqual({ id: 'f2' })
  expect(searchFactory(factories, undefined)).toEqual({ id: 'f1' })
  expect(searchFactory([], 'f2')).toBeUndefined()
})

test('every setting in the list is on a row or heading in the renderer', async () => {
  const rendererDir = fileURLToPath(new URL('../src/renderer', import.meta.url))
  const entries = await readdir(rendererDir, { recursive: true, withFileTypes: true })
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.tsx'))
    .map((e) => path.join(e.parentPath, e.name))
  const text = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n')

  expect(settingIds.filter((id) => !text.includes(`"${id}"`) && !text.includes(`'${id}'`))).toEqual(
    [],
  )
})
