import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { type DaemonClient, readDaemonInfo } from '@ted/protocol'
import { type ElectronApplication, _electron as electron, type Page } from 'playwright'
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { readStubKeyring, stubKeyringFile } from '../../daemon/test/fixtures/stub-keyring.ts'
import { type StubLinear, startStubLinear } from '../../daemon/test/fixtures/stub-linear.ts'
import {
  appClient,
  daemonAsApp,
  makeOriginRepo,
  removeHome,
  stopDaemonIn,
  waitUntil,
} from '../../daemon/test/helpers.ts'
import { buildRenderer } from './build-renderer.ts'
import { closeApp } from './close-app.ts'

const appDir = fileURLToPath(new URL('..', import.meta.url))
const _cliPath = fileURLToPath(new URL('../../cli/src/main.ts', import.meta.url))
const electronPath = createRequire(import.meta.url)('electron') as string
const _run = promisify(execFile)

const key = 'lin_api_abcdefghijklmnopqrstuvwxyz0123456789ABCD'
const issueUrl = 'https://linear.app/kriyadesign/issue/NOTE-212/search-ignores-accents'

let home: string
let linear: StubLinear
let app: ElectronApplication | undefined

beforeAll(async () => {
  await buildRenderer()
})

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'ted-app-linear-'))
  linear = await startStubLinear({
    [key]: {
      name: 'Nabha',
      workspace: { name: 'Kriya Design', urlKey: 'kriyadesign' },
      issues: [
        {
          identifier: 'NOTE-212',
          title: 'Search ignores accents',
          priority: 2,
          branchName: 'nabha/note-212-search-ignores-accents',
          description: 'Typing “cafe” should find “Café”.',
        },
      ],
    },
  })
})

afterEach(async () => {
  await closeApp(app)
  app = undefined
  await stopDaemonIn(home)
  await linear.close()
  await removeHome(home)
}, 30_000)

const env = () => ({
  ...process.env,
  TED_HOME: home,
  TED_IDLE_EXIT_MS: '30000',
  TED_HIDDEN_WINDOW: '1',
  TED_LINEAR_API: linear.url,
})

async function launchApp(): Promise<Page> {
  app = await electron.launch({ executablePath: electronPath, args: [appDir], env: env() })
  const window = await app.firstWindow()
  await window.emulateMedia({ colorScheme: null })
  await sidebar(window).waitFor()
  return window
}

const sidebar = (window: Page) => window.getByRole('navigation', { name: 'Sidebar' })
const dialog = (window: Page) => window.getByRole('dialog', { name: 'New Task' })
const linearGroup = (window: Page) => window.getByRole('group', { name: 'Linear' })

async function client(): Promise<DaemonClient> {
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('no daemon.json')
  return appClient(info, process.env.TED_APP_TOKEN)
}

async function openIntegrations(window: Page): Promise<void> {
  await sidebar(window)
    .getByRole('button', { name: /^Settings/ })
    .last()
    .click()
  await window
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Integrations', exact: true })
    .click()
  await window.getByRole('heading', { name: 'Integrations', level: 1 }).waitFor()
}

async function openNewTask(): Promise<Page> {
  const origin = await makeOriginRepo(path.join(home, 'origin'))
  await (await daemonAsApp(home, env())).addFactory({ repo: origin, key: 'NB' })
  const window = await launchApp()
  await sidebar(window).getByRole('button', { name: 'widgets' }).click()
  await window.keyboard.press('Meta+N')
  await dialog(window).waitFor()
  return window
}

async function paste(field: ReturnType<Page['getByLabel']>, text: string): Promise<void> {
  await waitUntil(() => field.isEnabled(), 'the loaded draft')
  await field.focus()
  await field.page().keyboard.insertText(text)
}

