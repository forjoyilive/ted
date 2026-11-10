import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { type ElectronApplication, _electron as electron, type Page } from 'playwright'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { daemonAsApp, makeOriginRepo, removeHome, stopDaemonIn } from '../../daemon/test/helpers.ts'
import { inboxNotice } from '../src/background.ts'
import { buildRenderer } from './build-renderer.ts'
import { closeApp } from './close-app.ts'
import { loadedWindow } from './first-window.ts'

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

beforeAll(async () => {
  await buildRenderer()
})

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'ted-app-notify-'))
})

afterEach(async () => {
  await closeApp(app)
  app = undefined
  await stopDaemonIn(home)
  await removeHome(home)
}, 30_000)

const notifyLog = () => path.join(home, 'notify.log')

const env = (extra: Record<string, string> = {}) => ({
  ...process.env,
  TED_HOME: home,
  TED_IDLE_EXIT_MS: '30000',
  TED_CLAUDE_BIN: stubClaudePath,
  TED_HIDDEN_WINDOW: '1',
  TED_NOTIFY_LOG: notifyLog(),
  ...extra,
})

type Logged =
  | { kind: 'notification'; title: string; body: string; silent: boolean }
  | { kind: 'closed'; title: string; body: string }
  | { kind: 'badge'; count: number }

async function logged(): Promise<Logged[]> {
  const text = await readFile(notifyLog(), 'utf8').catch(() => '')
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Logged)
}

const bodies = async () =>
  (await logged()).flatMap((l) => (l.kind === 'notification' ? [l.body] : []))
const lastBadge = async () => (await logged()).filter((l) => l.kind === 'badge').at(-1)

async function launchApp(extra: Record<string, string> = {}): Promise<Page> {
  app = await electron.launch({ executablePath: electronPath, args: [appDir], env: env(extra) })
  const window = await loadedWindow(app)
  return window
}

const sidebar = (window: Page) => window.getByRole('navigation', { name: 'Sidebar' })
const inboxCount = (window: Page) =>
  sidebar(window)
    .getByRole('button', { name: /^Inbox/ })
    .first()
    .textContent()

function ted(...args: string[]) {
  return run(process.execPath, [cliPath, ...args], { env: env() })
}

const ask = (question: string) => ({ run: ['ted', 'comment', '--choice', 'Yes', question] })

async function askingTask(): Promise<void> {
  const origin = await makeOriginRepo(path.join(home, 'origin'))
  const ted0 = await daemonAsApp(home, env())
  await ted0.addFactory({ repo: origin, key: 'NB' })
  const steps = JSON.stringify({
    steps: [
      ask('Q1'),
      { waitFor: path.join(home, 'more') },
      ask('Q2'),
      ask('Q3'),
      ask('Q4'),
      ask('Q5'),
      { waitFor: path.join(home, 'never') },
    ],
  })
  await ted('task', 'create', '--factory', 'NB', steps)
}

describe('notifications and badges', () => {
  test('a new Inbox item notifies once; a burst folds; the badge and sidebar agree', async () => {
    await askingTask()
    const window = await launchApp()
    await expect.poll(lastBadge).toEqual({ kind: 'badge', count: 0 })

    await ted('task', 'start', 'NB-1')
    await expect.poll(bodies, { timeout: 30_000 }).toEqual(['Question: Q1'])
    const [first] = (await logged()).filter((l) => l.kind === 'notification')
    expect(first).toMatchObject({ title: expect.stringMatching(/^NB-1 /), silent: true })
    await expect.poll(lastBadge).toEqual({ kind: 'badge', count: 1 })
    await expect.poll(() => inboxCount(window)).toBe('Inbox1')

    await writeFile(path.join(home, 'more'), '')
    await expect.poll(lastBadge, { timeout: 30_000 }).toEqual({ kind: 'badge', count: 5 })
    await expect.poll(() => inboxCount(window)).toBe('Inbox5')
    const shown = await bodies()
    expect(shown.slice(0, 3)).toEqual(['Question: Q1', 'Question: Q2', 'Question: Q3'])
    expect(shown.at(-1)).toBe('5 new items in your Inbox')
    const closed = (await logged()).flatMap((l) => (l.kind === 'closed' ? [l.body] : []))
    expect(closed).toEqual(expect.arrayContaining(['Question: Q1', 'Question: Q2', 'Question: Q3']))
  })

  test('a Task notification opens its selected request in the Inbox from All Tasks', async () => {
    await askingTask()
    const window = await launchApp()
    await sidebar(window).getByRole('button', { name: 'All Tasks', exact: true }).click()
    await ted('task', 'start', 'NB-1')
    await expect.poll(bodies, { timeout: 30_000 }).toEqual(['Question: Q1'])
    const client = await daemonAsApp(home, env())
    const request = (await client.listWaiting())[0]
    if (!request) throw new Error('Expected a waiting request')
    const command = inboxNotice(request).opens
    await app?.evaluate(({ BrowserWindow }, command) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('ted:event', {
        type: 'menu-command',
        command,
      })
    }, command)
    await window.getByRole('region', { name: 'Inbox', exact: true }).waitFor()
    await window.locator('[aria-current="true"]').filter({ hasText: 'Q1' }).waitFor()
    expect(await window.getByRole('button', { name: '← All Tasks', exact: true }).count()).toBe(0)
  })
})
