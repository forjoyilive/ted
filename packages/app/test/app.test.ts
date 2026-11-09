import { execFile } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { type DaemonClient, readDaemonInfo } from '@ted/protocol'
import { type ElectronApplication, _electron as electron, type Page } from 'playwright'
import { build } from 'vite'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  appClient,
  commitToOrigin,
  daemonAsApp,
  hostRecords,
  isAlive,
  makeOriginRepo,
  removeHome,
  spawnDaemonProcess,
  stopDaemonIn,
  waitForExit,
  waitUntil,
} from '../../daemon/test/helpers.ts'
import { closeApp } from './close-app.ts'

const appDir = fileURLToPath(new URL('..', import.meta.url))
const cliPath = fileURLToPath(new URL('../../cli/src/main.ts', import.meta.url))
const stubClaudePath = fileURLToPath(
  new URL('../../daemon/test/fixtures/stub-claude.ts', import.meta.url),
)
const electronPath = createRequire(import.meta.url)('electron') as string
const run = promisify(execFile)

vi.setConfig({ testTimeout: 90_000 })

let home: string
let app: ElectronApplication | undefined
let extraEnv: Record<string, string> = {}

beforeAll(async () => {
  await build({ configFile: path.join(appDir, 'vite.config.ts'), logLevel: 'warn' })
})

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'ted-app-'))
  extraEnv = {}
})

afterEach(async () => {
  await closeApp(app)
  app = undefined
  await stopDaemonIn(home)
  await removeHome(home)
}, 30_000)

const env = () => ({
  ...process.env,
  TED_HOME: home,
  TED_IDLE_EXIT_MS: '30000',
  TED_CLAUDE_BIN: stubClaudePath,
  TED_HIDDEN_WINDOW: '1',
  ...extraEnv,
})

async function launchApp(extraEnv: Record<string, string> = {}): Promise<Page> {
  app = await electron.launch({
    executablePath: electronPath,
    args: [appDir],
    env: { ...env(), ...extraEnv },
  })
  const window = await app.firstWindow()
  await window.emulateMedia({ colorScheme: null })
  await sidebar(window).waitFor()
  return window
}

const sidebar = (window: Page) => window.getByRole('navigation', { name: 'Sidebar' })
const settingsNav = (window: Page) => window.getByRole('navigation', { name: 'Settings' })

async function openSettings(window: Page): Promise<void> {
  await sidebar(window)
    .getByRole('button', { name: /^Settings/ })
    .last()
    .click()
  await settingsNav(window).waitFor()
}

const onePixelPng =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='

async function openAllTasks(window: Page): Promise<void> {
  await sidebar(window).getByRole('button', { name: 'All Tasks' }).click()
}

const taskRow = (window: Page, text: string) => window.getByRole('row').filter({ hasText: text })

async function startDaemonAsApp(): Promise<void> {
  await rm(path.join(home, 'daemon.json'), { force: true })
  spawnDaemonProcess(['--exit-when-idle'], env())
  await waitUntil(() => readDaemonInfo(home), 'daemon.json')
}

async function addFactory(repo: string, key: string, localFolder?: string): Promise<void> {
  const app = await daemonAsApp(home, env())
  await app.addFactory({ repo, key, ...(localFolder !== undefined && { localFolder }) })
}

async function daemonClient(): Promise<DaemonClient> {
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('no daemon.json')
  return appClient(info, process.env.TED_APP_TOKEN)
}

const background = (window: Page) =>
  window.evaluate(() => getComputedStyle(document.body).backgroundColor)

const lightApp = 'rgb(250, 250, 248)'
const darkApp = 'rgb(22, 22, 21)'

function ted(...args: string[]) {
  return run(process.execPath, [cliPath, ...args], { env: env() })
}

async function daemonPid(): Promise<number> {
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('no daemon.json')
  return info.pid
}

async function commandOf(pid: number): Promise<string> {
  const { stdout } = await run('ps', ['-o', 'command=', '-p', String(pid)])
  return stdout.trim()
}