describe('Settings → Integrations → Linear', () => {
  test('Save checks the key with Linear and shows who it belongs to; Remove deletes it', async () => {
    const window = await launchApp()
    await openIntegrations(window)
    const group = linearGroup(window)
    await group.getByText('No API key').waitFor()

    await group.getByLabel('Linear API key').fill(key)
    await group.getByRole('button', { name: 'Save' }).click()

    await group.getByText('Connected as Nabha · Kriya Design').waitFor()
    await group.getByText('stored in the macOS Keychain').waitFor()
    expect(await group.getByLabel('Linear API key').inputValue()).toMatch(/•+ABCD$/)
    expect((await readStubKeyring(stubKeyringFile(home))).secret).toBe(key)

    linear.accounts.delete(key)
    await group.getByRole('button', { name: 'Test' }).click()
    await group.getByText('Linear didn’t accept this key').waitFor()

    await group.getByRole('button', { name: 'Remove' }).click()
    await group.getByText('No API key').waitFor()
    expect((await readStubKeyring(stubKeyringFile(home))).secret).toBeUndefined()
  })

  test('with a key, Sync status with Linear is on and turns off', async () => {
    await writeFile(stubKeyringFile(home), JSON.stringify({ secret: key }))
    const window = await launchApp()
    await openIntegrations(window)
    const group = linearGroup(window)
    const sync = group.getByRole('switch', { name: 'Sync status with Linear' })
    await sync.waitFor()
    expect(await sync.getAttribute('aria-checked')).toBe('true')

    await sync.click()

    await expect.poll(async () => (await (await client()).getSettings()).linearSync).toBe(false)
    await expect.poll(() => sync.getAttribute('aria-checked')).toBe('false')
  })

  test('a team the human said Not now to shows under its Factory, and Allow turns it on', async () => {
    await writeFile(stubKeyringFile(home), JSON.stringify({ secret: key }))
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    const daemon = await daemonAsApp(home, env())
    const factory = await daemon.addFactory({ repo: origin, key: 'NB' })
    await daemon.updateSettings({ linearSyncDeclined: { [factory.id]: ['NOTE'] } })
    const window = await launchApp()
    await openIntegrations(window)
    const group = linearGroup(window)
    await group.getByText('You chose Not now for').waitFor()

    await group
      .getByRole('button', { name: `Allow NOTE for Automations in ${factory.name}` })
      .click()

    await expect
      .poll(async () => (await (await client()).getSettings()).linearSyncTeams)
      .toEqual({ [factory.id]: ['NOTE'] })
    await group.getByText('You chose Not now for').waitFor({ state: 'detached' })
    expect(
      await group.getByLabel(`Linear teams for Automations in ${factory.name}`).inputValue(),
    ).toBe('NOTE')
  })

  test('with no keyring, the key is saved to a file only after the human chooses it', async () => {
    await writeFile(stubKeyringFile(home), JSON.stringify({ state: 'no-keyring' }))
    const window = await launchApp()
    await openIntegrations(window)
    const group = linearGroup(window)
    await group.getByText('No keyring found on this computer').waitFor()

    await group.getByLabel('Linear API key').fill(key)
    await group.getByRole('button', { name: 'Save in a file only you can read' }).click()

    await group.getByText('Connected as Nabha · Kriya Design').waitFor()
    await group.getByText(/stored in ~?.*secrets\/linear-api-key/).waitFor()
  })
})

