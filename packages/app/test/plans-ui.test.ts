import { mkdtemp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type ElectronApplication, _electron as electron, type Page } from 'playwright'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  daemonAsApp,
  killRunHosts,
  makeOriginRepo,
  removeHome,
  stopDaemonIn,
  waitUntil,
} from '../../daemon/test/helpers.ts'
import { buildRenderer } from './build-renderer.ts'
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
  await buildRenderer()
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

  test('the Plans list groups chats, Retry clears the red dot, Plan more from here builds on a past chat, and Delete removes one', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    const client = await daemonAsApp(home, env())
    await client.addFactory({ repo: origin, key: 'NB' })
    const stubState = path.join(home, 'stub-claude.json')
    await writeFile(stubState, JSON.stringify({ resumeFails: true }))
    const failing = await client.startPlan({
      factory: 'NB',
      message: `Failing plan\n${JSON.stringify({ steps: [{ say: 'Reading' }, { exit: 1 }] })}`,
    })
    const quick = await client.startPlan({
      factory: 'NB',
      message: `Quick plan\n${JSON.stringify({ steps: [{ say: 'Hi' }, { endTurn: true }] })}`,
    })
    await waitUntil(
      async () => (await client.getPlan(failing.id)).plan.status === 'failed' || undefined,
      'the failing chat to fail',
      30_000,
    )
    await waitUntil(
      async () => (await client.getPlan(quick.id)).plan.status === 'idle' || undefined,
      'the quick chat to go idle',
      30_000,
    )
    await client.stopPlan(quick.id)

    app = await electron.launch({ executablePath: electronPath, args: [appDir], env: env() })
    const window = await app.firstWindow()
    await sidebar(window).waitFor()
    await window.keyboard.press('Meta+1')
    await sidebar(window)
      .getByRole('button', { name: /^Plans/ })
      .click()
    const list = window.getByRole('region', { name: /· Plans$/ })
    const open = list.getByRole('region', { name: 'Open planning chats' })
    const failedRow = open.getByRole('row').filter({ hasText: 'Failing plan' })
    await failedRow.getByText('Failed').waitFor()
    expect(await failedRow.textContent()).toContain('—')
    await sidebar(window).getByRole('img', { name: 'A planning chat failed' }).waitFor()
    await window.keyboard.press('j')
    await expect
      .poll(() => window.evaluate(() => document.activeElement?.textContent))
      .toBe('Failing plan')

    const past = list.getByRole('region', { name: 'Past planning chats' })
    const pastToggle = past.getByRole('button', { name: /Past/ })
    expect(await pastToggle.getAttribute('aria-expanded')).toBe('false')
    expect(await pastToggle.textContent()).toContain('1')
    await pastToggle.click()
    const quickRow = past.getByRole('row').filter({ hasText: 'Quick plan' })
    await quickRow.getByText('Stopped').waitFor()
    await quickRow.getByText('No Tasks').waitFor()

    await writeFile(stubState, '{}')
    await failedRow.getByRole('button', { name: 'Retry' }).click()
    await open.getByRole('row').filter({ hasText: 'Failing plan' }).getByText('Working').waitFor({
      timeout: 30_000,
    })
    await sidebar(window)
      .getByRole('img', { name: 'A planning chat failed' })
      .waitFor({ state: 'detached' })

    await quickRow.getByRole('button', { name: 'Actions for Quick plan' }).click()
    await quickRow.getByRole('menuitem', { name: 'Plan more from here' }).click()
    const fresh = window.getByRole('region', { name: 'New planning chat' })
    await fresh.getByText('Builds on “Quick plan”', { exact: false }).waitFor()
    await fresh
      .getByRole('textbox', { name: 'What do you want to plan?' })
      .fill(`Plan the next part\n${JSON.stringify({ steps: [{ say: 'Hi' }, { endTurn: true }] })}`)
    await fresh.getByRole('button', { name: 'Send' }).click()
    const chat = window.getByRole('region', { name: 'Planning chat' })
    await chat.getByRole('heading', { name: 'Plan the next part' }).waitFor()
    const pane = window.getByRole('complementary', { name: 'Planning chat details' })
    await pane.getByRole('button', { name: 'Quick plan' }).waitFor()
    await chat.getByRole('button', { name: 'Stop' }).click()
    await chat.getByRole('button', { name: 'Plan more from here' }).waitFor()

    await chat.getByRole('button', { name: '← Plans' }).click()
    await list.getByRole('button', { name: /Past/ }).click()
    const doomed = past.getByRole('row').filter({ hasText: 'Quick plan' })
    await doomed.getByRole('button', { name: 'Actions for Quick plan' }).click()
    await doomed.getByRole('menuitem', { name: 'Delete…' }).click()
    await doomed.getByRole('button', { name: 'Delete' }).click()
    await doomed.waitFor({ state: 'detached' })
    await client.stopPlan(failing.id)
  })
})