describe('TED app', () => {
  test('launching the app starts the daemon through Electron when none is running', async () => {
    await launchApp()

    expect(await commandOf(await daemonPid())).toContain(electronPath)
  })

  test('a Task created from the CLI appears in the window within a second', async () => {
    const window = await launchApp()
    await openAllTasks(window)
    await window.getByText('No Tasks yet', { exact: true }).waitFor()

    await ted('task', 'create', 'Fix login')

    await taskRow(window, 'DEV-1').filter({ hasText: 'Fix login' }).waitFor({ timeout: 1_000 })
  })

  test('a Task Lead’s Comment and the move to Done show in the window as they happen', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    await commitToOrigin(path.join(home, 'origin'), {
      '.ted/workflow.yaml': 'version: 1\norder: [intake, work, merge]\n',
    })
    const steps = JSON.stringify({
      steps: [
        { run: ['ted', 'comment', 'Halfway there'] },
        { waitFor: path.join(home, 'go') },
        { everyMessage: [{ run: ['ted', 'outcome', 'advance'] }] },
        { run: ['ted', 'outcome', 'advance'] },
      ],
    })
    await addFactory(origin, 'NB')
    await ted('task', 'create', '--factory', 'NB', steps)
    const window = await launchApp()
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    const details = window.getByRole('complementary', { name: 'Task details' })
    await details.getByText('Backlog').waitFor()

    await ted('task', 'start', 'NB-1')

    await details.getByText('Intake', { exact: true }).waitFor()
    await window.getByRole('region', { name: 'Task thread' }).getByText('Halfway there').waitFor()
    await writeFile(path.join(home, 'go'), '')
    await details.getByText('Done', { exact: true }).waitFor()
  })

  test('the thread shows event lines, and ⌘↵ sends a Comment into the Task Lead’s Run', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    await commitToOrigin(path.join(home, 'origin'), {
      '.ted/workflow.yaml': 'version: 1\norder: [intake, work, merge]\n',
    })
    await addFactory(origin, 'NB')
    await ted('task', 'create', '--factory', 'NB', JSON.stringify({ steps: [{ endTurn: true }] }))
    const window = await launchApp()
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    const thread = window.getByRole('region', { name: 'Task thread' })
    await thread.getByText('You created this Task').waitFor()
    const box = thread.getByRole('textbox', { name: 'Comment' })
    expect(await box.getAttribute('placeholder')).toBe('Comment…')
    await box.fill('Keep the old export format.')
    await box.press('ControlOrMeta+Enter')
    await thread.getByText('Goes to the next Task Lead Run').waitFor()

    await ted('task', 'start', 'NB-1')

    await thread.getByText('Task moved to Intake').waitFor()
    await thread.getByText('Task Lead started · Claude').waitFor()
    await thread.getByText('Goes to the next Task Lead Run').waitFor({ state: 'detached' })
    await expect.poll(() => box.getAttribute('placeholder')).toBe('Comment to the Task Lead…')
    await thread.getByText('Not read yet').waitFor({ state: 'detached' })
    const dot = thread.locator('[data-tone="run"]').first()
    expect(await dot.textContent()).toContain('Task Lead started')

    await box.fill('Also handle the empty query.')
    await box.press('ControlOrMeta+Enter')
    await thread.getByText('Also handle the empty query.').waitFor()
    await expect.poll(() => box.inputValue()).toBe('')
    const client = await daemonClient()
    await expect
      .poll(async () => {
        const comments = await client.listComments('NB-1')
        return comments.find((c) => c.body === 'Also handle the empty query.')?.readAt !== undefined
      })
      .toBe(true)
  })

  test('a Run opens in a Conversation tab with its chat, takes messages, and the tab persists', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    await commitToOrigin(path.join(home, 'origin'), {
      '.ted/workflow.yaml': 'version: 1\norder: [intake, work, merge]\n',
    })
    await startDaemonAsApp()
    await addFactory(origin, 'NB')
    const edit = {
      emit: {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'Edit',
              input: {
                file_path: 'notes.ts',
                old_string: 'by updated\n',
                new_string: 'by pinned\n',
              },
            },
          ],
        },
      },
    }
    const done = {
      emit: {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
        },
      },
    }
    const steps = [
      { everyMessage: [{ say: 'Noted.' }, { endTurn: true }] },
      edit,
      done,
      { say: 'Pinned notes now sort first.' },
      { endTurn: true },
    ]
    await ted('task', 'create', '--factory', 'NB', JSON.stringify({ steps }))
    await ted('task', 'start', 'NB-1')
    const client = await daemonClient()
    await expect
      .poll(async () => (await client.listTasks())[0]?.runs[0]?.state, { timeout: 20_000 })
      .toBe('idle')

    let window = await launchApp()
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    const details = window.getByRole('complementary', { name: 'Task details' })
    await details.getByRole('button', { name: /Task Lead/ }).click()

    const chat = window.getByRole('region', { name: 'Run chat' })
    await chat.getByText('Pinned notes now sort first.').waitFor()
    await chat.getByRole('button', { name: /TED’s instructions for this Run/ }).waitFor()
    await chat.getByRole('button', { name: /^Edit/ }).click()
    await chat.getByText('by pinned').waitFor()
    expect(await chat.getByRole('button', { name: 'Restart' }).isEnabled()).toBe(true)

    const box = chat.getByRole('textbox', { name: 'Message to this Run' })
    await box.fill('Keep pinned notes in the order they were pinned.')
    await box.press('Enter')
    await chat.getByText(/to this Run only/).waitFor()
    await chat.getByText('Noted.').waitFor()
    expect(await client.listComments('NB-1')).toEqual([])

    await window.getByRole('tab', { name: 'Thread' }).click()
    const thread = window.getByRole('region', { name: 'Task thread' })
    await thread.getByText('You steered the Task Lead in its Conversation').waitFor()
    await thread.getByRole('button', { name: 'View message' }).click()
    await chat.getByText('Keep pinned notes in the order they were pinned.').waitFor()

    await app?.close()
    app = undefined
    window = await launchApp()
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    await window.getByRole('tab', { name: /Task Lead/ }).click()
    await window
      .getByRole('region', { name: 'Run chat' })
      .getByText('Pinned notes now sort first.')
      .waitFor()
    await window.getByRole('button', { name: 'Close Task Lead' }).click()
    await window.getByRole('tab', { name: 'Thread' }).waitFor({ state: 'detached' })
  }, 90_000)

  test('Runs lists a sub-agent under its Task Lead, opens its chat and stops it from its row', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    await addFactory(origin, 'NB')
    const promptFile = path.join(home, 'explore.md')
    await writeFile(
      promptFile,
      `# Explore the parser\n\n${JSON.stringify({ steps: [{ say: 'Reading src/parse.ts' }, { waitFor: path.join(home, 'never') }] })}\n`,
    )
    const command = `id=$(ted run start --prompt-file ${promptFile} | grep -o "[0-9a-f-]\\{36\\}" | head -1); ted run wait "$id"`
    const steps = [{ run: ['sh', '-c', command] }, { say: 'Sub-agent done.' }, { endTurn: true }]
    await ted('task', 'create', '--factory', 'NB', JSON.stringify({ steps }))
    await ted('task', 'start', 'NB-1')
    const client = await daemonClient()
    await expect
      .poll(async () => (await client.listTasks())[0]?.runs.map((r) => r.role), { timeout: 20_000 })
      .toEqual(['lead', 'sub-agent'])

    const window = await launchApp()
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    const thread = window.getByRole('region', { name: 'Task thread' })
    await thread.getByRole('img', { name: 'Claude Code, idle' }).waitFor()
    await thread.getByRole('img', { name: 'Claude Code, working' }).waitFor()

    const runs = window
      .getByRole('complementary', { name: 'Task details' })
      .getByRole('region', { name: 'Runs' })
    await runs.getByText('2 Runs').waitFor()
    const rows = runs.getByRole('listitem')
    await expect
      .poll(() => rows.allInnerTexts())
      .toEqual([
        expect.stringMatching(/^Task Lead\s+on sub-agents\s+Claude · default model/),
        expect.stringMatching(/^Explore the parser\s+working\s+Claude · default model/),
      ])

    const sub = rows.filter({ hasText: 'Explore the parser' })
    await sub.getByRole('button', { name: /Explore the parser/ }).click()
    const chat = window.getByRole('region', { name: 'Run chat' })
    await chat.getByText('Reading src/parse.ts').waitFor()
    await window.getByRole('tab', { name: /Explore the parser/ }).waitFor()

    await sub.hover()
    await sub.getByRole('button', { name: 'Stop Run' }).click()
    await runs.getByRole('button', { name: '1 stopped Run' }).click()
    await expect
      .poll(async () => (await client.listTasks())[0]?.runs.map((r) => r.role), { timeout: 20_000 })
      .toEqual(['lead'])
    await rows.filter({ hasText: /Explore the parser\s*(just now|\d+m ago)/ }).waitFor()
  }, 90_000)

  test('the Task Lead field shows the agent, model and effort, and saves a change', async () => {
    await ted('task', 'create', 'Fix login')
    const window = await launchApp()
    await openAllTasks(window)
    await taskRow(window, 'DEV-1').click()
    const details = window.getByRole('complementary', { name: 'Task details' })
    await expect.poll(() => details.getByLabel('Agent').inputValue()).toBe('claude')

    await details.getByLabel('Agent').selectOption('codex')
    await details.getByLabel('Model').fill('gpt-6-mini')
    await details.getByLabel('Effort').selectOption('low')
    await details.getByRole('button', { name: 'Save' }).click()

    await details.getByText('Codex · gpt-6-mini · low').waitFor()

    await ted('task', 'lead', 'DEV-1', 'claude', '--model', 'opus')
    await expect.poll(() => details.getByLabel('Model').inputValue()).toBe('opus')
    expect(await details.getByLabel('Agent').inputValue()).toBe('claude')
    expect(await details.getByLabel('Effort').inputValue()).toBe('')
  })

  test('a model the plan doesn’t include shows Model unavailable until the human picks the default', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    await addFactory(origin, 'NB')
    await ted('task', 'create', '--factory', 'NB', JSON.stringify({ steps: [{ endTurn: true }] }))
    await ted('task', 'lead', 'NB-1', 'claude', '--model', 'unavailable-9')
    const window = await launchApp()
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    const details = window.getByRole('complementary', { name: 'Task details' })
    await details.getByText('Backlog').waitFor()

    await ted('task', 'start', 'NB-1')

    await details.getByText('Model unavailable').waitFor()
    await window
      .getByRole('region', { name: 'Task thread' })
      .getByText(/won’t switch models on its own/)
      .waitFor()
    await details.getByRole('button', { name: 'Use the default model' }).click()
    await details.getByText('Model unavailable').waitFor({ state: 'detached' })
  })

  test('the thread header shows the status, the live activity line and the Stage track', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    const go = (n: number) => path.join(home, `go-${n}`)
    const steps = JSON.stringify({
      steps: [
        { run: ['ted', 'comment', 'Read the brief'] },
        { run: ['ted', 'status', 'Running Checks · Tests (2 of 3)'] },
        { waitFor: go(1) },
        { hook: 'PermissionRequest' },
        { waitFor: go(2) },
        { run: ['ted', 'outcome', 'advance'] },
        { run: ['ted', 'comment', 'Asking the questions'] },
        { endTurn: true },
      ],
    })
    await addFactory(origin, 'NB')
    await ted('task', 'create', '--factory', 'NB', steps)
    const window = await launchApp()
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    const thread = window.getByRole('region', { name: 'Task thread' })
    const header = thread.locator('header')
    await header.getByText('· Not started').waitFor()

    await ted('task', 'start', 'NB-1')

    await header.getByText('Working', { exact: true }).waitFor()
    await header.getByText('· Running Checks · Tests (2 of 3)').waitFor()
    await header.getByRole('img', { name: 'Claude Code, working' }).waitFor()
    await writeFile(go(1), '')
    await header.getByText('Waiting on you', { exact: true }).waitFor()
    await writeFile(go(2), '')
    await thread.getByText('Asking the questions', { exact: true }).waitFor()
    await header.getByText('Clarify', { exact: true }).waitFor()
    expect(await header.getByText('· Running Checks').count()).toBe(0)

    const intake = header.getByRole('button', { name: 'Intake, done' })
    await intake.click()
    expect(await intake.getAttribute('aria-pressed')).toBe('true')
    await thread.getByText('Asking the questions', { exact: true }).waitFor({ state: 'detached' })
    await thread.getByText('Read the brief', { exact: true }).waitFor()
    await header.getByRole('button', { name: 'Clarify, now' }).click()
    await thread.getByText('Read the brief', { exact: true }).waitFor({ state: 'detached' })
    await thread.getByText('Asking the questions', { exact: true }).waitFor()
    await header.getByRole('button', { name: 'Clarify, now' }).click()
    await thread.getByText('Read the brief', { exact: true }).waitFor()
    await thread.getByText('Asking the questions', { exact: true }).waitFor()
    expect(
      await header.getByRole('button', { name: 'Design, not yet' }).getAttribute('aria-pressed'),
    ).toBeNull()
  })

  test('Validate’s ✓ row shows each Check’s state, the Blocking findings box, and opens the output', async () => {
    const parent = path.join(home, 'origin')
    const origin = await makeOriginRepo(parent)
    const flag = path.join(home, 'failed-once')
    await commitToOrigin(parent, {
      '.gitignore': 'stub-*\n',
      '.ted/workflow.yaml': [
        'version: 1',
        'order: [intake, work, validate]',
        'stages:',
        '  validate:',
        '    checks:',
        '      - { name: Typecheck, run: "echo typed" }',
        `      - { name: Tests, run: "if [ -e '${flag}' ]; then echo ok; else touch '${flag}'; echo 'SearchPanel hangs'; exit 1; fi" }`,
        '      - { name: Lint, run: "echo linted" }',
        '',
      ].join('\n'),
    })
    const advance = { run: ['ted', 'outcome', 'advance'] }
    const steps = JSON.stringify({
      steps: [{ everyMessage: [{ run: ['sh', '-c', 'echo x > work.txt'] }, advance] }, advance],
    })
    await addFactory(origin, 'NB')
    await ted('task', 'create', '--factory', 'NB', steps)
    const window = await launchApp()
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    const thread = window.getByRole('region', { name: 'Task thread' })

    await ted('task', 'start', 'NB-1')

    const sentBack = thread.getByRole('listitem').filter({
      hasText: 'Validate sent this back to Work (round 1 of 5)',
    })
    await sentBack.waitFor({ timeout: 40_000 })
    const row = sentBack.getByRole('list', { name: 'Checks' })
    await row.getByRole('button', { name: '✓ Typecheck' }).waitFor()
    await row.getByRole('button', { name: '✗ Tests' }).waitFor()
    await row.getByRole('listitem').filter({ hasText: 'Lint · not run' }).waitFor()
    await sentBack
      .getByRole('region', { name: 'Blocking findings' })
      .getByText(/The Check “Tests”/)
      .waitFor()
    await thread.getByText('Checks passed at Validate').waitFor({ timeout: 40_000 })

    await row.getByRole('button', { name: '✗ Tests' }).click()
    const dialog = window.getByRole('dialog', { name: 'Tests output' })
    await dialog.getByText('SearchPanel hangs', { exact: true }).waitFor()
    await dialog.getByRole('tab', { name: 'Typecheck' }).click()
    await window.getByRole('dialog', { name: 'Typecheck output' }).getByText('typed').waitFor()
    await window.getByRole('button', { name: 'Close' }).click()
    await dialog.waitFor({ state: 'detached' })
  }, 90_000)

  test('the Code section shows No worktree yet, then the branch and worktree path', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    await addFactory(origin, 'NB')
    await ted('task', 'create', '--factory', 'NB', JSON.stringify({ steps: [{ endTurn: true }] }))
    const window = await launchApp()
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    const code = window
      .getByRole('complementary', { name: 'Task details' })
      .getByRole('region', { name: 'Code' })
    await code.getByText('No worktree yet').waitFor()

    await ted('task', 'start', 'NB-1')

    await code.getByText(/^ted\/nb-1/).waitFor()
    await code.getByText(path.join(home, 'worktrees', 'NB-1', 'widgets')).waitFor()
  })

  test('a missing local folder raises a Factory banner whose Locate picks a new folder', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    const folder = path.join(home, 'local')
    const moved = path.join(home, 'moved')
    await mkdir(folder)
    await addFactory(origin, 'NB', folder)
    await rm(folder, { recursive: true })
    await mkdir(moved)

    const window = await launchApp()
    await pickFolderWith(moved)
    await sidebar(window).getByRole('button', { name: 'widgets' }).click()

    const banners = window.getByRole('region', { name: 'widgets problems' })
    await banners.getByText('Local folder for widgets not found').waitFor()
    await banners.getByRole('button', { name: 'Locate' }).click()

    await window.getByText('Local folder for widgets not found').waitFor({ state: 'detached' })
    const [factory] = await (await daemonClient()).listFactories()
    expect(factory?.localFolder).toEqual({ path: moved, found: true })
  })

  test('quitting with nothing running ends the app and TED’s background process', async () => {
    await launchApp()
    const pid = await daemonPid()
    const electronPid = app?.process().pid ?? 0

    await app?.close()
    app = undefined

    await waitForExit(pid)
    expect(isAlive(electronPid)).toBe(false)
  })

  test('the app takes over a daemon that ted started, which never learned the app’s token', async () => {
    await ted('task', 'create', 'Fix login')
    const pid = await daemonPid()

    const window = await launchApp()

    await openAllTasks(window)
    await taskRow(window, 'DEV-1').waitFor()
    expect(await daemonPid()).not.toBe(pid)
    expect(await (await daemonClient()).caller()).toMatchObject({ kind: 'app' })
  })

  test('the renderer has no Node, filesystem or store access, only the bridge', async () => {
    const window = await launchApp()

    const globals = await window.evaluate(() => ({
      require: typeof (globalThis as { require?: unknown }).require,
      process: typeof (globalThis as { process?: unknown }).process,
      bridge: Object.keys((globalThis as unknown as { ted: object }).ted).sort(),
    }))

    expect(globals).toEqual({
      require: 'undefined',
      process: 'undefined',
      bridge: ['onEvent', 'request'],
    })
  })

  test.runIf(process.platform === 'linux')(
    'the daemon the app starts shares no pipes or sockets with Electron',
    async () => {
      await launchApp()
      const electronPid = app?.process().pid
      if (electronPid === undefined) throw new Error('no Electron pid')

      const electron = new Set(await channelsOf(electronPid))
      const shared = (await channelsOf(await daemonPid())).filter((c) => electron.has(c))

      expect(shared).toEqual([])
    },
  )
})

describe('TED app frame', () => {
  test('the sidebar lists Factories; the current one opens its Board, List and other Views', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    await addFactory(origin, 'NB')
    await ted('task', 'create', '--factory', 'NB', 'Offline editing')
    const window = await launchApp()
    const nav = sidebar(window)
    const factory = nav.getByRole('button', { name: 'widgets' })
    await factory.waitFor()
    expect(await factory.getAttribute('aria-expanded')).toBe('false')

    await factory.click()

    expect(await factory.getAttribute('aria-expanded')).toBe('true')
    const board = nav.getByRole('button', { name: 'Board', exact: true })
    expect(await board.getAttribute('aria-current')).toBe('page')
    await window.getByRole('region', { name: 'Backlog' }).getByText('Offline editing').waitFor()
    for (const view of ['List', 'Plans', 'Automations']) {
      await nav.getByRole('button', { name: view, exact: true }).waitFor()
    }

    await nav.getByRole('button', { name: 'All Tasks' }).click()
    expect(await factory.getAttribute('aria-expanded')).toBe('true')
  })

  test('a Factory added while the app is open appears in the sidebar', async () => {
    const window = await launchApp()
    const origin = await makeOriginRepo(path.join(home, 'origin'))

    await addFactory(origin, 'NB')

    await sidebar(window).getByRole('button', { name: 'widgets' }).waitFor()
  })

  test('opening a Task shows a back link to where it came from', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    await addFactory(origin, 'NB')
    await ted('task', 'create', '--factory', 'NB', 'Offline editing')
    const window = await launchApp()
    const nav = sidebar(window)
    await nav.getByRole('button', { name: 'widgets' }).click()

    for (const [view, back] of [
      ['Board', '← Board'],
      ['List', '← List'],
      ['All Tasks', '← All Tasks'],
    ] as const) {
      await nav.getByRole('button', { name: view, exact: true }).click()
      await window.getByRole('main').getByText('Offline editing').click()
      await window.getByRole('heading', { name: 'Offline editing' }).waitFor()

      await window.getByRole('button', { name: back }).click()

      await window.getByRole('heading', { name: 'Offline editing' }).waitFor({ state: 'detached' })
    }
  })

  test('Blocked by in Task details adds and removes blockers, and refuses a cycle', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    await addFactory(origin, 'NB')
    await ted('task', 'create', '--factory', 'NB', 'Crash when search is empty')
    await ted('task', 'create', '--factory', 'NB', 'Offline editing')
    const window = await launchApp()
    await sidebar(window).getByRole('button', { name: 'widgets' }).click()
    await sidebar(window).getByRole('button', { name: 'List', exact: true }).click()
    await window.getByRole('main').getByText('Offline editing').click()
    const details = window.getByRole('complementary', { name: 'Task details' })

    await details.getByRole('button', { name: 'Add blocker' }).click()
    await details.getByLabel('Find a Task').fill('crash')
    await details.getByRole('option', { name: /NB-1/ }).click()

    await details.getByText('Crash when search is empty').waitFor()
    await window.getByRole('main').getByText('Blocked by').first().waitFor()
    await window.getByText('Starts when NB-1 merges').first().waitFor()

    await window.getByRole('button', { name: '← List' }).click()
    await window.getByRole('main').getByText('Crash when search is empty').click()
    await details.getByRole('button', { name: 'Add blocker' }).click()
    await details.getByLabel('Find a Task').fill('offline')
    await details.getByRole('option', { name: /NB-2/ }).click()
    await details
      .getByText('NB-2 can’t block NB-1: that makes a cycle, NB-1 → NB-2 → NB-1')
      .waitFor()

    await window.getByRole('button', { name: '← List' }).click()
    await window.getByRole('main').getByText('Offline editing').click()
    await details.getByRole('button', { name: 'Remove NB-1' }).click()
    await expect
      .poll(
        async () =>
          (await (await daemonClient()).listTasks()).find((t) => t.displayId === 'NB-2')?.blockedBy,
      )
      .toEqual([])
  })

  test('the theme follows the system appearance', async () => {
    const window = await launchApp()

    await window.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => background(window), { timeout: 5_000 }).toBe(darkApp)
    await window.emulateMedia({ colorScheme: 'light' })
    await expect.poll(() => background(window), { timeout: 5_000 }).toBe(lightApp)
  })

  test('the Appearance setting switches the theme at once, from the app or the daemon', async () => {
    const window = await launchApp()
    await openSettings(window)
    const appearance = window.getByRole('radiogroup', { name: 'Appearance' })

    await appearance.getByText('Dark').click()
    await expect.poll(() => background(window), { timeout: 5_000 }).toBe(darkApp)
    expect((await (await daemonClient()).getSettings()).appearance).toBe('dark')

    await (await daemonClient()).updateSettings({ appearance: 'light' })
    await expect.poll(() => background(window), { timeout: 5_000 }).toBe(lightApp)
    await expect
      .poll(() => appearance.getByRole('radio', { name: 'Light' }).isChecked(), { timeout: 5_000 })
      .toBe(true)
  })

  test('the Appearance setting applies when the app starts', async () => {
    await startDaemonAsApp()
    await (await daemonClient()).updateSettings({ appearance: 'dark' })

    const window = await launchApp()

    await expect.poll(() => background(window), { timeout: 5_000 }).toBe(darkApp)
  })

  test('a Help (?) shows its note in a tooltip on hover', async () => {
    const window = await launchApp()

    await window.getByRole('button', { name: 'Help' }).hover()

    await window
      .getByRole('tooltip')
      .getByText(/need your answer/)
      .waitFor()
  })

  test('fonts and styles load under the renderer’s content security policy', async () => {
    const violations: string[] = []
    app = await electron.launch({ executablePath: electronPath, args: [appDir], env: env() })
    const window = await app.firstWindow()
    window.on('console', (message) => {
      if (/Content Security Policy/i.test(message.text())) violations.push(message.text())
    })
    await sidebar(window).waitFor()

    const loaded = await window.evaluate(async () => {
      const faces = [
        ...(await document.fonts.load('14px "Geist Variable"')),
        ...(await document.fonts.load('12px "Geist Mono Variable"')),
      ]
      return faces.map((face) => `${face.family} ${face.status}`)
    })
    expect(loaded).toEqual(['Geist Variable loaded', 'Geist Mono Variable loaded'])
    expect(violations).toEqual([])
  })
})

