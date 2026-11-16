import { mkdtemp, writeFile } from 'node:fs/promises'
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
  stubCodexPath,
  waitUntil,
} from '../../daemon/test/helpers.ts'
import { buildRenderer } from './build-renderer.ts'
import { closeApp } from './close-app.ts'
import { loadedWindow } from './first-window.ts'
import { resolveElectron } from './support/electron-installation.ts'

const appDir = fileURLToPath(new URL('..', import.meta.url))
const electronPath = resolveElectron()
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
  TED_CODEX_BIN: stubCodexPath,
  TED_ANTIGRAVITY_BIN: path.join(home, 'no-antigravity-here'),
})

const sidebar = (window: Page) => window.getByRole('navigation', { name: 'Sidebar' })

async function json(name: string, body: unknown): Promise<string> {
  const at = path.join(home, name)
  await writeFile(at, JSON.stringify(body))
  return at
}

async function openFirstFactory(window: Page) {
  const entry = sidebar(window)
    .getByRole('button', { name: /^(Automations|Plans)/ })
    .first()
  for (let tries = 0; tries < 30; tries++) {
    await window.keyboard.press('Meta+1')
    if (await entry.isVisible()) return
    await window.waitForTimeout(500)
  }
  await entry.waitFor()
}

describe('Planning chats', () => {
  test('Plan opens a new chat; a round and a proposal appear in the conversation, show in the Inbox, and Create Tasks finishes it', async () => {
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
    const window = await loadedWindow(app)
    await openFirstFactory(window)
    await sidebar(window)
      .getByRole('button', { name: /^Plans/ })
      .click()
    await window
      .getByRole('region', { name: /· Plans$/ })
      .getByRole('button', { name: 'Plan', exact: true })
      .first()
      .click()
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
    expect(await roundCard.evaluate((el) => el.closest('[data-scroller]') !== null)).toBe(true)
    await chat.getByRole('navigation', { name: 'Requests waiting for you' }).waitFor()

    await sidebar(window)
      .getByRole('button', { name: /^Inbox/ })
      .click()
    const row = window
      .getByRole('region', { name: 'Inbox' })
      .getByRole('button')
      .filter({ hasText: 'Plan · Round 1' })
    await row.waitFor()
    expect(await row.textContent()).toContain('Plan notebook sharing')
    await row.click()
    expect(await roundCard.getByRole('button', { name: 'Accept all recommended' }).count()).toBe(0)
    expect(await roundCard.getByRole('radio', { name: /The owner only/ }).isChecked()).toBe(false)
    expect(await roundCard.getByRole('button', { name: 'Submit answers' }).isEnabled()).toBe(false)
    await roundCard.getByRole('radio', { name: /The owner only/ }).check()
    await roundCard.getByRole('button', { name: 'Submit answers' }).click()
    await row.waitFor({ state: 'detached' })
    await window.getByRole('region', { name: 'Nothing open' }).waitFor()
    expect(await window.getByRole('region', { name: 'Inbox' }).getByRole('status').count()).toBe(0)
    await sidebar(window)
      .getByRole('button', { name: /^Agents/ })
      .click()
    await window
      .getByRole('region', { name: 'Agent chats' })
      .getByRole('button')
      .filter({ hasText: 'Plan notebook sharing' })
      .click()
    await chat.getByText(/answered by you at/).waitFor()
    await writeFile(go, '')

    const proposalCard = window.getByRole('region', { name: 'Proposal from the planner' })
    await proposalCard.waitFor({ timeout: 30_000 })
    expect(await proposalCard.evaluate((el) => el.closest('[data-scroller]') !== null)).toBe(true)
    await proposalCard
      .getByText('TED creates a parent Task for these Tasks. It runs after they merge.')
      .waitFor()
    await proposalCard.getByRole('button', { name: 'Create 2 Tasks' }).click()
    await chat.getByText('Planning Run finished').waitFor({ timeout: 30_000 })
    await chat
      .getByText('TED created 2 Tasks under NB-1: NB-2, NB-3. NB-1 waits for them to merge.')
      .waitFor()
    await chat.getByText('This planning chat is finished. It stays as history.').waitFor()
    const pane = window.getByRole('complementary', { name: 'Planning chat details' })
    await pane.getByText('Created Tasks · 2').waitFor()
    await pane.getByText('Backlog · Blocked by NB-2').waitFor()
  })

  test('Agents lists stopped and failed planning chats; from the chat, Retry clears the red dot, Mark finished ends one, Plan more from here builds on it, and Delete removes one', async () => {
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
    const window = await loadedWindow(app)
    await openFirstFactory(window)
    await sidebar(window)
      .getByRole('button', { name: /^Agents/ })
      .click()
    const list = window.getByRole('region', { name: 'Agent chats' })
    const row = (title: string) => list.getByRole('button').filter({ hasText: title })
    const chat = window.getByRole('region', { name: 'Planning chat' })
    await row('Failing plan').getByText('Failed').waitFor()
    expect(await row('Failing plan').textContent()).toContain('Planner')
    await sidebar(window).getByRole('img', { name: 'A planning chat failed' }).waitFor()
    await window.keyboard.press('j')
    await expect
      .poll(() =>
        window.evaluate(
          () => document.activeElement?.closest('[aria-label="Agent chats"]') !== null,
        ),
      )
      .toBe(true)

    await row('Quick plan').getByText('Stopped').waitFor()
    await row('Quick plan').click()
    await chat.getByRole('heading', { name: 'Quick plan' }).waitFor()
    await chat.getByRole('button', { name: 'Resume' }).waitFor()
    await chat.getByRole('button', { name: 'Mark finished' }).click()
    await row('Quick plan').getByText('Finished').waitFor()
    await row('Quick plan').getByText('No Tasks').waitFor()

    await writeFile(stubState, '{}')
    await row('Failing plan').click()
    await chat.getByRole('heading', { name: 'Failing plan' }).waitFor()
    await chat.getByRole('button', { name: 'Retry' }).click()
    await row('Failing plan').getByText('Working').waitFor({ timeout: 30_000 })
    await sidebar(window)
      .getByRole('img', { name: 'A planning chat failed' })
      .waitFor({ state: 'detached' })

    await row('Quick plan').click()
    await chat.getByRole('heading', { name: 'Quick plan' }).waitFor()
    await chat.getByRole('button', { name: 'More' }).click()
    await chat.getByRole('menuitem', { name: 'Plan more from here…' }).click()
    const fresh = window.getByRole('region', { name: 'New planning chat' })
    await fresh.getByText('Builds on “Quick plan”', { exact: false }).waitFor()
    await fresh
      .getByRole('textbox', { name: 'What do you want to plan?' })
      .fill(`Plan the next part\n${JSON.stringify({ steps: [{ say: 'Hi' }, { endTurn: true }] })}`)
    await fresh.getByRole('button', { name: 'Send' }).click()
    await chat.getByRole('heading', { name: 'Plan the next part' }).waitFor()
    const pane = window.getByRole('complementary', { name: 'Planning chat details' })
    await pane.getByRole('button', { name: 'Quick plan' }).waitFor()
    await chat.getByText('Hi', { exact: true }).waitFor({ timeout: 30_000 })
    await chat.getByRole('button', { name: 'Stop', exact: true }).click()
    await chat
      .getByText('This planning chat stopped. Resume carries on where it left off.')
      .waitFor()
    await chat.getByRole('button', { name: 'Resume' }).waitFor()
    await chat.getByRole('textbox', { name: 'Message to this Run' }).waitFor()

    await row('Quick plan').click()
    await chat.getByRole('heading', { name: 'Quick plan' }).waitFor()
    await chat.getByRole('button', { name: 'More' }).click()
    await chat.getByRole('menuitem', { name: 'Delete…' }).click()
    await chat
      .getByRole('alertdialog', { name: 'Delete this planning chat?' })
      .getByRole('button', { name: 'Delete' })
      .click()
    await row('Quick plan').waitFor({ state: 'detached' })
    await client.stopPlan(failing.id)
  })
})
