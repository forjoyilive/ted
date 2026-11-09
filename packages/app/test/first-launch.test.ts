import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type MachineSettings, readDaemonInfo } from '@ted/protocol'
import { type ElectronApplication, _electron as electron, type Page } from 'playwright'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  appClient,
  daemonAsApp,
  makeOriginRepo,
  removeHome,
  stopDaemonIn,
} from '../../daemon/test/helpers.ts'
import { buildRenderer } from './build-renderer.ts'
import { closeApp } from './close-app.ts'

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
  const window = await app.firstWindow()
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
    },
  )

  test('shows every check ready; Skip for now lets the human in, once per machine', async () => {
    await setStub('codex', {})
    const window = await launchApp({ codex: true })

    await setUp(window).getByRole('heading', { name: 'Set up TED', level: 1 }).waitFor()
    expect(await sidebar(window).count()).toBe(0)
    await row(window, 'Claude Code').getByText('Ready').waitFor()
    await row(window, 'Claude Code')
      .getByText('2.1.319 · Signed in as stub@example.com · Claude Max · subscription')
      .waitFor()
    await row(window, 'Claude Code').getByText(stubClaudePath).waitFor()
    await row(window, 'Codex').getByText('Ready').waitFor()
    await row(window, 'GitHub').getByText('Signed in as forjoyilive · github.com').waitFor()
    await row(window, 'Git')
      .getByText(/^\d+\.\d+ · Nabha Cosley <nabha@example\.com>$/)
      .waitFor()
    await expect.poll(() => continueButton(window).isEnabled()).toBe(true)
    expect(await window.getByText(continueHelp).count()).toBe(0)

    expect(await startAtLogin(window).isChecked()).toBe(true)
    expect(await loginLines()).toEqual([])
    await startAtLogin(window).uncheck()
    await window.getByRole('button', { name: 'Skip for now' }).click()

    await sidebar(window).waitFor()
    await expect.poll(settings).toMatchObject({ firstLaunchDone: true, startAtLogin: false })
    await expect.poll(loginLines).toEqual(['off'])

    await closeApp(app)
    const again = await launchApp({ codex: true })
    await sidebar(again).waitFor()
    expect(await setUp(again).count()).toBe(0)
  })

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

  test('an agent on an API key doesn’t block Continue; the human picks its billing', async () => {
    await setStub('claude', { authMethod: 'console' })
    await setGh({})
    const window = await launchApp()

    const claude = row(window, 'Claude Code')
    await claude.getByText('Signed in with an API key', { exact: true }).waitFor()
    await claude
      .getByText(
        'Claude Code reported an API key. Remove it, or choose API key billing if you meant to use one.',
      )
      .waitFor()
    await expect.poll(() => continueButton(window).isEnabled()).toBe(true)

    const github = row(window, 'GitHub')
    await github.getByText('Signed out').waitFor()
    await github.getByText(/^Needed to add a Factory\./).waitFor()
    await github.getByRole('button', { name: 'Sign in' }).click()
    await expect.poll(fixesRun).toEqual(['gh auth login --web --hostname github.com -s workflow'])

    await claude.getByRole('button', { name: 'Sign in with a subscription instead' }).click()
    await expect
      .poll(fixesRun)
      .toEqual(['gh auth login --web --hostname github.com -s workflow', 'claude auth login'])
    await claude.getByText(/^Opened claude auth login in (Terminal|your terminal)\./).waitFor()
    expect(await settings()).toMatchObject({ billing: { claude: 'subscription' } })

    await claude.getByRole('button', { name: 'Use API-key billing' }).click()
    await expect.poll(settings).toMatchObject({ billing: { claude: 'api-key' } })
    await claude.getByText('Ready').waitFor()
    expect(await claude.getByText('Signed in with an API key', { exact: true }).count()).toBe(0)
  })

  test('a machine that already has a Factory gets the plain Add Factory form after Continue', async () => {
    const ted = await daemonAsApp(home, appEnv())
    await ted.addFactory({ repo: await makeOriginRepo(home), key: 'NB' })
    const window = await launchApp()

    await row(window, 'Claude Code').getByText('Ready').waitFor()
    await expect.poll(() => continueButton(window).isEnabled()).toBe(true)
    await continueButton(window).click()
    const dialog = window.getByRole('dialog', { name: 'Add Factory' })
    await dialog.waitFor()
    expect(await dialog.getByRole('checkbox', { name: 'Show the tutorial' }).isChecked()).toBe(
      false,
    )
  })

  test('a key variable in the shell alone asks nothing, since Subscription removes it', async () => {
    const window = await launchApp({ env: { ANTHROPIC_API_KEY: 'sk-first-launch' } })

    const claude = row(window, 'Claude Code')
    await claude.getByText('Ready').waitFor()
    expect(await claude.getByRole('button', { name: 'Use API-key billing' }).count()).toBe(0)
  })
})