describe('New Task dialog', () => {
  async function withFactory(): Promise<Page> {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    await addFactory(origin, 'NB')
    const window = await launchApp()
    await sidebar(window).getByRole('button', { name: 'widgets' }).click()
    return window
  }

  const dialog = (window: Page) => window.getByRole('dialog', { name: 'New Task' })

  const tasks = async () => (await daemonClient()).listTasks()

  const isFocused = (window: Page) =>
    dialog(window)
      .getByLabel('Description')
      .evaluate((el) => el === document.activeElement)

  test('⌘N and C open it with the current Factory selected and the description focused', async () => {
    const window = await withFactory()

    await window.keyboard.press('Meta+N')

    const open = dialog(window)
    await open.waitFor()
    const [factory] = await (await daemonClient()).listFactories()
    expect(await open.getByLabel('Factory').inputValue()).toBe(factory?.id)
    expect(await isFocused(window)).toBe(true)
    await window.keyboard.press('Escape')
    await open.waitFor({ state: 'detached' })

    await window.keyboard.press('c')
    await open.waitFor()
    expect(await open.getByLabel('Description').inputValue()).toBe('')
  })

  test('the sidebar + and the View header open it too', async () => {
    const window = await withFactory()

    await sidebar(window).getByRole('button', { name: 'New Task' }).click()
    await dialog(window).waitFor()
    await dialog(window).getByRole('button', { name: 'Close' }).click()
    await dialog(window).waitFor({ state: 'detached' })

    await window.getByRole('main').getByRole('button', { name: 'New Task' }).click()
    await dialog(window).waitFor()
  })

  test('Start now unchecked puts the Task in Backlog, titled from the description’s first line', async () => {
    const window = await withFactory()
    await window.keyboard.press('Meta+N')
    const open = dialog(window)

    await open.getByLabel('Description').fill('Search ignores accents\nTyping cafe finds Café.')
    await open.getByLabel('Priority').selectOption('high')
    await open.getByLabel('Start now').uncheck()
    await open.getByText('Waits in Backlog until you start it').waitFor()
    await window.keyboard.press('Meta+Enter')

    await open.waitFor({ state: 'detached' })
    await window
      .getByRole('region', { name: 'Backlog' })
      .getByText('Search ignores accents')
      .waitFor()
    expect(await tasks()).toMatchObject([
      {
        title: 'Search ignores accents',
        description: 'Search ignores accents\nTyping cafe finds Café.',
        priority: 'high',
        stage: 'backlog',
      },
    ])
  })

  test('Start now checked starts the Task at Intake', async () => {
    const window = await withFactory()
    await window.keyboard.press('Meta+N')
    const open = dialog(window)
    await open.getByText('Unchecked puts it in Backlog').waitFor()

    await open.getByLabel('Title').fill('Starts now')
    await open.getByLabel('Description').fill(JSON.stringify({ steps: [{ endTurn: true }] }))
    await open.getByRole('button', { name: 'Create', exact: true }).click()

    await window.getByRole('region', { name: 'Intake' }).getByText('Starts now').waitFor()
  })

  test('Create more keeps the dialog open and clears it', async () => {
    const window = await withFactory()
    await window.keyboard.press('Meta+N')
    const open = dialog(window)

    await open.getByLabel('Title').fill('First')
    await open.getByLabel('Description').fill('One')
    await open.getByLabel('Start now').uncheck()
    await open.getByRole('button', { name: 'Create more' }).click()

    await expect.poll(async () => (await tasks()).map((t) => t.title)).toEqual(['First'])
    expect(await open.isVisible()).toBe(true)
    await expect.poll(() => open.getByLabel('Title').inputValue()).toBe('')
    expect(await open.getByLabel('Description').inputValue()).toBe('')
    expect(await isFocused(window)).toBe(true)
  })

  test('attachments dropped or picked are stored and shown on the Task', async () => {
    const window = await withFactory()
    await window.keyboard.press('Meta+N')
    const open = dialog(window)

    const dropped = await window.evaluateHandle(() => {
      const data = new DataTransfer()
      data.items.add(new File(['hello'], 'notes.txt', { type: 'text/plain' }))
      return data
    })
    await open
      .getByRole('button', { name: /Drop files here/ })
      .dispatchEvent('drop', { dataTransfer: dropped })
    await open.getByText('notes.txt').waitFor()
    await open.getByLabel('Attach files').setInputFiles({
      name: 'cafe.png',
      mimeType: 'image/png',
      buffer: Buffer.from('png'),
    })
    await open.getByText('cafe.png').waitFor()
    await open.getByLabel('Description').fill('With files')
    await open.getByLabel('Start now').uncheck()
    await open.getByRole('button', { name: 'Create', exact: true }).click()

    await window.getByRole('main').getByText('With files').click()
    const details = window.getByRole('complementary', { name: 'Task details' })
    await details.getByText('notes.txt').waitFor()
    await details.getByText('cafe.png').waitFor()
    expect((await tasks())[0]?.attachments.map((a) => a.name)).toEqual(['notes.txt', 'cafe.png'])
  })

  test('a blocker from any Factory is stored and the footer says the Task waits for it', async () => {
    await ted('task', 'create', 'Crash when search is empty')
    const window = await withFactory()
    await window.keyboard.press('Meta+N')
    const open = dialog(window)

    await open.getByRole('button', { name: 'Add blocker' }).click()
    await open.getByLabel('Find a Task').fill('crash')
    await open.getByRole('option', { name: /DEV-1/ }).click()
    await open.getByText('Waits as Blocked until DEV-1 merges').waitFor()
    await open.getByLabel('Description').fill('After the crash fix')
    await open.getByRole('button', { name: 'Create', exact: true }).click()

    await open.waitFor({ state: 'detached' })
    const [blocker, task] = await tasks()
    expect(task).toMatchObject({ stage: 'backlog', blockedBy: [blocker?.id] })
  })

  test('More shows Clarify depth and the Task Lead from the Factory, and keeps changes', async () => {
    const window = await withFactory()
    await window.keyboard.press('Meta+N')
    const open = dialog(window)
    const more = open.getByRole('button', { name: /^More/ })
    await open.getByText('Clarify depth Auto · Task Lead Claude').waitFor()
    expect(await more.getAttribute('aria-expanded')).toBe('false')

    await more.click()
    await open.getByRole('radiogroup', { name: 'Clarify depth' }).getByText('Grill').click()
    await open.getByLabel('Agent').selectOption('codex')
    await open.getByLabel('Effort').selectOption('high')
    await more.click()
    await open.getByText('Clarify depth Grill · Task Lead Codex · high').waitFor()
    await open.getByLabel('Description').fill('Deep one')
    await open.getByLabel('Start now').uncheck()
    await open.getByRole('button', { name: 'Create', exact: true }).click()

    await open.waitFor({ state: 'detached' })
    expect((await tasks())[0]).toMatchObject({
      clarifyDepth: 'grilling',
      lead: { agent: 'codex', effort: 'high' },
    })
  })
})

describe('App Settings', () => {
  test('⌘, opens Settings over the whole window; Esc and ← Back return to where the human was', async () => {
    const window = await launchApp()
    await openAllTasks(window)
    await window.getByRole('heading', { name: 'All Tasks' }).waitFor()

    await window.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,')

    await settingsNav(window).waitFor()
    await window.getByRole('heading', { name: 'General', level: 1 }).waitFor()
    expect(await sidebar(window).count()).toBe(0)

    await window.keyboard.press('Escape')
    await window.getByRole('heading', { name: 'All Tasks' }).waitFor()
    expect(await settingsNav(window).count()).toBe(0)

    await openSettings(window)
    await settingsNav(window).getByRole('button', { name: /Back/ }).click()
    await window.getByRole('heading', { name: 'All Tasks' }).waitFor()
  })

  test('Settings lists the eight sections, then each Factory, which leaves for its settings page', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    await addFactory(origin, 'NB')
    const window = await launchApp()
    await openSettings(window)
    const nav = settingsNav(window)

    const sections = [
      'General',
      'Notifications',
      'Agents',
      'Limits',
      'Integrations',
      'Library',
      'Storage',
      'Developer',
    ]
    for (const section of sections) {
      await nav.getByRole('button', { name: section, exact: true }).click()
      await window.getByRole('heading', { name: section, level: 1 }).waitFor()
      expect(
        await nav.getByRole('button', { name: section, exact: true }).getAttribute('aria-current'),
      ).toBe('page')
    }

    await nav.getByRole('button', { name: /widgets/ }).click()

    await window.getByRole('heading', { name: 'widgets · Factory settings' }).waitFor()
    expect(await settingsNav(window).count()).toBe(0)
  })

  test('the terminal font size saves on this machine and applies at once', async () => {
    const window = await launchApp()
    await openSettings(window)

    await window.getByRole('combobox', { name: 'Terminal font size' }).selectOption('16')

    await expect
      .poll(() =>
        window.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--terminal-font-size'),
        ),
      )
      .toBe('16px')
    expect((await (await daemonClient()).getSettings()).terminalFontSize).toBe(16)
  })

  test('the profile picture can be changed and removed; initials show without one', async () => {
    const picture = path.join(home, 'me.png')
    await writeFile(picture, Buffer.from(onePixelPng, 'base64'))
    const window = await launchApp()
    await app?.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    }, picture)
    await openSettings(window)
    const profile = window.getByRole('group', { name: 'Profile' })
    await profile.getByRole('img').and(profile.locator('span')).waitFor()

    await profile.getByRole('button', { name: 'Change…' }).click()

    await profile.locator('img').waitFor()
    await expect
      .poll(async () => (await (await daemonClient()).getSettings()).profilePicture)
      .toMatch(/^data:image\/png;base64,/)

    await profile.getByRole('button', { name: 'Remove' }).click()

    await profile.locator('img').waitFor({ state: 'detached' })
    expect((await (await daemonClient()).getSettings()).profilePicture).toBeNull()
  })

  test('run from source, the ted command row says only an installed copy can install it', async () => {
    const window = await launchApp()
    await openSettings(window)
    const commandLine = window.getByRole('group', { name: 'Command line' })

    await commandLine.getByText('Only an installed copy of TED can install it.').waitFor()
    expect(await commandLine.getByRole('button', { name: 'Install the ted command' }).count()).toBe(
      0,
    )
  })

  test('About shows the version, and Third-party licenses opens with agent-orchestrator’s NOTICE', async () => {
    const window = await launchApp()
    await openSettings(window)
    const about = window.getByRole('group', { name: 'About and updates' })
    await about.getByText(/^TED \d+\.\d+\.\d+$/).waitFor()

    await about.getByRole('button', { name: 'View' }).click()

    const licenses = window.getByRole('dialog', { name: 'Third-party licenses' })
    await licenses.getByText(/https:\/\/github\.com\/OrchestratorInc\/agent-orchestrator/).waitFor()
    await licenses.getByRole('button', { name: 'Close' }).click()
    await licenses.waitFor({ state: 'detached' })
  })

  test('Developer mode shows Diagnostics and the log viewer; off, they’re hidden', async () => {
    const window = await launchApp()
    await openSettings(window)
    await settingsNav(window).getByRole('button', { name: 'Developer', exact: true }).click()
    const diagnostics = window.getByRole('region', { name: 'Diagnostics' })
    const logs = window.getByRole('region', { name: 'Logs' })
    expect(await diagnostics.count()).toBe(0)
    expect(await logs.count()).toBe(0)

    await window.getByRole('switch', { name: 'Developer mode' }).click()

    await diagnostics.waitFor()
    await logs.waitFor()
    expect((await (await daemonClient()).getSettings()).developerMode).toBe(true)
    await logs.getByText(/TED daemon .* listening/).waitFor()

    await window.getByRole('switch', { name: 'Developer mode' }).click()
    await diagnostics.waitFor({ state: 'detached' })
    expect(await logs.count()).toBe(0)
  })

  test('the log viewer shows a Run’s raw output, and Diagnostics lists the Run', async () => {
    const window = await launchApp()
    const client = await daemonClient()
    await client.updateSettings({ developerMode: true })
    const run = await client.startDevRun({
      prompt: JSON.stringify({ steps: [{ say: 'from the stub' }, { endTurn: true }] }),
      cwd: home,
    })
    await openSettings(window)
    await settingsNav(window).getByRole('button', { name: 'Developer', exact: true }).click()

    await window
      .getByRole('region', { name: 'Diagnostics' })
      .getByRole('cell', { name: run.id.slice(0, 8), exact: true })
      .waitFor()
    const logs = window.getByRole('region', { name: 'Logs' })
    await logs.getByRole('combobox', { name: 'Log' }).selectOption(run.id)
    await logs.getByText(/from the stub/).waitFor()
  })

  test('Copy report puts the report on the clipboard, and Show in Finder opens TED’s folder', async () => {
    const window = await launchApp()
    await app?.evaluate(({ shell }) => {
      const opened: string[] = []
      Object.assign(globalThis, { opened })
      shell.openPath = async (folder: string) => {
        opened.push(folder)
        return ''
      }
    })
    await openSettings(window)
    await settingsNav(window).getByRole('button', { name: 'Developer', exact: true }).click()

    await window.getByRole('button', { name: 'Copy report' }).click()
    await window.getByText('Report copied.').waitFor()
    expect(await app?.evaluate(({ clipboard }) => clipboard.readText())).toMatch(/^TED \S+\n/)

    await window.getByRole('button', { name: /^Show in / }).click()
    await expect
      .poll(() => app?.evaluate(() => (globalThis as unknown as { opened: string[] }).opened))
      .toEqual([home])
  })
})