describe('New Task dialog with a Linear URL', () => {
  test('with a key, pasting the URL shows the source card and fills title and Priority', async () => {
    await writeFile(stubKeyringFile(home), JSON.stringify({ secret: key }))
    const window = await openNewTask()
    const open = dialog(window)

    await paste(open.getByLabel('Description'), issueUrl)

    const card = open.getByRole('group', { name: 'Source' })
    await card.getByText('NOTE-212 · Search ignores accents').waitFor()
    expect(await open.getByLabel('Title').inputValue()).toBe('Search ignores accents')
    expect(await open.getByLabel('Priority').inputValue()).toBe('high')
    await card.getByRole('button', { name: 'Show Linear’s description' }).click()
    await open
      .getByLabel('Linear’s description')
      .getByText('Typing “cafe” should find “Café”.')
      .waitFor()

    await open.getByLabel('Start now').uncheck()
    await open.getByRole('button', { name: 'Create', exact: true }).click()
    await open.waitFor({ state: 'detached' })
    const [task] = await (await client()).listTasks()
    expect(task).toMatchObject({
      title: 'Search ignores accents',
      priority: 'high',
      source: { url: issueUrl, linear: { branchName: 'nabha/note-212-search-ignores-accents' } },
    })
  })

  test('the issue’s images show in the source preview and come with the Task', async () => {
    await writeFile(stubKeyringFile(home), JSON.stringify({ secret: key }))
    linear.uploads.set('/uploads/org/1/2', {
      body: Buffer.from('GIF89a\u0001\u0000\u0001\u0000\u0000\u0000\u0000;', 'latin1'),
      contentType: 'image/gif',
    })
    const issue = linear.accounts.get(key)?.issues?.[0]
    if (issue)
      issue.description = `Typing “cafe” fails.\n\n![search results](${linear.uploadUrl('org/1/2')})`
    const window = await openNewTask()
    const open = dialog(window)

    await paste(open.getByLabel('Description'), issueUrl)

    await open
      .getByRole('group', { name: 'Source' })
      .getByText('NOTE-212 · Search ignores accents')
      .waitFor()
    await open.getByRole('img', { name: 'search results.gif' }).waitFor()
    await open.getByLabel('Start now').uncheck()
    await open.getByRole('button', { name: 'Create', exact: true }).click()
    await open.waitFor({ state: 'detached' })
    const [task] = await (await client()).listTasks()
    expect(task?.attachments).toEqual([
      expect.objectContaining({ name: 'search results.gif', mediaType: 'image/gif' }),
    ])
  })

  test('removing the source card creates the Task without a source', async () => {
    await writeFile(stubKeyringFile(home), JSON.stringify({ secret: key }))
    const window = await openNewTask()
    const open = dialog(window)
    await paste(open.getByLabel('Description'), issueUrl)
    const card = open.getByRole('group', { name: 'Source' })
    await card.getByText('NOTE-212 · Search ignores accents').waitFor()

    await card.getByRole('button', { name: 'Remove source' }).click()
    await card.waitFor({ state: 'detached' })
    await open.getByLabel('Start now').uncheck()
    await open.getByRole('button', { name: 'Create', exact: true }).click()

    await open.waitFor({ state: 'detached' })
    const [task] = await (await client()).listTasks()
    expect(task?.source).toBeUndefined()
  })

  test('without a key, the inline Save stores the key and fetches at once', async () => {
    const window = await openNewTask()
    const open = dialog(window)

    await paste(open.getByLabel('Description'), issueUrl)

    await open
      .getByText('Add a Linear API key to fill in the title, Priority and branch from Linear.')
      .waitFor()
    await open.getByLabel('Linear API key').fill(key)
    await open.getByRole('button', { name: 'Save', exact: true }).click()

    await open.getByText('NOTE-212 · Search ignores accents').waitFor()
    expect(await open.getByLabel('Title').inputValue()).toBe('Search ignores accents')
    expect((await readStubKeyring(stubKeyringFile(home))).secret).toBe(key)
  })

  test('without a key, Create still works with the link only', async () => {
    const window = await openNewTask()
    const open = dialog(window)
    await paste(open.getByLabel('Description'), issueUrl)
    await open.getByText(/^Add a Linear API key/).waitFor()

    await open.getByLabel('Start now').uncheck()
    await open.getByRole('button', { name: 'Create', exact: true }).click()

    await open.waitFor({ state: 'detached' })
    const [task] = await (await client()).listTasks()
    expect(task).toMatchObject({ title: issueUrl, source: { url: issueUrl } })
  })

  test('a fetch that fails explains why and keeps the link', async () => {
    await writeFile(stubKeyringFile(home), JSON.stringify({ secret: key }))
    const window = await openNewTask()
    const open = dialog(window)

    await paste(open.getByLabel('Description'), 'https://linear.app/kriyadesign/issue/NOTE-9/gone')

    await open
      .getByText(
        'Couldn’t fetch from Linear: NOTE-9 doesn’t exist or this key can’t see it. The Task will be created with the link only.',
      )
      .waitFor()
    await open.getByRole('group', { name: 'Source' }).getByText('NOTE-9').waitFor()
  })
})
