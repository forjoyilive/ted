import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type MachineSettings, readDaemonInfo } from '@ted/protocol'
import { type ElectronApplication, _electron as electron, type Page } from 'playwright'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { appClient, removeHome, stopDaemonIn } from '../../daemon/test/helpers.ts'
import { buildRenderer } from './build-renderer.ts'
import { closeApp } from './close-app.ts'
import { firstWindow } from './first-window.ts'

const appDir = fileURLToPath(new URL('..', import.meta.url))
const electronPath = createRequire(import.meta.url)('electron') as string
const stubClaudePath = fileURLToPath(
  new URL('../../daemon/test/fixtures/stub-claude.ts', import.meta.url),
)
const stubCodexPath = fileURLToPath(
  new URL('../../daemon/test/fixtures/stub-codex.ts', import.meta.url),
)

vi.setConfig({ testTimeout: 90_000 })

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
let app: ElectronApplication | undefined

beforeAll(async () => {
  await buildRenderer()
})

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'ted-app-first-launch-'))
  await setGh({ 'github.com': [signedIn] })
  await setGitIdentity(true)
})

afterEach(async () => {
  await closeApp(app)
  app = undefined
  await stopDaemonIn(home)
  await removeHome(home)
}, 30_000)

const file = (name: string) => path.join(home, name)
const setGh = (hosts: Record<string, unknown[]>) =>
  writeFile(file('gh-state.json'), JSON.stringify({ hosts }))
const setGitIdentity = (known: boolean) =>
  writeFile(
    file('gitconfig'),
    known ? '[user]\n\tname = Nabha Cosley\n\temail = nabha@example.com\n' : '',
  )
const setStub = (agent: 'claude' | 'codex', state: Record<string, unknown>) =>
  writeFile(file(`stub-${agent}.json`), JSON.stringify(state))

const lines = (name: string) => () =>
  readFile(file(name), 'utf8').then(
    (text) => text.split('\n').filter(Boolean),
    () => [],
  )
const loginLines = lines('login-item.log')
const fixesRun = lines('fix.log')

type LaunchOptions = { codex?: boolean; env?: Record<string, string> }

const appEnv = (options: LaunchOptions = {}) => ({
  ...process.env,
  TED_HOME: home,
  TED_IDLE_EXIT_MS: '30000',
  TED_HIDDEN_WINDOW: '1',
  TED_SKIP_FIRST_LAUNCH: '',
  TED_CLAUDE_BIN: stubClaudePath,
  TED_CODEX_BIN: options.codex ? stubCodexPath : file('no-codex-here'),
  TED_STUB_GH: file('gh-state.json'),
  TED_FIX_LOG: file('fix.log'),
  TED_LOGIN_ITEM_LOG: file('login-item.log'),
  GIT_CONFIG_GLOBAL: file('gitconfig'),
  ...options.env,
})

async function launchApp(options: LaunchOptions = {}) {
  app = await electron.launch({
    executablePath: electronPath,
    args: [appDir],
    env: appEnv(options),
  })
  const window = await firstWindow(app)
  await window.emulateMedia({ colorScheme: null })
  return window
}

async function settings(): Promise<MachineSettings> {
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('no daemon.json')
  return appClient(info, process.env.TED_APP_TOKEN).getSettings()
}

const setUp = (window: Page) => window.getByRole('main', { name: 'Set up TED' })
const row = (window: Page, name: string) => setUp(window).getByRole('group', { name })
const sidebar = (window: Page) => window.getByRole('navigation', { name: 'Sidebar' })
const startAtLogin = (window: Page) =>
  window.getByRole('checkbox', { name: 'Start TED in the background when you log in' })
const continueButton = (window: Page) => window.getByRole('button', { name: 'Continue' })
const continueHelp = 'Continue needs Git and at least one agent ready.'

