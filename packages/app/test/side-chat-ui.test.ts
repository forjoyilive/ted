import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Task } from '@ted/protocol'
import { type ElectronApplication, _electron as electron } from 'playwright'
import { afterEach, beforeAll, expect, test } from 'vitest'
import {
  api,
  commitToOrigin,
  daemonAsApp,
  killRunHosts,
  makeOriginRepo,
  removeHome,
  stopDaemonIn,
  testAppToken,
  waitUntil,
} from '../../daemon/test/helpers.ts'
import { buildRenderer } from './build-renderer.ts'
import { closeApp } from './close-app.ts'
import { loadedWindow } from './first-window.ts'
import { resolveElectron } from './support/electron-installation.ts'

let home: string
let app: ElectronApplication | undefined
const appDir = fileURLToPath(new URL('..', import.meta.url))
const executablePath = resolveElectron()
beforeAll(async () => {
  await buildRenderer()
})
afterEach(async () => {
  const [ended, endedHome] = [app, home]
  app = undefined
  await closeApp(ended)
  await stopDaemonIn(endedHome)
  await killRunHosts(endedHome)
  await removeHome(endedHome)
}, 60_000)
test('side chat shows beside the original Run, reopens its replies and fits a narrow pane', async () => {
  home = await mkdtemp(path.join(tmpdir(), 'ted-side-chat-ui-'))
  const env = {
    ...process.env,
    TED_HOME: home,
    TED_HIDDEN_WINDOW: '1',
    TED_CLAUDE_BIN: fileURLToPath(
      new URL('../../daemon/test/fixtures/stub-claude.ts', import.meta.url),
    ),
  }
  const client = await daemonAsApp(home, env)
  const origin = await makeOriginRepo(path.join(home, 'origin'))
  await commitToOrigin(path.join(home, 'origin'), {
    '.ted/workflow.yaml': 'version: 1\norder: [intake, work, merge]\n',
  })
  const { port } = JSON.parse(await readFile(path.join(home, 'daemon.json'), 'utf8')) as {
    port: number
  }
  const signed = api(port, { appKey: testAppToken })
  await signed.call('POST', '/dev/factories', { repo: origin, key: 'NB' })
  const task = await client.createTask({
    factory: 'NB',
    title: JSON.stringify({
      steps: [
        { say: 'I’m checking how working slots are released between turns.' },
        { endTurn: true },
      ],
    }),
    start: true,
  })
  await waitUntil(async () => {
    const t = (await client.listTasks()).find((t) => t.id === task.id)
    return t?.runs[0]?.state === 'idle' ? t : undefined
  }, 'source ready')
  await signed.call('PUT', `/tasks/${task.id}`, { title: 'Questions beside ongoing work' })
  app = await electron.launch({ executablePath, args: [appDir], env })
  const window = await loadedWindow(app)
  await window.keyboard.press('Meta+1')
  const list = window.getByRole('navigation', { name: 'Sidebar' })
  await list.getByRole('button', { name: 'Task views' }).first().click()
  await list.getByRole('button', { name: 'List', exact: true }).first().click()
  await window.getByText('Questions beside ongoing work', { exact: true }).first().click()
  await window.getByRole('tab', { name: 'Runs' }).click()
  await window
    .getByRole('complementary', { name: 'Task details' })
    .getByRole('button', { name: /Task Lead/ })
    .click()
  const chooseSideChat = async () => {
    await window.getByRole('button', { name: 'Task actions' }).click()
    await window.getByRole('menuitem', { name: 'Side chat', exact: true }).click()
  }
  await chooseSideChat()
  const side = window.getByRole('region', { name: 'Side chat', exact: true })
  const question = side.getByRole('textbox', { name: 'Question for this side chat' })
  await question.fill(
    JSON.stringify({
      steps: [
        {
          say: 'The Run is checking slot release between turns. This reply uses its starting Conversation snapshot.',
        },
        { endTurn: true },
      ],
    }),
  )
  await side.getByRole('button', { name: 'Send', exact: true }).click()
  await side
    .getByText(
      'The Run is checking slot release between turns. This reply uses its starting Conversation snapshot.',
      { exact: true },
    )
    .waitFor()
  await expect.poll(() => question.isEnabled()).toBe(true)
  const dir = path.join(process.cwd(), 'node_modules/.cache/ted-96')
  await mkdir(dir, { recursive: true })
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1600, 1000))
  await window.screenshot({ path: path.join(dir, 'side-chats-implemented-wide.png') })
  await side.getByRole('button', { name: 'Close side chat' }).click()
  await window.getByRole('button', { name: 'Task actions' }).click()
  await window.screenshot({ path: path.join(dir, 'task-actions-menu.png') })
  await window.getByRole('menuitem', { name: 'Side chat', exact: true }).click()
  await side
    .getByText(
      'The Run is checking slot release between turns. This reply uses its starting Conversation snapshot.',
      { exact: true },
    )
    .waitFor()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1000, 900))
  await window.screenshot({ path: path.join(dir, 'side-chats-implemented-narrow.png') })
  const latest = (await client.listTasks()).find((t) => t.id === task.id) as Task
  expect(latest.runs.filter((r) => r.role === 'lead')).toHaveLength(1)
  expect((await client.listComments(task.id)).every((c) => c.kind === 'note')).toBe(true)
}, 90_000)
