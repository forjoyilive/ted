import { mkdtemp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type ElectronApplication, _electron as electron } from 'playwright'
import { afterEach, beforeAll, beforeEach, describe, test, vi } from 'vitest'
import {
  commitToOrigin,
  daemonAsApp,
  killRunHosts,
  makeOriginRepo,
  removeHome,
  stopDaemonIn,
} from '../../daemon/test/helpers.ts'
import { buildRenderer } from './build-renderer.ts'
import { closeApp } from './close-app.ts'
import { loadedWindow } from './first-window.ts'

const appDir = fileURLToPath(new URL('..', import.meta.url))
const electronPath = createRequire(import.meta.url)('electron') as string
const stubClaudePath = fileURLToPath(
  new URL('../../daemon/test/fixtures/stub-claude.ts', import.meta.url),
)

vi.setConfig({ testTimeout: 120_000 })

let home: string
let app: ElectronApplication | undefined

beforeAll(async () => {
  await buildRenderer()
})

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'ted-app-plan-task-'))
})

afterEach(async () => {
  await closeApp(app)
  app = undefined
  await stopDaemonIn(home)
  await killRunHosts(home)
  await removeHome(home)
}, 30_000)

const env = () => ({
  ...process.env,
  TED_HOME: home,
  TED_IDLE_EXIT_MS: '30000',
  TED_HIDDEN_WINDOW: '1',
  TED_CLAUDE_BIN: stubClaudePath,
})

describe('Plan in chat from a Task', () => {
  test('Plan in chat opens a chat started from the Task; approval narrows the Task', async () => {
    const parent = path.join(home, 'origin')
    const origin = await makeOriginRepo(parent)
    await commitToOrigin(parent, {
      '.ted/workflow.yaml': 'version: 1\norder: [intake, clarify, work]\n',
    })
    const proposal = path.join(home, 'proposal.json')
    await writeFile(
      proposal,
      JSON.stringify({
        title: 'Offline editing, in three Tasks',
        tasks: [
          { title: 'Local note cache', scope: 'Notes save locally first.', priority: 'high' },
          { title: 'Sync queue', scope: 'Send offline edits in order.', blockedBy: [1] },
          { title: 'Offline badge', scope: 'A badge while edits wait.', priority: 'low' },
        ],
      }),
    )
    const client = await daemonAsApp(home, env())
    await client.addFactory({ repo: origin, key: 'NB' })
    const task = await client.createTask({
      factory: 'NB',
      title: JSON.stringify({
        steps: [
          { everyMessage: [{ endTurn: true }] },
          { run: ['ted', 'outcome', 'advance'] },
          {
            run: [
              'ted',
              'clarify',
              'too-big',
              '--settle',
              'Which piece ships first',
              'Offline editing spans storage, sync and the editor.',
            ],
          },
          { endTurn: true },
        ],
      }),
      description: 'Let notes be edited offline.',
    })
    await client.startTask(task.id)

    app = await electron.launch({ executablePath: electronPath, args: [appDir], env: env() })
    const window = await loadedWindow(app)
    const inbox = window.getByRole('region', { name: 'Inbox' })
    const question = inbox.getByRole('button').filter({ hasText: 'Too big for one pull request' })
    await question.waitFor({ timeout: 30_000 })
    await question.click()
    const ask = window
      .getByRole('region', { name: 'Task thread' })
      .getByRole('region', { name: 'Question', exact: true })
    await ask.getByRole('textbox', { name: 'Your answer' }).fill(
      JSON.stringify({
        steps: [{ run: ['ted', 'task', 'propose', '--file', proposal] }, { endTurn: true }],
      }),
    )
    await ask.getByRole('button', { name: 'Plan in chat' }).click()

    const chat = window.getByRole('region', { name: 'Planning chat' })
    await chat.getByText('Planning chat · started from').waitFor({ timeout: 20_000 })
    await chat.getByRole('button', { name: 'NB-1' }).first().waitFor()
    const pane = window.getByRole('complementary', { name: 'Planning chat details' })
    await pane.getByText(/^Clarify/).waitFor()

    const card = window.getByRole('region', { name: 'Proposal from the planner' })
    await card.waitFor({ timeout: 30_000 })
    await card.getByText('(this Task) becomes the first piece:').waitFor()
    await card.getByRole('button', { name: 'Create 2 Tasks' }).click()
    await chat
      .getByText('TED created 2 Tasks in Backlog: NB-2, NB-3. NB-1 narrowed to Local note cache.')
      .waitFor({ timeout: 30_000 })
    await chat.getByText('TED told NB-1’s Task Lead; it carries on with Clarify.').waitFor()
    await pane.getByText('Local note cache').first().waitFor()
  })
})