describe('first launch', () => {
  test.each([true, false])(
    'closing unfinished setup with the checkbox %s leaves Start at login untouched',
    async (checked) => {
      const window = await launchApp()
      await setUp(window).waitFor()
      await startAtLogin(window).setChecked(checked)
      expect(await settings()).toMatchObject({ firstLaunchDone: false, startAtLogin: true })
      expect(await loginLines()).toEqual([])

      await closeApp(app)
      app = undefined
      expect(await loginLines()).toEqual([])

      const again = await launchApp()
      await setUp(again).waitFor()
      expect(await startAtLogin(again).isChecked()).toBe(true)
      expect(await settings()).toMatchObject({ firstLaunchDone: false, startAtLogin: true })
      expect(await loginLines()).toEqual([])

      await again.getByRole('button', { name: 'Skip for now' }).click()
      await sidebar(again).waitFor()
      await expect.poll(settings).toMatchObject({ firstLaunchDone: true, startAtLogin: true })
      await expect.poll(loginLines).toEqual(['on'])

      await closeApp(app)
      app = undefined
      const completed = await launchApp()
      await sidebar(completed).waitFor()
      expect(await setUp(completed).count()).toBe(0)
      expect(await settings()).toMatchObject({ firstLaunchDone: true, startAtLogin: true })
      await sidebar(completed)
        .getByRole('button', { name: /^Settings/ })
        .click()
      const login = completed.getByRole('switch', {
        name: 'Start TED in the background when you log in',
      })
      expect(await login.getAttribute('aria-checked')).toBe('true')
      const before = await loginLines()
      await login.click()
      await expect.poll(settings).toMatchObject({ startAtLogin: false })
      await expect.poll(loginLines).toEqual([...before, 'off'])
    },
  )

  test('Continue waits for Git and an agent; Fix rechecks; it opens Add Factory, then No Factories', async () => {
    await setStub('claude', { signedIn: false })
    await setGitIdentity(false)
    const window = await launchApp()

    const claude = row(window, 'Claude Code')
    await claude.getByText('Signed out').waitFor()
    const codex = row(window, 'Codex')
    await codex.getByText('Not installed').waitFor()
    await codex.getByText('npm install -g @openai/codex').waitFor()
    const git = row(window, 'Git')
    await git.getByText('No name or email set').waitFor()
    await git.getByText('git config --global user.name "Your Name"').waitFor()
    await git.getByText('git config --global user.email "you@example.com"').waitFor()
    await window.getByText(continueHelp).waitFor()
    expect(await continueButton(window).isDisabled()).toBe(true)
    expect(await loginLines()).toEqual([])

    await codex.getByRole('button', { name: 'Open Terminal' }).click()
    await claude.getByRole('button', { name: 'Sign in' }).click()
    await expect.poll(fixesRun).toEqual(['npm install -g @openai/codex', 'claude auth login'])
    await claude.getByText(/^Opened claude auth login in (Terminal|your terminal)\./).waitFor()
    await claude.getByText(/Checking again every 5 seconds…$/).waitFor()

    await setStub('claude', {})
    await claude.getByText('Ready').waitFor({ timeout: 15_000 })
    expect(await continueButton(window).isDisabled()).toBe(true)

    await setGitIdentity(true)
    await window.evaluate(() => globalThis.dispatchEvent(new Event('focus')))
    await git.getByText('Ready').waitFor({ timeout: 15_000 })
    await expect.poll(() => continueButton(window).isEnabled()).toBe(true)

    await continueButton(window).click()
    const dialog = window.getByRole('dialog', { name: 'Add your first Factory' })
    await dialog.waitFor()
    expect(await dialog.getByRole('checkbox', { name: 'Show the tutorial' }).isChecked()).toBe(true)
    await expect.poll(settings).toMatchObject({ firstLaunchDone: true, startAtLogin: true })
    await expect.poll(loginLines).toEqual(['on'])

    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await window.getByRole('heading', { name: 'No Factories yet' }).waitFor()
    await window
      .getByText('A Factory carries Tasks from request to merge for one product.')
      .waitFor()
    await window.getByRole('main').getByRole('button', { name: 'Add Factory' }).click()
    await window.getByRole('dialog', { name: 'Add your first Factory' }).waitFor()
  })
})