describe('Add Factory', () => {
  const dialog = (window: Page) => window.getByRole('dialog')

  async function openForm(window: Page) {
    await sidebar(window).getByRole('button', { name: 'Add Factory' }).click()
    await dialog(window).waitFor()
  }

  test('adding from owner/repo checks access, clones, and opens the new Board', async () => {
    await makeOriginRepo(path.join(home, 'origin'))
    await githubReady(['acme/widgets'])
    const window = await launchApp()
    await openForm(window)
    const form = dialog(window)
    await form.getByRole('heading', { name: 'Add your first Factory' }).waitFor()
    expect(await form.getByLabel('Show the tutorial').isChecked()).toBe(true)

    await form.getByLabel('GitHub URL or owner/repo').fill('acme/widgets')
    await form.getByLabel('GitHub URL or owner/repo').press('Enter')
    await form.getByText('Can push and open pull requests').waitFor()
    expect(await form.getByLabel('Name', { exact: true }).first().inputValue()).toBe('widgets')
    expect(await form.getByLabel('Key').inputValue()).toBe('WD')
    await form.getByText('TED clones the repo, then starts the setup Task WD-1.').waitFor()

    await form.getByRole('button', { name: 'Add Factory' }).click()
    await dialog(window).waitFor({ state: 'detached' })
    await sidebar(window).getByRole('button', { name: 'Widgets' }).waitFor()
    await window.getByRole('region', { name: 'Setting up Widgets' }).waitFor({ state: 'detached' })
    const [factory] = await (await daemonClient()).listFactories()
    expect(factory).toMatchObject({ key: 'WD', cloned: true, showTutorial: true })
  })

  test('access problems and a taken key show their messages and keep Add Factory disabled', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    await githubReady(['acme/widgets'])
    await addFactory(origin, 'NB')
    const window = await launchApp()
    await openForm(window)
    const form = dialog(window)
    await form.getByRole('heading', { name: 'Add Factory' }).waitFor()

    await form.getByLabel('GitHub URL or owner/repo').fill('acme/nope')
    await form.getByLabel('GitHub URL or owner/repo').press('Enter')
    await form.getByText('Repository not found, or your GitHub account can’t see it.').waitFor()
    await form.getByRole('button', { name: 'Check again' }).waitFor()
    await form.getByRole('button', { name: 'GitHub settings' }).waitFor()

    await form.getByRole('button', { name: 'Clear the primary repo' }).click()
    await form.getByLabel('GitHub URL or owner/repo').fill('acme/widgets')
    await form.getByLabel('GitHub URL or owner/repo').press('Enter')
    await form.getByText(/is the primary repo of Factory widgets\./).waitFor()
    await form.getByRole('button', { name: 'Open widgets' }).waitFor()

    await form.getByLabel('Key').fill('NB')
    await form.getByText('NB is already the key of widgets.').waitFor()
    await form.getByText('Fix the 1 repo problem and the key to continue.').waitFor()
    expect(await form.getByRole('button', { name: 'Add Factory' }).isDisabled()).toBe(true)
  })

  test('Choose folder reads the folder’s GitHub remote', async () => {
    await makeOriginRepo(path.join(home, 'origin'))
    await githubReady(['acme/widgets'])
    const folder = path.join(home, 'code', 'widgets')
    await run('git', ['clone', path.join(home, 'origin', 'acme', 'widgets.git'), folder])
    await run('git', ['remote', 'set-url', 'origin', 'git@github.com:acme/widgets.git'], {
      cwd: folder,
    })
    const window = await launchApp()
    await pickFolderWith(folder)
    await openForm(window)
    const form = dialog(window)

    await form.getByRole('button', { name: 'Choose folder…' }).click()
    await form.getByText('acme/widgets').waitFor()
    await form.getByText('from a folder').waitFor()
    await form.getByText('Can push and open pull requests').waitFor()
  })

  test('a failed clone shows a red row and the banner; Retry recovers', async () => {
    await makeOriginRepo(path.join(home, 'origin'))
    await githubReady(['acme/widgets'])
    const origin = path.join(home, 'origin', 'acme', 'widgets.git')
    await rename(origin, `${origin}.hidden`)
    const window = await launchApp()
    await openForm(window)
    const form = dialog(window)
    await form.getByLabel('GitHub URL or owner/repo').fill('acme/widgets')
    await form.getByLabel('GitHub URL or owner/repo').press('Enter')
    await form.getByText('Can push and open pull requests').waitFor()
    await form.getByRole('button', { name: 'Add Factory' }).click()

    const panel = window.getByRole('region', { name: 'Setting up Widgets' })
    await panel.getByText(/Clone failed:/).waitFor()
    const banners = window.getByRole('region', { name: 'Widgets problems' })
    await banners
      .getByText('Couldn’t clone acme/widgets · Widgets can’t start Tasks until it’s cloned')
      .waitFor()
    await sidebar(window).getByRole('img', { name: 'A problem stops work' }).waitFor()

    await rename(`${origin}.hidden`, origin)
    await banners.getByRole('button', { name: 'Retry' }).click()
    await panel.waitFor({ state: 'detached' })
    await banners.getByText(/Couldn’t clone/).waitFor({ state: 'detached' })
  })
})

describe('banners', () => {
  const noChecks = 'No Checks set up · Validate relies on the agent alone'

  test('a Factory banner shows on that Factory’s pages only, and × hides a warning', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    await addFactory(origin, 'NB')
    const window = await launchApp()
    const nav = sidebar(window)
    const factoryBanners = window.getByRole('region', { name: 'widgets problems' })

    await nav.getByRole('button', { name: 'widgets' }).click()
    await factoryBanners.getByText(noChecks).waitFor()
    await nav.getByRole('button', { name: 'List', exact: true }).click()
    await factoryBanners.getByText(noChecks).waitFor()
    expect(await nav.getByRole('img', { name: 'A problem stops work' }).count()).toBe(0)

    await nav.getByRole('button', { name: 'All Tasks' }).click()
    await window.getByRole('region', { name: 'All Tasks' }).waitFor()
    expect(await window.getByText(noChecks).count()).toBe(0)

    await nav.getByRole('button', { name: 'Board', exact: true }).click()
    await factoryBanners.getByRole('button', { name: 'Dismiss for 24 hours' }).click()
    await factoryBanners.waitFor({ state: 'detached' })
    const [banner] = await (await daemonClient()).listBanners()
    expect(banner?.dismissedUntil).toBeDefined()
  })

  test('a stops-work Factory banner marks the sidebar row, and Retry clears it', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    await addFactory(origin, 'NB')
    await ted('task', 'create', '--factory', 'NB', 'Offline editing')
    const window = await launchApp()
    const nav = sidebar(window)
    await nav.getByRole('button', { name: 'widgets' }).click()
    const factoryBanners = window.getByRole('region', { name: 'widgets problems' })
    await factoryBanners.getByText(noChecks).waitFor()

    await rm(path.join(home, 'repos'), { recursive: true, force: true })
    await run('mv', [origin, `${origin}.hidden`])
    await expect(ted('task', 'start', 'NB-1')).rejects.toMatchObject({ code: 1 })

    const failed = factoryBanners.getByRole('alert')
    await failed.getByText('Couldn’t clone acme/widgets').waitFor()
    expect(await factoryBanners.locator('[role=alert], [role=status]').allTextContents()).toEqual([
      expect.stringContaining('Couldn’t clone'),
      expect.stringContaining('No Checks'),
    ])
    expect(await failed.getByRole('button', { name: 'Dismiss for 24 hours' }).count()).toBe(0)
    await nav.getByRole('img', { name: 'A problem stops work' }).waitFor()

    await run('mv', [`${origin}.hidden`, origin])
    await failed.getByRole('button', { name: 'Retry' }).click()

    await failed.waitFor({ state: 'detached' })
    await nav.getByRole('img', { name: 'A problem stops work' }).waitFor({ state: 'detached' })
  })
})

describe('agent health', () => {
  test('a signed-out agent pauses its Task, shows a Fix banner and a red Agents card', async () => {
    await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ signedIn: false }))
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    await addFactory(origin, 'NB')
    await ted('task', 'create', '--factory', 'NB', 'Offline editing')
    await ted('task', 'start', 'NB-1')
    const window = await launchApp()

    const problems = window.getByRole('region', { name: 'Problems' })
    const banner = problems.getByRole('alert').filter({ hasText: 'Claude Code is signed out' })
    await banner.getByRole('button', { name: 'Fix' }).waitFor()
    await sidebar(window).getByRole('button', { name: 'widgets' }).click()
    await window.getByText('Paused · Claude Code is signed out').waitFor()

    await openSettings(window)
    await settingsNav(window).getByRole('button', { name: 'Agents', exact: true }).click()
    const card = window.getByRole('region', { name: 'Claude Code' })
    await card.getByText(/^Signed out/).waitFor()
    await card.getByText('Not signed in.').waitFor()
    await card.getByRole('button', { name: 'Sign in' }).waitFor()
    await card.getByRole('button', { name: 'Copy command' }).waitFor()
    expect(await card.getAttribute('data-state')).toBe('signed-out')

    await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ signedIn: true }))
    await card.getByRole('button', { name: 'Check again' }).click()
    await card.getByText('Ready').waitFor()
    await banner.waitFor({ state: 'detached' })
  })
})

