import { mkdtemp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type ElectronApplication, _electron as electron, type Page } from 'playwright'
import { build } from 'vite'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  daemonAsApp,
  killRunHosts,
  makeOriginRepo,
  removeHome,
  stopDaemonIn,
} from '../../daemon/test/helpers.ts'
import { closeApp } from './close-app.ts'

const appDir = fileURLToPath(new URL('..', import.meta.url))
const electronPath = createRequire(import.meta.url)('electron') as string
const stubClaudePath = fileURLToPath(
  new URL('../../daemon/test/fixtures/stub-claude.ts', import.meta.url),
)

vi.setConfig({ testTimeout: 120_000 })

let home: string
let app: ElectronApplication | undefined

beforeAll(async () => {
  await build({ configFile: path.join(appDir, 'vite.config.ts'), logLevel: 'warn' })
})

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'ted-app-plans-'))
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

const sidebar = (window: Page) => window.getByRole('navigation', { name: 'Sidebar' })

async function json(name: string, body: unknown): Promise<string> {
  const at = path.join(home, name)
  await writeFile(at, JSON.stringify(body))
  return at
}

describe('Planning chats', () => {
  test('Plan opens a new chat; a round and a proposal pin above the box, show in the Inbox, and Create Tasks finishes it', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    await (await daemonAsApp(home, env())).addFactory({ repo: origin, key: 'NB' })
    const round = await json('round.json', {
      title: 'Who can share',
      questions: [
        {
          question: 'Who can share a notebook?',
          choices: ['The owner only', 'Anyone'],
          recommended: 'The owner only',
        },
      ],
    })
    const proposal = await json('proposal.json', {
      title: 'Sharing, in two Tasks',
      tasks: [
        { title: 'Notebook owners', scope: 'Give every notebook an owner.', priority: 'high' },
        { title: 'Share dialog', scope: 'Let the owner share.', blockedBy: [1] },
      ],
    })
    const go = path.join(home, 'go')
    app = await electron.launch({ executablePath: electronPath, args: [appDir], env: env() })
    const window = await app.firstWindow()
    await sidebar(window).waitFor()
    await window.keyboard.press('Meta+1')
    await window.getByRole('button', { name: 'Plan', exact: true }).first().click()
    const fresh = window.getByRole('region', { name: 'New planning chat' })
    await fresh.waitFor()
    expect(
      await fresh
        .getByRole('textbox', { name: 'What do you want to plan?' })
        .evaluate((el) => el === document.activeElement),
    ).toBe(true)
    const steps = JSON.stringify({
      steps: [
        { run: ['ted', 'ask', '--round', round] },
        { endTurn: true },
        { waitFor: go },
        { run: ['ted', 'task', 'propose', '--file', proposal] },
        { endTurn: true },
      ],
    })
    await fresh
      .getByRole('textbox', { name: 'What do you want to plan?' })
      .fill(`Plan notebook sharing\n${steps}`)
    await fresh.getByRole('button', { name: 'Send' }).click()

    const chat = window.getByRole('region', { name: 'Planning chat' })
    await chat.getByRole('heading', { name: 'Plan notebook sharing' }).waitFor()
    const roundCard = window.getByRole('region', { name: 'Round 1 from the planner' })
    await roundCard.waitFor({ timeout: 30_000 })
    await chat.getByText('pinned below').waitFor()

    await sidebar(window)
      .getByRole('button', { name: /^Inbox/ })
      .click()
    const row = window
      .getByRole('region', { name: 'Inbox' })
      .getByRole('button')
      .filter({ hasText: 'Plan · Round 1 · 1 question' })
    await row.waitFor()
    expect(await row.textContent()).toContain('Plan notebook sharing')
    await row.click()
    await roundCard.getByRole('button', { name: 'Accept all recommended' }).click()
    await chat.getByText(/answered by you at/).waitFor()
    await writeFile(go, '')

    const proposalCard = window.getByRole('region', { name: 'Proposal from the planner' })
    await proposalCard.waitFor({ timeout: 30_000 })
    await proposalCard.getByRole('button', { name: 'Create 2 Tasks' }).click()
    await chat.getByText('Planning Run finished').waitFor({ timeout: 30_000 })
    await chat.getByText('TED created 2 Tasks in Backlog: NB-1, NB-2').waitFor()
    await chat.getByText('This planning chat is finished. It stays as history.').waitFor()
    const pane = window.getByRole('complementary', { name: 'Planning chat details' })
    await pane.getByText('Created Tasks · 2').waitFor()
    await pane.getByText('Backlog · Blocked by NB-1').waitFor()
  })
})
