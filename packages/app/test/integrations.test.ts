import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type ElectronApplication, _electron as electron, type Page } from 'playwright'
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { removeHome, stopDaemonIn } from '../../daemon/test/helpers.ts'
import { buildRenderer } from './build-renderer.ts'
import { closeApp } from './close-app.ts'

const appDir = fileURLToPath(new URL('..', import.meta.url))
const electronPath = createRequire(import.meta.url)('electron') as string

const signedIn = {
  state: 'success',
  active: true,
  host: 'github.com',
  login: 'forjoyilive',
  tokenSource: 'keyring',
  scopes: 'gist, read:org, repo, workflow',
  gitProtocol: 'https',
}

let home: string
let ghState: string
let fixLog: string
let app: ElectronApplication | undefined

beforeAll(async () => {
  await buildRenderer()
})

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'ted-app-integrations-'))
  ghState = path.join(home, 'gh-state.json')
  fixLog = path.join(home, 'fix.log')
})

afterEach(async () => {
  await closeApp(app)
  app = undefined
  await stopDaemonIn(home)
  await removeHome(home)
}, 30_000)

async function setGh(hosts: Record<string, unknown[]>): Promise<void> {
  await writeFile(ghState, JSON.stringify({ hosts }))
}

async function launchApp(): Promise<Page> {
  app = await electron.launch({
    executablePath: electronPath,
    args: [appDir],
    env: {
      ...process.env,
      TED_HOME: home,
      TED_IDLE_EXIT_MS: '30000',
      TED_HIDDEN_WINDOW: '1',
      TED_STUB_GH: ghState,
      TED_FIX_LOG: fixLog,
    },
  })
  const window = await app.firstWindow()
  await window.emulateMedia({ colorScheme: null })
  await window.getByRole('navigation', { name: 'Sidebar' }).waitFor()
  return window
}

const settingsNav = (window: Page) => window.getByRole('navigation', { name: 'Settings' })

async function openIntegrations(window: Page): Promise<void> {
  await window
    .getByRole('navigation', { name: 'Sidebar' })
    .getByRole('button', { name: /^Settings/ })
    .last()
    .click()
  await settingsNav(window).getByRole('button', { name: 'Integrations', exact: true }).click()
  await window.getByRole('heading', { name: 'Integrations', level: 1 }).waitFor()
}

const fixesRun = () => readFile(fixLog, 'utf8').catch(() => '')

describe('Settings → Integrations', () => {
  test('shows each GitHub host and Git, and Check again reads them afresh', async () => {
    await setGh({ 'github.com': [signedIn] })
    const window = await launchApp()
    await openIntegrations(window)

    const github = window.getByRole('group', { name: 'GitHub' })
    await github.getByText('github.com', { exact: true }).waitFor()
    await github.getByText('Ready').waitFor()
    await github
      .getByText('Signed in as forjoyilive · token in the keyring · git over HTTPS')
      .waitFor()
    await github.getByText(/^Scopes: gist, read:org, repo, workflow · gh 2\.89\.0 · /).waitFor()
    await window
      .getByRole('group', { name: 'Git' })
      .getByText(/^Git \d+\.\d+$/)
      .waitFor()

    await setGh({ 'github.com': [{ ...signedIn, scopes: 'repo, read:org' }] })
    await github.getByRole('button', { name: 'Check again' }).click()
    await github.getByText('Missing workflow scope').waitFor()
    await github.getByText(/^Can’t push changes to GitHub Actions workflows/).waitFor()
    expect(await window.getByRole('alert').count()).toBe(0)

    await github.getByRole('button', { name: 'Add permission' }).click()
    await github.getByText(/^Opened gh auth refresh --hostname github\.com -s workflow/).waitFor()
    expect(await fixesRun()).toBe('gh auth refresh --hostname github.com -s workflow\n')
  })
})

describe('the GitHub banner', () => {
  test('signing out raises it, Fix opens gh auth login, and signing in clears it', async () => {
    await setGh({})
    const window = await launchApp()

    const banner = window.getByRole('alert').filter({ hasText: 'GitHub CLI is signed out' })
    await banner.getByText('GitHub CLI is signed out · needed to add a Factory').waitFor()
    await openIntegrations(window)
    await settingsNav(window)
      .getByRole('button', { name: 'Integrations', exact: true })
      .locator('svg')
      .waitFor()
    await window.getByRole('group', { name: 'GitHub' }).getByText('Signed out').waitFor()

    await setGh({ 'github.com': [signedIn] })
    await banner.getByRole('button', { name: 'Fix' }).click()
    await expect.poll(fixesRun).toBe('gh auth login --web --hostname github.com -s workflow\n')
    await banner.waitFor({ state: 'detached', timeout: 15_000 })
    await window.getByRole('group', { name: 'GitHub' }).getByText('Ready').waitFor()
  })
})
