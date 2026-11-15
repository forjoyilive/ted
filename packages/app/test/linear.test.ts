import { mkdtemp, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type DaemonClient, readDaemonInfo } from '@ted/protocol'
import { type ElectronApplication, _electron as electron, type Page } from 'playwright'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
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
import { chooseFactory } from './choose-factory.ts'
import { closeApp } from './close-app.ts'
import { loadedWindow } from './first-window.ts'
import { resolveElectron } from './support/electron-installation.ts'

vi.setConfig({ testTimeout: 90_000 })

const appDir = fileURLToPath(new URL('..', import.meta.url))
const electronPath = resolveElectron()

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
  const window = await loadedWindow(app)
  await window.emulateMedia({ colorScheme: null })
  return window
}

const sidebar = (window: Page) => window.getByRole('navigation', { name: 'Sidebar' })
const dialog = (window: Page) => window.getByRole('dialog', { name: 'New Task' })

async function client(): Promise<DaemonClient> {
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('no daemon.json')
  return appClient(info, process.env.TED_APP_TOKEN)
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

  test.each(['switching Factories', 'dismissing the source'])(
    'a late inline key save preserves newer draft edits after %s',
    async (change) => {
      const window = await openNewTask()
      const daemon = await client()
      const first = (await daemon.listFactories()).find((factory) => factory.key === 'NB')
      if (!first) throw new Error('missing Factory')
      const made = await makeOriginRepo(path.join(home, 'other-origin'))
      const otherRepo = path.join(path.dirname(made), 'other.git')
      await rename(made, otherRepo)
      const other = await daemon.addFactory({ repo: otherRepo, key: 'OTHER' })
      const open = dialog(window)
      await paste(open.getByLabel('Description'), `${issueUrl}\nOriginal draft`)
      await open.getByText(/^Add a Linear API key/).waitFor()
      await open.getByLabel('Start now').uncheck()
      const account = linear.accounts.get(key)
      if (!account) throw new Error('missing stub account')
      let release!: () => void
      account.viewerReady = new Promise<void>((resolve) => {
        release = resolve
      })
      try {
        await open.getByLabel('Linear API key').fill(key)
        await open.getByRole('button', { name: 'Save', exact: true }).click()
        await waitUntil(
          () => linear.requests.some((request) => request.query.includes('TedViewer')),
          'the pending key check',
        )
        const newer = `${issueUrl}\nKeep this newer description`
        if (change === 'switching Factories') {
          await chooseFactory(open, other.name)
          await waitUntil(() => open.getByLabel('Description').isEnabled(), 'the other draft')
          await chooseFactory(open, first.name)
          await waitUntil(() => open.getByLabel('Description').isEnabled(), 'the restored draft')
          await open.getByLabel('Description').fill(newer)
          await chooseFactory(open, other.name)
          await waitUntil(() => open.getByLabel('Description').isEnabled(), 'the other draft again')
        } else {
          await open.getByRole('button', { name: 'Remove source' }).click()
          await open.getByLabel('Description').fill(newer)
        }
        release()
        await waitUntil(
          async () => (await readStubKeyring(stubKeyringFile(home))).secret === key,
          'the completed key save',
        )
        await window.evaluate(async () => {
          await globalThis.window.ted.request('getLinear')
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          )
        })
        if (change === 'switching Factories') {
          await chooseFactory(open, first.name)
          await waitUntil(
            () => open.getByLabel('Description').isEnabled(),
            'the final restored draft',
          )
        } else {
          expect(await open.getByRole('button', { name: 'Remove source' }).count()).toBe(0)
        }
        expect(await open.getByLabel('Description').inputValue()).toBe(newer)
        await open.getByRole('button', { name: 'Close', exact: true }).click()
        await open.waitFor({ state: 'detached' })
        const saved = (await daemon.taskDraft(first.id)).draft
        expect(saved?.description).toBe(newer)
        if (change === 'dismissing the source') {
          expect(saved?.source).toBeUndefined()
          expect(saved?.dismissed).toContain(issueUrl)
        }
      } finally {
        release()
      }
    },
    90_000,
  )
})