describe('Working Runs', () => {
  const forever = () => JSON.stringify({ steps: [{ waitFor: path.join(home, 'never') }] })

  async function twoTasksOneSlot(): Promise<Page> {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    await addFactory(origin, 'NB')
    await ted('task', 'create', '--factory', 'NB', forever())
    await ted('task', 'create', '--factory', 'NB', 'Second Task')
    const window = await launchApp()
    await (await daemonClient()).updateSettings({ maxWorkingRuns: 1 })
    return window
  }

  test('the sidebar footer counts working and queued Runs live and opens the popover', async () => {
    const window = await twoTasksOneSlot()
    const footer = sidebar(window).locator('footer')
    await footer.getByText('Nothing running').waitFor()

    await ted('task', 'start', 'NB-1')
    await ted('task', 'start', 'NB-2')
    await footer.getByRole('button', { name: '1 of 1 Runs working · 1 queued' }).click()

    const popover = window.getByRole('dialog', { name: 'Working Runs' })
    const machine = process.platform === 'darwin' ? 'this Mac' : 'this computer'
    await popover.getByText(`1 of 1 slots on ${machine}`).waitFor()
    const working = popover.getByRole('region', { name: 'Working' })
    await working.getByText('NB-1', { exact: true }).waitFor()
    await working.getByText('widgets · Task Lead').waitFor()
    await working.getByText('1 Run', { exact: true }).waitFor()
    const queued = popover.getByRole('region', { name: 'Queued' })
    await queued.getByText('1st', { exact: true }).waitFor()
    await queued.getByText('NB-2 · Second Task').waitFor()
    await queued.getByText('widgets · None').waitFor()

    await popover.getByRole('button', { name: 'Open in List →' }).click()
    await window.getByRole('heading', { name: 'All Tasks', level: 1 }).waitFor()
    expect(await popover.count()).toBe(0)
  })

  test('with nothing working the popover says so', async () => {
    const window = await launchApp()
    await sidebar(window).getByRole('button', { name: 'Nothing running' }).click()
    const popover = window.getByRole('dialog', { name: 'Working Runs' })
    await popover.getByText('No Runs working. Nothing queued.').waitFor()
    await window.keyboard.press('Escape')
    await popover.waitFor({ state: 'detached' })
  })

  test('S starts the open Backlog Task, and Move to Backlog takes a queued one back', async () => {
    const window = await twoTasksOneSlot()
    await ted('task', 'start', 'NB-1')
    await openAllTasks(window)
    await taskRow(window, 'NB-2').click()
    const header = window.getByRole('region', { name: 'Task thread' }).locator('header')
    await header.getByText('· Not started').waitFor()

    await window.keyboard.press('s')
    await header.getByText('Queued · 1st', { exact: true }).waitFor()

    await header.getByRole('button', { name: 'Task actions' }).click()
    const menu = header.getByRole('menu', { name: 'Task actions' })
    expect(await menu.getByRole('menuitem').first().textContent()).toContain('Move to Backlog')
    await menu.getByRole('menuitem', { name: /^Move to Backlog/ }).click()
    await header.getByText('· Not started').waitFor()
    expect((await (await daemonClient()).getSlots()).queued).toBe(0)
  })

  test('a Factory at its cap shows it in the Board and List header', async () => {
    const parent = path.join(home, 'origin')
    const origin = await makeOriginRepo(parent)
    await commitToOrigin(parent, { '.ted/workflow.yaml': 'version: 1\nmax_working_runs: 1\n' })
    await addFactory(origin, 'NB')
    await ted('task', 'create', '--factory', 'NB', forever())
    const window = await launchApp()
    await sidebar(window).getByRole('button', { name: 'widgets' }).click()
    const board = window.getByRole('region', { name: 'widgets' })
    await board.getByRole('heading', { name: 'widgets', level: 1 }).waitFor()
    expect(await board.getByText('1 of 1 working').count()).toBe(0)

    await ted('task', 'start', 'NB-1')

    await board.getByText('1 of 1 working').waitFor()
    await sidebar(window).getByRole('button', { name: 'List' }).click()
    await window.getByRole('region', { name: 'widgets' }).getByText('1 of 1 working').waitFor()
  })

  test('a nearly full disk shows a warning whose Open Storage shows what uses the space', async () => {
    const free = path.join(home, 'free-bytes')
    await writeFile(free, String(8.2e9))
    const window = await launchApp({ TED_FREE_BYTES_FILE: free })
    await window.getByText('Disk almost full · 8.2 GB free').waitFor()

    await window.getByRole('button', { name: 'Open Storage' }).click()

    const page = window.getByRole('main', { name: 'Storage' })
    await page.getByText(/used under .* · 8\.2 GB free/).waitFor()
    await page.getByRole('group', { name: 'Space used' }).getByText('Store').waitFor()
    await page.getByRole('group', { name: 'Clean up' }).getByText('None to remove').waitFor()
    await page
      .getByRole('region', { name: 'Backups' })
      .getByText(/^Daily · /)
      .waitFor()
  })

  test('Settings · Limits changes the limit and shows what is working now', async () => {
    const window = await twoTasksOneSlot()
    await ted('task', 'start', 'NB-1')
    await ted('task', 'start', 'NB-2')
    await openSettings(window)
    await settingsNav(window).getByRole('button', { name: 'Limits', exact: true }).click()
    await window.getByText('Now: 1 of 1 Runs working · 1 queued').waitFor()

    await window.getByRole('button', { name: 'More working Runs' }).click()

    await window.getByText('Now: 2 of 2 Runs working').waitFor()
    expect((await (await daemonClient()).getSettings()).maxWorkingRuns).toBe(2)
  })
})

describe('Stop and Resume', () => {
  async function workingTask(steps: unknown[], daemonEnv: Record<string, string> = {}) {
    extraEnv = daemonEnv
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    await addFactory(origin, 'NB')
    await ted('task', 'create', '--factory', 'NB', '--start', JSON.stringify({ steps }))
    const window = await launchApp()
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    const thread = window.getByRole('region', { name: 'Task thread' })
    return { thread, header: thread.locator('header') }
  }

  test('the Task actions menu stops the Task, and Send and resume starts a fresh Run', async () => {
    const { thread, header } = await workingTask([{ waitFor: path.join(home, 'never') }])
    await header.getByText('Working', { exact: true }).waitFor()

    await header.getByRole('button', { name: 'Task actions' }).click()
    const menu = header.getByRole('menu', { name: 'Task actions' })
    const first = menu.getByRole('menuitem').first()
    expect(await first.textContent()).toContain('Stop Task')
    expect(await first.getAttribute('aria-describedby')).toBeTruthy()
    await first.click()

    await header.getByText(/^Stopped by you · /).waitFor()
    await header.getByText('· Worktree and Apps kept. 1 Run stopped.').waitFor()
    await header.getByRole('button', { name: 'Task actions' }).click()
    expect(await menu.getByRole('menuitem').first().textContent()).toContain('Resume')
    await header.page().keyboard.press('Escape')
    await header.getByRole('button', { name: 'Resume' }).waitFor()

    const box = thread.getByRole('textbox', { name: 'Comment' })
    await box.fill('Use the swipe actions.')
    await thread.getByRole('button', { name: 'Send and resume' }).click()

    await header.getByText('Working', { exact: true }).waitFor()
    const client = await daemonClient()
    const comments = await client.listComments('NB-1')
    expect(comments.at(-1)?.delivered).toBeDefined()
  })

  test('an idle Task Lead is nudged, then TED asks with Nudge again', async () => {
    const { thread } = await workingTask(
      [
        { say: 'Templates are wired into New Note.' },
        { endTurn: true },
        { everyMessage: [{ say: 'I’ll check the empty template next.' }, { endTurn: true }] },
      ],
      { TED_NUDGE_AFTER_MS: '200' },
    )
    const card = thread.getByRole('region', { name: 'Question' })
    await card.getByText('The Task Lead stopped without saying why').waitFor()
    await card.getByText('“I’ll check the empty template next.”').waitFor()
    await thread
      .getByText('TED nudged the Task Lead: “Continue, or post a Comment if you need the human.”')
      .first()
      .waitFor()

    await card.getByRole('button', { name: 'Nudge again' }).click()

    await thread.getByText('You answered: Nudge again').waitFor()
  })
})

describe('Failed', () => {
  test('a Task Lead that keeps dying shows Failed, the FAILED ask and the sidebar line; Retry starts again', async () => {
    await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ resumeFails: true }))
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    await commitToOrigin(path.join(home, 'origin'), {
      '.ted/workflow.yaml': 'version: 1\norder: [intake, work, merge]\n',
    })
    await addFactory(origin, 'NB')
    await ted(
      'task',
      'create',
      '--factory',
      'NB',
      '--start',
      JSON.stringify({ steps: [{ say: 'Starting.' }, { exit: 1 }] }),
    )
    const client = await daemonClient()
    await expect
      .poll(async () => (await client.listTasks())[0]?.status?.kind, { timeout: 30_000 })
      .toBe('failed')

    const window = await launchApp()
    const sidebar = window.getByRole('navigation')
    await sidebar.getByRole('button', { name: '1 failed' }).click()
    await taskRow(window, 'NB-1').filter({ hasText: 'Failed' }).click()
    const thread = window.getByRole('region', { name: 'Task thread' })
    await thread.getByText('Waiting on you to retry').waitFor()
    await thread.getByText('Resume failed · started a fresh Task Lead Run from the brief').waitFor()
    const card = thread.getByRole('region', { name: 'FAILED' })
    await card.getByText('The Task Lead stopped twice in 30 minutes').waitFor()
    await card.getByText('claude exited with code 1').waitFor()

    await card.getByRole('button', { name: 'Open last Run' }).click()
    await window.getByRole('region', { name: 'Run chat' }).getByText('Starting.').first().waitFor()
    await window.getByRole('tab', { name: 'Thread' }).click()

    await card.getByRole('textbox', { name: 'Your answer' }).fill('Try a smaller change.')
    await card.getByRole('button', { name: 'Retry' }).click()

    await thread.getByText('You retried the Task').waitFor()
    const comments = await client.listComments('NB-1')
    expect(comments.some((c) => c.body === 'Try a smaller change.')).toBe(true)
  }, 90_000)
})

describe('daemon crashes', () => {
  const reconnecting = (window: Page) =>
    window.getByRole('status', { name: 'Reconnecting to TED…' })

  async function killDaemon(): Promise<number> {
    const pid = await daemonPid()
    process.kill(pid, 'SIGKILL')
    await waitForExit(pid)
    return pid
  }

  async function waitForNewDaemon(old: number): Promise<number> {
    await expect
      .poll(
        async () => {
          const info = await readDaemonInfo(home)
          return info !== undefined && info.pid !== old && isAlive(info.pid)
        },
        { timeout: 20_000 },
      )
      .toBe(true)
    return daemonPid()
  }

  test('killing the daemon shows the Reconnecting bar and turns actions off while the Run keeps going; the restarted daemon picks the Run back up', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    await commitToOrigin(path.join(home, 'origin'), {
      '.ted/workflow.yaml': 'version: 1\norder: [intake, work, merge]\n',
    })
    const steps = JSON.stringify({
      steps: [
        { waitFor: path.join(home, 'go') },
        { everyMessage: [{ run: ['ted', 'outcome', 'advance'] }] },
        { run: ['ted', 'outcome', 'advance'] },
      ],
    })
    await addFactory(origin, 'NB')
    await ted('task', 'create', '--factory', 'NB', steps)
    const window = await launchApp({ TED_RESTART_DELAYS_MS: '1500,0,0' })
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    const details = window.getByRole('complementary', { name: 'Task details' })
    await ted('task', 'start', 'NB-1')
    await details.getByText('Intake', { exact: true }).waitFor()
    await expect.poll(async () => (await runHostPids()).length).toBe(2)
    const hosts = await runHostPids()

    const old = await killDaemon()

    await reconnecting(window).waitFor()
    await reconnecting(window)
      .getByText('Runs keep going. Actions are off until TED is back.')
      .waitFor()
    expect(await sidebar(window).getByRole('button', { name: 'All Tasks' }).isDisabled()).toBe(true)
    expect(hosts.every(isAlive)).toBe(true)

    await waitForNewDaemon(old)
    await reconnecting(window).waitFor({ state: 'detached', timeout: 20_000 })
    expect(await sidebar(window).getByRole('button', { name: 'All Tasks' }).isDisabled()).toBe(
      false,
    )
    await writeFile(path.join(home, 'go'), '')
    await details.getByText('Done', { exact: true }).waitFor({ timeout: 20_000 })
  })

  test('after reconnecting, the sidebar shows slots that changed while the app was away', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    await addFactory(origin, 'NB')
    await ted(
      'task',
      'create',
      '--factory',
      'NB',
      JSON.stringify({ steps: [{ waitFor: path.join(home, 'never') }] }),
    )
    const window = await launchApp({ TED_RESTART_DELAYS_MS: '6000,0,0' })
    await ted('task', 'start', 'NB-1')
    const footer = sidebar(window).locator('footer')
    await footer.getByRole('button', { name: /^1 of \d+ Runs working$/ }).waitFor()

    await killDaemon()
    await reconnecting(window).waitFor()
    await startDaemonAsApp()
    await (await daemonClient()).updateSettings({ maxWorkingRuns: 7 })

    await reconnecting(window).waitFor({ state: 'detached', timeout: 20_000 })
    await footer.getByRole('button', { name: '1 of 7 Runs working' }).waitFor()
  })

  test('after reconnecting, the Inbox shows a request raised while the app was away', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    const briefFile = path.join(home, 'brief.md')
    await writeFile(
      briefFile,
      [
        '## Goal\n\nLet notes be edited offline.',
        '## Decisions so far\n\n- Keep both edits on a clash.',
        '## Current state\n\nThe approach is written up.',
        '## Open questions\n\nNone.',
        '## Next step\n\nBuild it.\n',
      ].join('\n\n'),
    )
    const gate = [
      { run: ['ted', 'brief', 'write', '--file', briefFile] },
      { run: ['ted', 'outcome', 'advance'] },
      { endTurn: true },
    ]
    await addFactory(origin, 'NB')
    await ted(
      'task',
      'create',
      '--factory',
      'NB',
      JSON.stringify({ steps: [{ everyMessage: gate }, ...gate] }),
    )
    const window = await launchApp({ TED_RESTART_DELAYS_MS: '8000,0,0' })
    const inbox = window.getByRole('region', { name: 'Inbox' })
    await inbox.waitFor()

    await killDaemon()
    await reconnecting(window).waitFor()
    await ted('task', 'start', 'NB-1')
    await expect
      .poll(async () => (await (await daemonClient()).listInbox()).length, { timeout: 20_000 })
      .toBe(1)

    await reconnecting(window).waitFor({ state: 'detached', timeout: 20_000 })
    await inbox.getByRole('button').filter({ hasText: 'Design review' }).waitFor()
  })

  test('three crashes in ten minutes stop restarts and raise the banner; its menu copies a report and restarts TED', async () => {
    const window = await launchApp({ TED_RESTART_DELAYS_MS: '0,0,0' })
    await app?.evaluate(({ clipboard }) => {
      const record = globalThis as unknown as { copied: string[] }
      record.copied = []
      clipboard.writeText = async (text: string) => {
        record.copied.push(text)
      }
    })
    const recorded = () => app?.evaluate(() => globalThis as unknown as { copied: string[] })

    await waitForNewDaemon(await killDaemon())
    await reconnecting(window).waitFor({ state: 'detached', timeout: 20_000 })
    await waitForNewDaemon(await killDaemon())
    await reconnecting(window).waitFor({ state: 'detached', timeout: 20_000 })
    await expect
      .poll(() => readFile(path.join(home, 'logs', 'daemon.log'), 'utf8').catch(() => ''), {
        timeout: 20_000,
      })
      .toMatch(/TED daemon .* listening on/)
    const last = await killDaemon()

    const banner = window.getByRole('region', { name: 'Problems' }).getByRole('alert')
    await banner.getByText('TED’s background process keeps stopping').waitFor()
    expect(await reconnecting(window).count()).toBe(0)
    expect(await sidebar(window).getByRole('button', { name: 'All Tasks' }).isDisabled()).toBe(true)
    await sleep(500)
    expect(await daemonPid()).toBe(last)

    await banner.getByRole('button', { name: 'Restart' }).click()
    await window.getByRole('menuitem', { name: 'Copy report' }).click()
    await expect.poll(async () => (await recorded())?.copied.length).toBe(1)
    const [report] = (await recorded())?.copied ?? []
    expect(report).toContain('crash report')
    expect(report).toMatch(/TED daemon .* listening on/)
    expect(report).toContain('starting TED’s daemon')

    await banner.getByRole('button', { name: 'Restart' }).click()
    await window.getByRole('menuitem', { name: 'Restart TED in the background' }).click()

    await banner.waitFor({ state: 'detached', timeout: 20_000 })
    await waitForNewDaemon(last)
    await reconnecting(window).waitFor({ state: 'detached', timeout: 20_000 })
    expect(await sidebar(window).getByRole('button', { name: 'All Tasks' }).isDisabled()).toBe(
      false,
    )
  })
})

async function runHostPids(): Promise<number[]> {
  const pids: number[] = []
  for (const id of await readdir(path.join(home, 'runs')).catch(() => [])) {
    const start = (await hostRecords(home, id)).find((r) => r.t === 'start')
    for (const pid of [start?.agentPid, start?.hostPid]) if (typeof pid === 'number') pids.push(pid)
  }
  return pids
}

describe('running in the background', () => {
  async function startRun(steps: unknown[]): Promise<string> {
    const client = await daemonClient()
    const { id } = await client.startDevRun({ prompt: JSON.stringify({ steps }), cwd: home })
    await expect.poll(async () => (await client.getActivity()).runs.active).toBe(1)
    return id
  }

  const never = () => ({ waitFor: path.join(home, 'never') })

  const menuLabels = () =>
    (app as ElectronApplication).evaluate(({ Menu }) => {
      const walk = (menu: Electron.Menu): string[] =>
        menu.items.flatMap((item) => [item.label, ...(item.submenu ? walk(item.submenu) : [])])
      const menu = Menu.getApplicationMenu()
      return menu ? walk(menu) : []
    })

  test('closing the window keeps TED running, and the window still gets updates', async () => {
    const window = await launchApp()
    await openAllTasks(window)

    await app?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
    await ted('task', 'create', 'Fix login')

    expect(await app?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
    await taskRow(window, 'DEV-1').waitFor()
  })

  test('with Keep running remembered, Quit leaves the Run going; with Stop it, Quit ends it all', async () => {
    await launchApp()
    const client = await daemonClient()
    const pid = await daemonPid()
    const electronPid = app?.process().pid ?? 0
    await client.updateSettings({ quitWithWorkRunning: 'keep-running' })
    const runId = await startRun([never()])
    await sleep(300)

    await app?.evaluate(({ app }) => app.quit())
    await sleep(1_000)

    expect(isAlive(electronPid)).toBe(true)
    expect((await client.getRun(runId)).run.state).not.toBe('finished')

    await client.updateSettings({ quitWithWorkRunning: 'stop' })
    await sleep(300)
    await app?.close()
    app = undefined

    await waitForExit(pid)
    expect(isAlive(electronPid)).toBe(false)
    expect((await hostRecords(home, runId)).some((r) => r.t === 'exit')).toBe(true)
  })

  test('the app menu shows what’s waiting and running, and its items open the right place', async () => {
    const window = await launchApp()
    await startRun([{ hook: 'PermissionRequest:Bash' }, never()])

    await expect
      .poll(menuLabels, { timeout: 10_000 })
      .toEqual(
        expect.arrayContaining([
          '1 waiting on you',
          '0 of 1 Run working',
          'Open TED',
          'New Task…',
          'Settings…',
          'Quit TED completely',
        ]),
      )
    if (process.platform === 'linux') {
      expect(
        await app?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle()),
      ).toBe('TED (1)')
    }

    await app?.evaluate(({ Menu }) => {
      const find = (menu: Electron.Menu): Electron.MenuItem | undefined => {
        for (const item of menu.items) {
          const found = item.label === 'Settings…' ? item : item.submenu && find(item.submenu)
          if (found) return found
        }
        return undefined
      }
      const menu = Menu.getApplicationMenu()
      const settings = menu && find(menu)
      settings?.click()
    })

    await window.getByRole('radiogroup', { name: 'Appearance' }).waitFor()
  })

  test('the quit choice is a setting in the app', async () => {
    const window = await launchApp()
    await sidebar(window)
      .getByRole('button', { name: /^Settings/ })
      .last()
      .click()

    await window
      .getByLabel('When you quit with work running')
      .selectOption({ label: 'Keep running in the background' })

    await expect
      .poll(async () => (await daemonClient()).getSettings())
      .toMatchObject({ quitWithWorkRunning: 'keep-running' })
  })

  const switchNamed = (window: Page, name: string) => window.getByRole('switch', { name })
  const startAtLogin = 'Start TED in the background when you log in'
  const stayAwake = 'Stay Awake while Runs are working'
  const loginLog = () => path.join(home, 'login-item.log')
  const loginLines = () =>
    readFile(loginLog(), 'utf8').then(
      (text) => text.split('\n').filter(Boolean),
      () => [],
    )

  test('Start at login and Stay Awake are on by default and switch off in General', async () => {
    const window = await launchApp({ TED_LOGIN_ITEM_LOG: loginLog() })
    await expect.poll(loginLines).toEqual(['on'])
    await openSettings(window)

    const checked = (name: string) => () => switchNamed(window, name).getAttribute('aria-checked')
    await expect.poll(checked(startAtLogin)).toBe('true')
    await expect.poll(checked(stayAwake)).toBe('true')

    await switchNamed(window, startAtLogin).click()
    await switchNamed(window, stayAwake).click()

    await expect
      .poll(async () => (await daemonClient()).getSettings())
      .toMatchObject({ startAtLogin: false, stayAwake: false })
    await expect.poll(loginLines).toEqual(['on', 'off'])
    await expect.poll(checked(startAtLogin)).toBe('false')
  })

  test.skipIf(process.platform !== 'darwin')(
    'when macOS asks for approval, the row says so and opens Login Items',
    async () => {
      const window = await launchApp({
        TED_LOGIN_ITEM_LOG: loginLog(),
        TED_LOGIN_ITEM_STATUS: 'requires-approval',
      })
      await app?.evaluate(({ shell }) => {
        const opened: string[] = []
        Object.assign(globalThis, { opened })
        shell.openExternal = async (url: string) => {
          opened.push(url)
        }
      })
      await openSettings(window)

      await window.getByText('Allow TED in System Settings → Login Items').waitFor()
      await window.getByRole('button', { name: 'Open System Settings' }).click()

      await expect
        .poll(() => app?.evaluate(() => (globalThis as unknown as { opened: string[] }).opened))
        .toEqual(['x-apple.systempreferences:com.apple.LoginItems-Settings.extension'])
    },
  )

  test('started with --background, TED runs with no window', async () => {
    app = await electron.launch({
      executablePath: electronPath,
      args: [appDir, '--background'],
      env: env(),
    })
    await expect.poll(() => readDaemonInfo(home), { timeout: 20_000 }).toBeDefined()
    await expect.poll(menuLabels).toEqual(expect.arrayContaining(['Quit TED completely']))

    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0)
  })

  test('opening TED again while it runs hands over to the running app', async () => {
    await launchApp()
    const electronPid = app?.process().pid ?? 0

    await run(electronPath, [appDir], { env: env(), timeout: 20_000 })

    expect(isAlive(electronPid)).toBe(true)
  })
})

async function pickFolderWith(folder: string): Promise<void> {
  await app?.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [chosen] })) as never
  }, folder)
}

async function githubReady(repos: string[], extra: Record<string, unknown> = {}): Promise<void> {
  const paths: Record<string, unknown> = {}
  for (const repo of repos) {
    paths[`repos/${repo}`] = {
      body: { full_name: repo, default_branch: 'main', permissions: { push: true } },
    }
    paths[`repos/${repo}/commits?per_page=1`] = { body: [] }
  }
  const state = path.join(home, 'gh.json')
  await writeFile(state, JSON.stringify({ paths: { ...paths, ...extra } }))
  extraEnv = {
    ...extraEnv,
    TED_STUB_GH: state,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.file://${path.join(home, 'origin')}/.insteadOf`,
    GIT_CONFIG_VALUE_0: 'https://github.com/',
  }
}

async function channelsOf(pid: number): Promise<string[]> {
  const dir = `/proc/${pid}/fd`
  const targets = await Promise.all(
    (await readdir(dir)).map((fd) => readlink(path.join(dir, fd)).catch(() => '')),
  )
  return targets.filter((target) => /^(pipe|socket):/.test(target))
}

describe('Inbox and Gates', () => {
  test('a design review waits in the Inbox; Request changes keeps the Stage and Approve moves on', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    const briefFile = path.join(home, 'brief.md')
    await writeFile(
      briefFile,
      [
        '## Goal\n\nLet notes be edited offline.',
        '## Decisions so far\n\n- Keep both edits on a clash.',
        '## Current state\n\nThe approach is written up.',
        '## Open questions\n\nNone.',
        '## Next step\n\nBuild it.\n',
      ].join('\n\n'),
    )
    const gate = [
      { run: ['ted', 'brief', 'write', '--file', briefFile] },
      { run: ['ted', 'outcome', 'advance'] },
      { endTurn: true },
    ]
    await addFactory(origin, 'NB')
    await ted(
      'task',
      'create',
      '--factory',
      'NB',
      JSON.stringify({ steps: [{ everyMessage: gate }, ...gate] }),
    )
    const window = await launchApp()
    await ted('task', 'start', 'NB-1')

    const inbox = window.getByRole('region', { name: 'Inbox' })
    const row = inbox.getByRole('button').filter({ hasText: 'Design review' })
    await row.waitFor()
    expect(await row.textContent()).toContain('Let notes be edited offline.')
    await sidebar(window)
      .getByRole('button', { name: /^Inbox/ })
      .getByText('1')
      .waitFor()
    await row.click()

    const thread = window.getByRole('region', { name: 'Task thread' })
    const card = thread.getByRole('region', { name: 'Design review', exact: true })
    await card.getByText('Let notes be edited offline.', { exact: true }).waitFor()
    await thread.getByText('Waiting on you', { exact: true }).waitFor()
    expect(await card.getByRole('button', { name: 'Request changes' }).isDisabled()).toBe(true)
    await card.getByRole('textbox', { name: 'Your answer' }).fill('Split the sync step in two.')
    await card.getByRole('button', { name: 'Request changes' }).click()

    const answered = thread.getByRole('region', { name: 'Design review, answered' }).first()
    await answered.getByText('You requested changes').waitFor()
    await answered.getByText('“Split the sync step in two.”').waitFor()
    await card.getByRole('button', { name: 'Approve' }).click()

    const details = window.getByRole('complementary', { name: 'Task details' })
    await details.getByText('Review', { exact: true }).waitFor()
    const signoff = inbox.getByRole('button').filter({ hasText: 'Sign-off' })
    await signoff.waitFor()
    await signoff.click()
    await thread
      .getByRole('region', { name: 'Sign-off', exact: true })
      .getByRole('button', { name: 'Approve and merge' })
      .waitFor()
  })

  test('a Clarify round shows recommended answers, marks a changed one, and Submit answers sends them', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    const roundFile = path.join(home, 'round.json')
    await writeFile(
      roundFile,
      JSON.stringify({
        title: 'Conflicts and sync · 2 questions',
        summary: 'Each question has my recommended answer filled in.',
        questions: [
          {
            question: 'When a note is edited on two devices offline, what happens?',
            choices: ['Keep both and let me merge', 'Keep the latest edit'],
            recommended: 'Keep both and let me merge',
          },
          {
            question: 'If a note is deleted on one device and edited on the other, which wins?',
            recommended: 'The edit wins.',
          },
        ],
      }),
    )
    await addFactory(origin, 'NB')
    await ted(
      'task',
      'create',
      '--factory',
      'NB',
      JSON.stringify({
        steps: [
          { run: ['ted', 'outcome', 'advance'] },
          { run: ['ted', 'clarify', 'depth', 'few', 'two small questions'] },
          { run: ['ted', 'ask', '--round', roundFile] },
          { endTurn: true },
        ],
      }),
    )
    const window = await launchApp()
    await ted('task', 'start', 'NB-1')

    const inbox = window.getByRole('region', { name: 'Inbox' })
    const row = inbox.getByRole('button').filter({ hasText: 'Clarify round' })
    await row.waitFor()
    await row.click()

    const thread = window.getByRole('region', { name: 'Task thread' })
    const card = thread.getByRole('region', { name: 'Clarify round', exact: true })
    await card.getByText('Conflicts and sync · 2 questions').waitFor()
    const first = card.getByRole('group', { name: /^1\./ })
    expect(await first.getByRole('radio', { name: /Keep both and let me merge/ }).isChecked()).toBe(
      true,
    )
    expect(await card.getByText('Recommended', { exact: true }).count()).toBe(2)
    expect(await card.getByRole('button', { name: 'Talk it through' }).isDisabled()).toBe(true)
    await first.getByText('Keep the latest edit').click()
    await first.getByText('Changed ·').waitFor()
    await first.getByRole('button', { name: 'Reset' }).click()
    expect(await first.getByText('Changed ·').count()).toBe(0)
    await first.getByText('Keep the latest edit').click()
    await card.getByRole('textbox', { name: 'Add to answer 1' }).fill('Clashes are rare.')
    await card.getByRole('button', { name: 'Submit answers' }).click()

    const answered = thread.getByRole('region', { name: 'Clarify round, answered' })
    await answered.getByText('You answered · 1 recommended, 1 changed').waitFor()
    expect(await answered.getByRole('listitem').allTextContents()).toEqual([
      '1.Keep the latest edit · Clashes are rare.changed',
      '2.The edit wins.recommended',
    ])
    const details = window.getByRole('complementary', { name: 'Task details' })
    await details.getByText('Few · by the Task Lead').waitFor()
    await thread.getByText('Task Lead picked Clarify depth: Few · two small questions').waitFor()
  })

  test('the grilling sign-off lists Decisions so far, the open questions and what each button does', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    const briefFile = path.join(home, 'brief.md')
    await writeFile(
      briefFile,
      [
        '## Goal\n\nWhat we decided for offline editing',
        '## Decisions so far\n\n- Notes save locally first.\n- Warn after 30 days offline.',
        '## Current state\n\nNothing built.',
        '## Open questions\n\nNone.',
        '## Next step\n\nDesign the merge view.\n',
      ].join('\n\n'),
    )
    await addFactory(origin, 'NB')
    await ted(
      'task',
      'create',
      '--factory',
      'NB',
      JSON.stringify({
        steps: [
          { run: ['ted', 'outcome', 'advance'] },
          { run: ['ted', 'clarify', 'depth', 'grilling', 'sync touches both repos'] },
          { run: ['ted', 'brief', 'write', '--file', briefFile] },
          { run: ['ted', 'outcome', 'advance'] },
          { endTurn: true },
        ],
      }),
    )
    const window = await launchApp()
    await ted('task', 'start', 'NB-1')

    const row = window
      .getByRole('region', { name: 'Inbox' })
      .getByRole('button')
      .filter({ hasText: 'Sign-off' })
    await row.waitFor()
    await row.click()
    const card = window
      .getByRole('region', { name: 'Task thread' })
      .getByRole('region', { name: 'Sign-off', exact: true })
    const decisions = card.getByRole('region', { name: 'Decisions so far' })
    expect(await decisions.getByRole('listitem').allTextContents()).toEqual([
      'Notes save locally first.',
      'Warn after 30 days offline.',
    ])
    await card.getByText('Open questions: None.').waitFor()
    await card
      .getByText('Approve moves the Task on. Request changes starts another round.')
      .waitFor()

    await window.getByRole('button', { name: 'Task actions' }).click()
    const menu = window.getByRole('menu', { name: 'Task actions' })
    await menu.getByRole('menuitem', { name: /Clarify depth/ }).hover()
    await menu.getByRole('menuitemradio', { name: 'Few' }).click()
    const details = window.getByRole('complementary', { name: 'Task details' })
    await details.getByText('Few · set by you').waitFor()
  })

  test('two open requests show “2 waiting on you”; chips and the Inbox pick the pinned card', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    await addFactory(origin, 'NB')
    await ted(
      'task',
      'create',
      '--factory',
      'NB',
      JSON.stringify({
        steps: [
          {
            run: [
              'ted',
              'outcome',
              'ask',
              '--choice',
              'In the note’s header',
              'Where should the sync status show?',
            ],
          },
          { run: ['ted', 'comment', '--choice', 'Yes', 'Can the queue retry offline?'] },
          { endTurn: true },
        ],
      }),
    )
    const window = await launchApp()
    await ted('task', 'start', 'NB-1')

    const inbox = window.getByRole('region', { name: 'Inbox' })
    const second = inbox
      .getByRole('button')
      .filter({ has: window.getByText('Can the queue retry offline?', { exact: true }) })
    await second.waitFor()
    await second.click()

    const thread = window.getByRole('region', { name: 'Task thread' })
    const pinned = thread.getByRole('region', { name: 'Question', exact: true })
    await pinned.getByText('Can the queue retry offline?').waitFor()
    const waiting = thread.getByRole('group', { name: '2 waiting on you' })
    await waiting.getByText('2 waiting on you').waitFor()
    const chips = waiting.getByRole('button')
    expect(await chips.allTextContents()).toEqual(['Question · now', 'Question · now'])
    expect(await chips.nth(1).getAttribute('aria-pressed')).toBe('true')

    const lines = thread.getByRole('button', { name: /^Question from the Task Lead · waiting/ })
    await expect.poll(() => lines.count()).toBe(2)
    expect(await lines.nth(1).textContent()).toContain('shown below')

    await chips.nth(0).click()
    await pinned.getByText('Where should the sync status show?').waitFor()
    expect(await chips.nth(0).getAttribute('aria-pressed')).toBe('true')
    expect(await thread.getByRole('region', { name: 'Question', exact: true }).count()).toBe(1)
  })

  test('answered and superseded requests collapse to grey cards; Show request opens the card read-only', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    await addFactory(origin, 'NB')
    const supersede =
      'id=$(ted outcome ask "Should an empty search show recent notes or nothing?" | sed -n "s/.*(request \\([^)]*\\)).*/\\1/p"); ted ask --supersedes "$id" --choice "The 5 most recent notes" --choice "A hint" "Empty search: show the 5 most recent notes, or a hint?"'
    await ted(
      'task',
      'create',
      '--factory',
      'NB',
      JSON.stringify({ steps: [{ run: ['sh', '-c', supersede] }, { endTurn: true }] }),
    )
    const window = await launchApp()
    await ted('task', 'start', 'NB-1')

    const inbox = window.getByRole('region', { name: 'Inbox' })
    const headline = (text: string) =>
      inbox.getByRole('button').filter({ has: window.getByText(text, { exact: true }) })
    const row = headline('Empty search: show the 5 most recent notes, or a hint?')
    await row.waitFor()
    expect(await inbox.getByRole('listitem').count()).toBe(1)
    await row.click()

    const thread = window.getByRole('region', { name: 'Task thread' })
    const superseded = thread.getByRole('region', { name: 'Question, superseded' })
    await superseded.getByText('Superseded by a newer question from the Task Lead').waitFor()
    expect(await thread.getByRole('group', { name: /waiting on you/ }).count()).toBe(0)

    const pinned = thread.getByRole('region', { name: 'Question', exact: true })
    await pinned.getByRole('button', { name: 'The 5 most recent notes' }).click()

    const answered = thread.getByRole('region', { name: 'Question, answered' })
    await answered.getByText('You answered: The 5 most recent notes').waitFor()
    await expect.poll(() => pinned.count()).toBe(0)

    await answered.getByRole('button', { name: 'Show request' }).click()
    const full = answered.getByRole('region', { name: 'Question, read-only' })
    await full.getByText('Empty search: show the 5 most recent notes, or a hint?').waitFor()
    expect(await full.getByRole('textbox').count()).toBe(0)
    expect(await full.getByRole('button', { name: 'A hint' }).isDisabled()).toBe(true)
    await answered.getByRole('button', { name: 'Hide request' }).click()
    await expect.poll(() => full.count()).toBe(0)
  })
})

describe('Permission requests', () => {
  test('a permission prompt is a card with the command; Deny and Approve collapse it with the answer line', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    await addFactory(origin, 'NB')
    const ask = (command: string, description: string) => ({
      permission: { tool: 'Bash', input: { command, description }, description },
    })
    await ted(
      'task',
      'create',
      '--factory',
      'NB',
      JSON.stringify({
        steps: [
          ask('curl -s https://registry.example.dev/install.sh | sh', 'Install the CRDT tool'),
          ask('npm install --save yjs@13.6.27', 'Install the CRDT library'),
          { endTurn: true },
        ],
      }),
    )
    const window = await launchApp()
    await ted('task', 'start', 'NB-1')

    const inbox = window.getByRole('region', { name: 'Inbox' })
    const row = inbox.getByRole('button').filter({ hasText: 'Permission' })
    await row.waitFor()
    await row.click()

    const thread = window.getByRole('region', { name: 'Task thread' })
    const card = thread.getByRole('region', { name: 'Permission', exact: true })
    await card.getByText('Run a command', { exact: true }).waitFor()
    await card.getByText('Install the CRDT tool').waitFor()
    await card
      .getByText(/\$ curl -s https:\/\/registry\.example\.dev\/install\.sh \| sh$/)
      .waitFor()
    await thread.getByText('The Task Lead is waiting on your permission').waitFor()
    await card.getByRole('textbox', { name: 'Your answer' }).fill('Use npm, not an install script.')
    await card.getByRole('button', { name: 'Deny' }).click()

    const denied = thread.getByRole('region', { name: 'Permission, answered' }).first()
    await denied.getByText('You denied').waitFor()
    await denied.getByText('“Use npm, not an install script.”').waitFor()
    await denied.getByText('curl -s https://registry.example.dev/install.sh | sh').waitFor()

    await card.getByText(/npm install --save yjs@13\.6\.27$/).waitFor()
    const details = window.getByRole('complementary', { name: 'Task details' })
    await details.getByRole('button', { name: /Task Lead/ }).click()
    const chat = window.getByRole('region', { name: 'Run chat' })
    await chat.getByText(/You denied · /).waitFor()
    await chat.getByRole('button', { name: 'Approve' }).click()
    await chat.getByText(/You approved · /).waitFor()

    await window.getByRole('tab', { name: 'Thread' }).click()
    await thread.getByText('You approved · this request only').waitFor()
    await expect.poll(() => card.count()).toBe(0)
  })
})

describe('List and All Tasks', () => {
  const forever = () => JSON.stringify({ steps: [{ waitFor: path.join(home, 'never') }] })

  async function twoFactories(): Promise<void> {
    for (const [name, key] of [
      ['notebook', 'NB'],
      ['site', 'MS'],
    ] as const) {
      const parent = path.join(home, 'origins', name)
      const made = await makeOriginRepo(parent)
      const origin = path.join(path.dirname(made), `${name}.git`)
      await rename(made, origin)
      await addFactory(origin, key)
    }
  }

  const rowIds = (window: Page) =>
    window
      .getByRole('main')
      .locator('tbody tr[data-task]')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-task')))

  test('grouping, sort, columns and filters change the List and are remembered per scope', async () => {
    await twoFactories()
    const window = await launchApp()
    const client = await daemonClient()
    await client.createTask({ factory: 'NB', priority: 'low', title: 'Export notes' })
    await client.createTask({ factory: 'NB', priority: 'high', title: 'Sync notes' })
    await client.createTask({ factory: 'MS', title: 'Pricing page' })
    await openAllTasks(window)
    const main = window.getByRole('main')
    await main.getByRole('button', { name: 'notebook' }).waitFor()
    await main.getByRole('button', { name: 'site' }).waitFor()
    expect(await rowIds(window)).toEqual(['NB-2', 'NB-1', 'MS-1'])
    await main.getByRole('columnheader', { name: 'Factory' }).waitFor()

    await main.getByRole('button', { name: 'Display' }).click()
    await main.getByRole('menuitem', { name: /^Manual/ }).hover()
    await main.getByRole('menuitemradio', { name: 'Title' }).click()
    await main.getByRole('menuitem', { name: 'Factory' }).hover()
    await main.getByRole('menuitemradio', { name: 'None' }).click()
    await main.getByRole('menuitemcheckbox', { name: 'Created by' }).click()
    await window.keyboard.press('Escape')
    await main.getByRole('columnheader', { name: 'Created by' }).waitFor()
    expect(await rowIds(window)).toEqual(['NB-1', 'MS-1', 'NB-2'])

    await main.getByRole('button', { name: 'Filter' }).click()
    await main.getByRole('menuitem', { name: 'Priority' }).hover()
    await main.getByRole('menuitemcheckbox', { name: /High/ }).click()
    await window.keyboard.press('Escape')
    await main.getByText('Priority is High').waitFor()
    expect(await rowIds(window)).toEqual(['NB-2'])

    await sidebar(window).getByRole('button', { name: 'notebook' }).click()
    await sidebar(window).getByRole('button', { name: 'List', exact: true }).click()
    await main.getByRole('button', { name: 'Backlog' }).waitFor()
    expect(await rowIds(window)).toEqual(['NB-2', 'NB-1'])

    await window.keyboard.press('/')
    await window.keyboard.type('export')
    expect(await rowIds(window)).toEqual(['NB-1'])

    const views = (await client.getSettings()).listViews
    expect(views.all).toMatchObject({
      sort: 'title',
      group: 'none',
      filters: { priorities: ['high'] },
    })
    expect(views.all?.columns).toContain('created-by')
    await app?.close()
    const again = await launchApp()
    await openAllTasks(again)
    await again.getByRole('main').getByText('Priority is High').waitFor()
  })

  test('Open in List shows the machine-wide queue, and dragging there reorders it', async () => {
    await twoFactories()
    await ted('task', 'create', '--factory', 'NB', forever())
    await ted('task', 'create', '--factory', 'NB', 'Notebook covers')
    await ted('task', 'create', '--factory', 'MS', 'Blog post template')
    const window = await launchApp()
    const client = await daemonClient()
    await client.updateSettings({ maxWorkingRuns: 1 })
    for (const id of ['NB-1', 'NB-2', 'MS-1']) await ted('task', 'start', id)

    await sidebar(window)
      .getByRole('button', { name: /1 queued|2 queued/ })
      .click()
    await window.getByRole('button', { name: 'Open in List →' }).click()
    const main = window.getByRole('main')
    await main.getByText('machine-wide queue, in start order').waitFor()
    await main.getByRole('columnheader', { name: 'Queue' }).waitFor()
    await main.locator('tr[data-task="MS-1"]').getByText('2nd', { exact: true }).waitFor()
    expect(await rowIds(window)).toEqual(['NB-2', 'MS-1'])

    await main
      .locator('tr[data-task="MS-1"]')
      .dragTo(main.locator('tr[data-task="NB-2"]'), { targetPosition: { x: 400, y: 4 } })

    await main.locator('tr[data-task="MS-1"]').getByText('1st', { exact: true }).waitFor()
    expect((await client.getSlots()).queue.map((q) => q.displayId)).toEqual(['MS-1', 'NB-2'])

    await main.getByRole('button', { name: 'Clear Status is Queued' }).click()
    await main.getByText('machine-wide queue, in start order').waitFor({ state: 'detached' })
    expect(await main.getByRole('columnheader', { name: 'Queue' }).count()).toBe(0)
  })

  test('multi-select starts, sets Priority on and archives Tasks of different Factories', async () => {
    await twoFactories()
    await ted('task', 'create', '--factory', 'NB', 'Export notes')
    await ted('task', 'create', '--factory', 'MS', 'Pricing page')
    await ted('task', 'create', '--factory', 'MS', 'Case studies')
    const window = await launchApp()
    const client = await daemonClient()
    await client.updateSettings({ maxWorkingRuns: 1 })
    await ted('task', 'start', 'MS-2')
    await openAllTasks(window)
    const main = window.getByRole('main')

    await taskRow(window, 'NB-1').click({ modifiers: ['Meta'] })
    await taskRow(window, 'MS-1').click({ modifiers: ['Meta'] })
    const bar = main.getByRole('toolbar', { name: 'Selected Tasks' })
    await bar.getByText('2 selected').waitFor()

    await bar.getByRole('button', { name: 'Priority' }).click()
    await bar.getByRole('menuitem', { name: 'Urgent' }).click()
    await waitFor(async () => {
      const tasks = await client.listTasks()
      return ['NB-1', 'MS-1'].every(
        (id) => tasks.find((t) => t.displayId === id)?.priority === 'urgent',
      )
    })

    await bar.getByRole('button', { name: 'Start' }).click()
    await waitFor(async () =>
      (await client.listTasks())
        .filter((t) => ['NB-1', 'MS-1'].includes(t.displayId))
        .every((t) => t.stage !== 'backlog'),
    )

    await bar.getByRole('button', { name: 'Archive' }).click()
    await bar.getByRole('button', { name: 'Archive 2 Tasks' }).click()
    await waitFor(async () =>
      (await client.listTasks())
        .filter((t) => ['NB-1', 'MS-1'].includes(t.displayId))
        .every((t) => t.archived !== undefined),
    )
    await expect.poll(() => rowIds(window)).toEqual(['MS-2'])

    await main.getByRole('button', { name: 'Filter' }).click()
    await main.getByRole('menuitemradio', { name: 'Only' }).click()
    await window.keyboard.press('Escape')
    await main.getByRole('columnheader', { name: 'Archived' }).waitFor()
    expect((await rowIds(window)).sort()).toEqual(['MS-1', 'NB-1'])
    await main.locator('tr[data-task="NB-1"]').getByText('Archived', { exact: true }).waitFor()
  })
})

describe('Board', () => {
  const forever = () => JSON.stringify({ steps: [{ waitFor: path.join(home, 'never') }] })

  async function boardOf(workflow?: string): Promise<Page> {
    const parent = path.join(home, 'origin')
    const origin = await makeOriginRepo(parent)
    if (workflow !== undefined) await commitToOrigin(parent, { '.ted/workflow.yaml': workflow })
    await addFactory(origin, 'NB')
    return launchApp()
  }

  async function openBoard(window: Page) {
    await sidebar(window).getByRole('button', { name: 'widgets' }).click()
    const board = window.getByRole('region', { name: 'widgets' })
    await board.getByRole('region', { name: 'Backlog' }).waitFor()
    return board
  }

  const cardIds = (column: ReturnType<Page['getByRole']>) =>
    column
      .locator('[data-task]')
      .evaluateAll((cards) => cards.map((card) => card.getAttribute('data-task')))

  const columnNames = (board: ReturnType<Page['getByRole']>) =>
    board
      .locator('[data-stage]')
      .evaluateAll((columns) => columns.map((column) => column.getAttribute('aria-label')))

  test('columns follow the Factory’s Workflow, with Gated Stages marked', async () => {
    const window = await boardOf(
      'version: 1\norder: [intake, work, review]\nstages:\n  review: { gate: true }\n',
    )
    const board = await openBoard(window)

    await waitFor(async () => (await columnNames(board)).length === 5)
    expect(await columnNames(board)).toEqual(['Backlog', 'Intake', 'Work', 'Review', 'Done'])
    await board.getByRole('region', { name: 'Review' }).getByText('Gate').waitFor()
    expect(await board.getByRole('region', { name: 'Work' }).getByText('Gate').count()).toBe(0)
    await board.getByRole('heading', { name: /widgets\s*\/\s*Board/ }).waitFor()
    await board.getByRole('button', { name: 'Filter' }).waitFor()
    await board.getByRole('button', { name: 'Plan' }).waitFor()
  })

  test('dragging Backlog → Intake starts a Task, Queued → Backlog un-starts it, other drops are refused', async () => {
    const window = await boardOf()
    const client = await daemonClient()
    await client.updateSettings({ maxWorkingRuns: 1 })
    await ted('task', 'create', '--factory', 'NB', forever())
    await ted('task', 'create', '--factory', 'NB', 'Export notes')
    await ted('task', 'start', 'NB-1')
    const board = await openBoard(window)
    const backlog = board.getByRole('region', { name: 'Backlog' })
    const intake = board.getByRole('region', { name: 'Intake' })
    await backlog.locator('[data-task="NB-2"]').waitFor()

    await backlog.locator('[data-task="NB-2"]').dragTo(board.getByRole('region', { name: 'Work' }))
    await sleep(300)
    expect((await client.listTasks()).find((t) => t.displayId === 'NB-2')?.stage).toBe('backlog')

    await backlog.locator('[data-task="NB-2"]').dragTo(intake)
    await intake.locator('[data-task="NB-2"]').getByText('Queued · 1st').waitFor()
    await intake.locator('[data-task="NB-2"]').getByText('Waiting for a free Run slot').waitFor()

    await intake.locator('[data-task="NB-2"]').dragTo(backlog)
    await backlog.locator('[data-task="NB-2"]').waitFor()
    expect((await client.getSlots()).queued).toBe(0)
  })

  test('the drag shows the drop slot in Intake and dims the columns it can’t go to', async () => {
    const window = await boardOf()
    await ted('task', 'create', '--factory', 'NB', 'Export notes')
    const board = await openBoard(window)
    const card = board.getByRole('region', { name: 'Backlog' }).locator('[data-task="NB-1"]')
    await card.waitFor()

    await card.hover()
    await window.mouse.down()
    const intake = board.getByRole('region', { name: 'Intake' })
    const box = await intake.boundingBox()
    if (!box) throw new Error('no Intake column')
    await window.mouse.move(box.x + 100, box.y + 60, { steps: 5 })
    await window.mouse.move(box.x + 110, box.y + 70, { steps: 5 })

    await intake.getByText('Drop to Start').waitFor()
    await intake.getByText('Joins the queue as Queued · 1st').waitFor()
    expect(await board.getByRole('region', { name: 'Work' }).getAttribute('data-drop')).toBe('no')
    await window.mouse.up()
  })

  test('dragging up a column changes rank, and across Priority groups the Priority', async () => {
    const window = await boardOf()
    const client = await daemonClient()
    await client.createTask({ factory: 'NB', priority: 'high', title: 'Sync notes' })
    await client.createTask({ factory: 'NB', title: 'Export notes' })
    await client.createTask({ factory: 'NB', title: 'Note history' })
    const board = await openBoard(window)
    const backlog = board.getByRole('region', { name: 'Backlog' })
    await waitFor(async () => (await cardIds(backlog)).length === 3)
    expect(await cardIds(backlog)).toEqual(['NB-1', 'NB-2', 'NB-3'])

    await backlog
      .locator('[data-task="NB-3"]')
      .dragTo(backlog.locator('[data-task="NB-2"]'), { targetPosition: { x: 40, y: 4 } })
    await waitFor(async () => (await cardIds(backlog)).join() === 'NB-1,NB-3,NB-2')
    expect((await client.listTasks()).find((t) => t.displayId === 'NB-3')?.priority).toBe('none')

    await backlog
      .locator('[data-task="NB-2"]')
      .dragTo(backlog.locator('[data-task="NB-1"]'), { targetPosition: { x: 40, y: 4 } })
    await waitFor(async () => (await cardIds(backlog)).join() === 'NB-2,NB-1,NB-3')
    expect((await client.listTasks()).find((t) => t.displayId === 'NB-2')?.priority).toBe('high')
  })

  test('Start on a Backlog card starts it; a blocked card has no Start; Filter narrows the cards', async () => {
    const window = await boardOf()
    const client = await daemonClient()
    await client.createTask({ factory: 'NB', priority: 'high', title: 'Sync notes' })
    await client.createTask({ factory: 'NB', title: 'Export notes', blockedBy: ['NB-1'] })
    const board = await openBoard(window)
    const backlog = board.getByRole('region', { name: 'Backlog' })
    await backlog.locator('[data-task="NB-2"]').getByText('Starts when NB-1 merges').waitFor()
    expect(await backlog.getByRole('button', { name: 'Start NB-2' }).count()).toBe(0)

    await board.getByRole('button', { name: 'Filter' }).click()
    expect(await board.getByRole('menuitem', { name: 'Stage' }).count()).toBe(0)
    expect(await board.getByRole('menuitemradio', { name: 'Only' }).count()).toBe(0)
    await board.getByRole('menuitem', { name: 'Priority' }).hover()
    await board.getByRole('menuitemcheckbox', { name: /High/ }).click()
    await window.keyboard.press('Escape')
    await waitFor(async () => (await cardIds(backlog)).join() === 'NB-1')

    await backlog.getByRole('button', { name: 'Start NB-1' }).click()
    await board.getByRole('region', { name: 'Intake' }).locator('[data-task="NB-1"]').waitFor()
  })
})

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition never held')
    await sleep(100)
  }
}
