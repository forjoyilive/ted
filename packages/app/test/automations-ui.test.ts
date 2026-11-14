import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Automation, AutomationDetail, DaemonClient } from '@ted/protocol'
import { type ElectronApplication, _electron as electron, type Page } from 'playwright'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  daemonAsApp,
  makeOriginRepo,
  removeHome,
  stopDaemonIn,
  stubClaudePath,
  stubCodexPath,
  waitUntil,
} from '../../daemon/test/helpers.ts'
import { buildRenderer } from './build-renderer.ts'
import { closeApp } from './close-app.ts'
import { loadedWindow } from './first-window.ts'
import { resolveElectron } from './support/electron-installation.ts'

const appDir = fileURLToPath(new URL('..', import.meta.url))
const electronPath = resolveElectron()

vi.setConfig({ testTimeout: 120_000 })

let home: string
let app: ElectronApplication | undefined

beforeAll(async () => {
  await buildRenderer()
})

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'ted-app-automations-'))
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
  TED_CODEX_BIN: stubCodexPath,
  TED_ANTIGRAVITY_BIN: path.join(home, 'no-antigravity-here'),
  TED_HIDDEN_WINDOW: '1',
})

const sidebar = (window: Page) => window.getByRole('navigation', { name: 'Sidebar' })
const dialog = (window: Page) => window.getByRole('dialog', { name: /Automation/ })
const steps = (...list: unknown[]) => JSON.stringify({ steps: list })

async function launch(): Promise<{ window: Page; ted: DaemonClient }> {
  const origin = await makeOriginRepo(path.join(home, 'origin'))
  const ted = await daemonAsApp(home, env())
  await ted.updateSettings({ timeFormat: '24-hour', timeZone: 'Europe/London' })
  await ted.addFactory({ repo: origin, key: 'NB' })
  app = await electron.launch({ executablePath: electronPath, args: [appDir], env: env() })
  const window = await loadedWindow(app)
  await window.emulateMedia({ colorScheme: null })
  return { window, ted }
}

async function openAutomations(window: Page) {
  await openFirstFactory(window)
  await sidebar(window)
    .getByRole('button', { name: /^Automations/ })
    .click()
  await window.getByRole('region', { name: 'Automations' }).waitFor()
}

const history = (ted: DaemonClient, id: string): Promise<AutomationDetail> => ted.getAutomation(id)

async function openFirstFactory(window: Page) {
  const entry = sidebar(window)
    .getByRole('button', { name: /^(Automations|Plans)/ })
    .first()
  for (let tries = 0; tries < 30; tries++) {
    await window.keyboard.press('Meta+1')
    const shown = await entry.waitFor({ timeout: 500 }).then(
      () => true,
      () => false,
    )
    if (shown) return
  }
  await entry.waitFor()
}

describe('Automations in the app', () => {
  test('a missing Automation crosses the bridge as deleted rather than a request failure; the empty page offers templates; a template fills the form and the schedule checks itself', async () => {
    const { window, ted } = await launch()
    expect(
      await window.evaluate(() => globalThis.window.ted.request('getAutomation', 'missing')),
    ).toBeNull()
    await openAutomations(window)
    const page = window.getByRole('region', { name: 'Automations' })
    await page.getByRole('heading', { name: 'No Automations yet' }).waitFor()
    await page.getByRole('button', { name: 'Use template: Daily GitHub issue triage' }).click()

    const form = dialog(window)
    await form.getByRole('heading', { name: 'New Automation in' }).waitFor()
    await expect.poll(() => form.getByLabel('Name').inputValue()).toBe('Daily GitHub issue triage')
    expect(await form.getByRole('textbox', { name: 'Prompt' }).inputValue()).toContain(
      'Triage this Factory’s new',
    )
    expect(await form.getByLabel('Repeat').inputValue()).toBe('daily')
    expect(await form.getByRole('radio', { name: /Daily GitHub issue triage/ }).isChecked()).toBe(
      true,
    )
    await form.getByText(/^Next: .+ · .+ · .+/).waitFor()
    expect(await form.getByLabel('Timezone', { exact: true }).count()).toBe(0)
    await ted.updateSettings({ timeFormat: '12-hour' })
    await form.getByLabel('AM or PM').waitFor()
    await form.getByLabel('Hour', { exact: true }).selectOption('12')
    await form.getByLabel('AM or PM').selectOption('AM')
    await ted.updateSettings({ timeFormat: '24-hour' })
    await expect.poll(() => form.getByLabel('Hour', { exact: true }).inputValue()).toBe('0')
    expect(await form.getByLabel('AM or PM').count()).toBe(0)
    await ted.updateSettings({ timeFormat: '12-hour' })
    await form.getByLabel('AM or PM').waitFor()
    await form.getByLabel('AM or PM').selectOption('PM')
    await ted.updateSettings({ timeFormat: '24-hour' })
    await expect.poll(() => form.getByLabel('Hour', { exact: true }).inputValue()).toBe('12')
    await form.getByLabel('Hour', { exact: true }).selectOption('9')

    await form.getByLabel('Repeat').selectOption('every')
    await form.getByLabel('How often').fill('5')
    await form.getByText('The shortest interval is 15 minutes.').waitFor()
    expect(await form.getByRole('button', { name: /^Save/ }).last().isDisabled()).toBe(true)

    await form.getByLabel('Repeat').selectOption('custom')
    await form.getByLabel('Cron or RRULE').fill('0 9 * * Mon-Fry')
    await form.getByText(/^Not a valid cron or RRULE/).waitFor()
    await form.getByLabel('Cron or RRULE').fill('0 9 * * 1-5')
    await form.getByText(/^Weekdays at 09:00\. Next: /).waitFor()

    await form.getByRole('radio', { name: /Blank/ }).check()
    expect(await form.getByLabel('Name').inputValue()).toBe('')
    await form.getByLabel('Name').fill('Weekly sweep')
    await form.getByRole('textbox', { name: 'Prompt' }).fill('Sweep stale Tasks.')
    await form.getByLabel('Repeat').selectOption('weekly')
    await form.getByRole('button', { name: 'Thursday' }).click()
    await form.getByLabel('Hour', { exact: true }).selectOption('14')
    await form.getByLabel('Minute', { exact: true }).selectOption('0')
    await form.getByText(/^Next: (Mon|Thu) /).waitFor()
    await form.getByLabel('On', { exact: true }).uncheck()
    const checkout = form.getByLabel('Run in a copy of the code', { exact: true })
    expect(await checkout.isChecked()).toBe(false)
    await checkout.check()
    await window.keyboard.press('Meta+Enter')
    await form.waitFor({ state: 'detached' })
    const sweep = (await ted.listAutomations()).find((a) => a.name === 'Weekly sweep')
    expect(sweep?.checkout).toBe(true)

    const view = window.getByRole('region', { name: 'Automation' })
    await view.getByRole('heading', { name: 'Weekly sweep' }).waitFor()
    await view.getByText(/Mon and Thu at 14:00 · .+ · Off · Claude/).waitFor()
    await view.getByRole('button', { name: '← Automations' }).click()
    const row = window.getByRole('row').filter({ hasText: 'Weekly sweep' })
    await row.getByText('Off', { exact: true }).waitFor()
    expect(await row.getAttribute('data-off')).toBe('true')

    await window.keyboard.press('Meta+k')
    const palette = window.getByRole('dialog', { name: 'Search and commands' })
    await palette.getByRole('combobox').fill('New Automation')
    await palette
      .getByRole('option', { name: /New Automation/ })
      .first()
      .click()
    await dialog(window).getByRole('heading', { name: 'New Automation in' }).waitFor()
  })

  test('the architecture template fills a weekly review and the Asana template an interval the human changes; both save without starting Tasks', async () => {
    const { window, ted } = await launch()
    await openAutomations(window)
    await window.getByRole('button', { name: 'Use template: Review codebase architecture' }).click()
    const form = dialog(window)
    await expect
      .poll(() => form.getByLabel('Name').inputValue())
      .toBe('Review codebase architecture')
    expect(await form.getByRole('textbox', { name: 'Prompt' }).inputValue()).toContain(
      'up to three',
    )
    expect(
      await form.getByRole('radio', { name: /Review codebase architecture/ }).isChecked(),
    ).toBe(true)
    expect(await form.getByLabel('Repeat').inputValue()).toBe('weekly')
    expect(
      await form.getByRole('button', { name: 'Monday', exact: true }).getAttribute('aria-pressed'),
    ).toBe('true')
    expect(
      await form.getByRole('button', { name: 'Tuesday', exact: true }).getAttribute('aria-pressed'),
    ).toBe('false')
    expect(await form.getByLabel('Hour', { exact: true }).inputValue()).toBe('9')
    expect(await form.getByLabel('Minute', { exact: true }).inputValue()).toBe('0')
    await form.getByText(/^Next: .+ · .+ · .+/).waitFor()
    if (process.env.TED_ARCHITECTURE_SCREENSHOT) {
      await window.screenshot({ path: process.env.TED_ARCHITECTURE_SCREENSHOT })
    }
    await form.getByRole('button', { name: 'Save', exact: true }).click()
    await form.waitFor({ state: 'detached' })
    await window
      .getByRole('region', { name: 'Automation' })
      .getByRole('heading', { name: 'Review codebase architecture' })
      .waitFor()
    const [saved] = await ted.listAutomations()
    expect(saved).toMatchObject({
      template: 'architecture',
      on: true,
      schedule: { kind: 'weekly', days: ['mon'], at: '09:00' },
    })
    expect((await ted.getAutomation(saved?.id ?? '')).history).toEqual([])

    await window.getByRole('button', { name: 'New Automation', exact: true }).click()
    const asana = dialog(window)
    await asana.getByRole('radio', { name: /Import my Asana work/ }).check()
    await expect.poll(() => asana.getByLabel('Name').inputValue()).toBe('Import my Asana work')
    expect(await asana.getByRole('textbox', { name: 'Prompt' }).inputValue()).toContain(
      'ted asana intake',
    )
    expect(await asana.getByLabel('Repeat').inputValue()).toBe('every')
    expect(await asana.getByLabel('How often').inputValue()).toBe('30')
    expect(await asana.getByLabel('Unit').inputValue()).toBe('minutes')
    await asana.getByLabel('How often').fill('2')
    await asana.getByLabel('Unit').selectOption('hours')
    await asana.getByText(/^Next: .+ · .+ · .+/).waitFor()
    await asana.getByRole('button', { name: 'Save', exact: true }).click()
    await asana.waitFor({ state: 'detached' })
    const intake = (await ted.listAutomations()).find((a) => a.template === 'asana')
    expect(intake).toMatchObject({
      on: true,
      schedule: { kind: 'every', every: 2, unit: 'hours' },
      scheduleText: 'Every 2 hours · Europe/London',
    })
    const [first, second] = (intake?.nextFirings ?? []).map(Date.parse)
    expect((second ?? 0) - (first ?? 0)).toBe(2 * 60 * 60 * 1000)
    expect(await ted.listTasks()).toEqual([])
  })

  test('drafts a new Automation Prompt, lets the human edit it and saves only on request', async () => {
    const { window, ted } = await launch()
    await openAutomations(window)
    await window.getByRole('button', { name: 'New Automation', exact: true }).click()
    const form = dialog(window)
    await form.getByLabel('Name').fill('Bug intake')
    await form.getByRole('button', { name: 'Draft with AI', exact: true }).click()
    await form
      .getByLabel('What should this Automation do?')
      .fill(steps({ say: 'Find new bugs and create Tasks in Backlog.' }, { endTurn: true }))
    await form.getByRole('button', { name: 'Generate draft', exact: true }).click()
    await form.getByLabel('Suggested Prompt', { exact: true }).waitFor()
    expect(await form.getByRole('textbox', { name: 'Prompt', exact: true }).inputValue()).toBe('')
    expect(await ted.listAutomations()).toEqual([])
    await form
      .getByLabel('Suggested Prompt', { exact: true })
      .fill('Find actionable bugs and create Tasks in Backlog. Skip sources already tracked.')
    if (process.env.TED_DRAFT_SCREENSHOT) {
      await form
        .getByLabel('What should this Automation do?')
        .fill(
          'Find unassigned bugs in Linear and create Tasks in Backlog. Skip issues TED already tracks.',
        )
      await window.setViewportSize({ width: 1200, height: 1450 })
      await window.screenshot({ path: process.env.TED_DRAFT_SCREENSHOT })
    }
    await form.getByRole('button', { name: 'Use draft', exact: true }).click()
    await form
      .getByRole('textbox', { name: 'Prompt', exact: true })
      .fill('Final reviewed instructions.')
    await form.getByLabel('On', { exact: true }).uncheck()
    await form.getByRole('button', { name: 'Save', exact: true }).click()
    await form.waitFor({ state: 'detached' })
    const saved = (await ted.listAutomations())[0]
    expect(saved).toMatchObject({
      name: 'Bug intake',
      prompt: 'Final reviewed instructions.',
      on: false,
    })
    expect((await ted.getAutomation(saved?.id ?? '')).history).toEqual([])
  })

  test('drafting a revision preserves current edits, supports discard and retries failed generation', async () => {
    const { window, ted } = await launch()
    const automation = await ted.createAutomation({
      factory: 'NB',
      name: 'Existing intake',
      prompt: 'Original Prompt',
      schedule: { kind: 'daily', at: '09:00' },
      on: false,
    })
    await openAutomations(window)
    await window.getByRole('button', { name: 'Existing intake', exact: true }).click()
    await window
      .getByRole('region', { name: 'Automation', exact: true })
      .getByRole('button', { name: 'Edit', exact: true })
      .click()
    const form = dialog(window)
    const prompt = form.getByRole('textbox', { name: 'Prompt', exact: true })
    await prompt.fill('Unsaved human revision')
    await form.getByRole('button', { name: 'Draft with AI', exact: true }).click()
    const request = form.getByLabel('What should this Automation do?')
    await request.fill(steps({ exit: 1 }))
    await form.getByRole('button', { name: 'Generate draft', exact: true }).click()
    await form.getByRole('alert').filter({ hasText: 'Your Prompt is unchanged.' }).waitFor()
    expect(await prompt.inputValue()).toBe('Unsaved human revision')
    await request.fill(steps({ say: 'Suggested revision' }, { endTurn: true }))
    await form.getByRole('button', { name: 'Try again', exact: true }).click()
    await form.getByLabel('Suggested Prompt', { exact: true }).waitFor()
    await prompt.fill('Edit made while reviewing')
    await form.getByRole('button', { name: 'Discard draft', exact: true }).click()
    expect(await prompt.inputValue()).toBe('Edit made while reviewing')
    expect((await ted.getAutomation(automation.id)).automation.prompt).toBe('Original Prompt')
    await form.getByRole('button', { name: 'Generate draft', exact: true }).click()
    await form.getByLabel('Suggested Prompt', { exact: true }).waitFor()
    await form.getByRole('button', { name: 'Use draft', exact: true }).click()
    expect(await prompt.inputValue()).toBe('Suggested revision')
    await form.getByRole('button', { name: 'Save', exact: true }).click()
    await form.waitFor({ state: 'detached' })
    expect((await ted.getAutomation(automation.id)).automation.prompt).toBe('Suggested revision')
    expect((await ted.getAutomation(automation.id)).history).toEqual([])
  })

  test('cancel and closing the editor stop drafting and ignore a delayed start response', async () => {
    const { window, ted } = await launch()
    await openAutomations(window)
    await window.getByRole('button', { name: 'New Automation', exact: true }).click()
    let form = dialog(window)
    await form.getByLabel('Name').fill('Canceled draft')
    await form.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Keep these instructions')
    await form.getByRole('button', { name: 'Draft with AI', exact: true }).click()
    await form
      .getByLabel('What should this Automation do?')
      .fill(
        steps(
          { waitFor: path.join(home, 'draft-release') },
          { say: 'Late suggestion' },
          { endTurn: true },
        ),
      )
    await form.getByRole('button', { name: 'Generate draft', exact: true }).click()
    await form.getByText('Drafting…', { exact: true }).waitFor()
    expect(await form.getByRole('button', { name: 'Save', exact: true }).isDisabled()).toBe(true)
    expect(await form.getByLabel('Agent', { exact: true }).isDisabled()).toBe(true)
    await form.getByRole('button', { name: 'Cancel drafting', exact: true }).click()
    await expect
      .poll(() => form.getByRole('button', { name: 'Generate draft', exact: true }).isEnabled())
      .toBe(true)
    await writeFile(path.join(home, 'draft-release'), '')
    expect(await form.getByRole('textbox', { name: 'Prompt', exact: true }).inputValue()).toBe(
      'Keep these instructions',
    )
    await form.getByRole('button', { name: 'Close', exact: true }).click()

    await window.evaluate(() => {
      const original = globalThis.window.ted.request.bind(globalThis.window.ted)
      globalThis.window.ted.request = async (method, ...args) => {
        const result = await original(method, ...args)
        if (method === 'draftAutomationPrompt')
          await new Promise((resolve) => setTimeout(resolve, 1500))
        return result
      }
    })
    await window.getByRole('button', { name: 'New Automation', exact: true }).click()
    form = dialog(window)
    await form.getByRole('button', { name: 'Draft with AI', exact: true }).click()
    await form
      .getByLabel('What should this Automation do?')
      .fill(steps({ waitFor: path.join(home, 'never-release') }))
    await form.getByRole('button', { name: 'Generate draft', exact: true }).click()
    await form.getByRole('button', { name: 'Close', exact: true }).click()
    await waitUntil(async () => {
      const slots = await ted.getSlots()
      return slots.working === 0 && slots.queued === 0
    }, 'closed editor to cancel its drafting Run')
    expect(await ted.listAutomations()).toEqual([])
  })

  test('a question shows in the Inbox under the Automation’s name and is answered in its Run; a failed Run shows Retry on the newest failed row only, and Duplicate makes an off copy', async () => {
    const { window, ted } = await launch()
    const automation = await ted.createAutomation({
      factory: 'NB',
      name: 'Sentry crash intake',
      schedule: { kind: 'daily', at: '09:00' },
      on: false,
      prompt: steps(
        { everyMessage: [{ say: 'Skipping it' }, { endTurn: true }] },
        { run: ['ted', 'task', 'create', '--source', 'https://example.com/1', 'Crash on open'] },
        { say: 'One is a real crash.' },
        {
          run: ['ted', 'comment', '--choice', 'Make a Task', '--choice', 'Skip it', 'Is it real?'],
        },
        { endTurn: true },
      ),
    })
    await ted.runAutomation(automation.id)

    await sidebar(window)
      .getByRole('button', { name: /^Inbox/ })
      .click()
    const inbox = window.getByRole('region', { name: 'Inbox' })
    const question = inbox.getByRole('button', { name: /Is it real\?/ })
    await question.waitFor({ timeout: 30_000 })
    expect(await question.textContent()).toContain('Sentry crash intake · Automation')
    await question.click()

    const runView = window.getByRole('region', { name: 'Automation Run' })
    await runView
      .getByRole('heading', { name: /^Sentry crash intake · Run of \d\d:\d\d$/ })
      .waitFor()
    await runView.getByText('Waiting on you').waitFor()
    await runView.getByText('One is a real crash.').waitFor()
    await runView.getByText(/Is it real\? · answer below/).waitFor()
    const details = window.getByRole('complementary', { name: 'Run details' })
    await details.getByRole('button', { name: 'NB-1' }).waitFor()

    const card = runView.getByRole('region', { name: 'Question from this Run' })
    await card.getByRole('radio', { name: 'Skip it' }).check()
    expect(await card.isVisible()).toBe(true)
    await card.getByRole('button', { name: 'Send' }).click()
    await card.waitFor({ state: 'detached' })
    await inbox.getByRole('button', { name: /Is it real\?/ }).waitFor({ state: 'detached' })
    await runView.waitFor({ state: 'detached' })

    await openAutomations(window)
    await window
      .getByRole('row')
      .filter({ hasText: 'Sentry crash intake' })
      .getByRole('button', { name: 'Sentry crash intake' })
      .click()
    const view = window.getByRole('region', { name: 'Automation' })
    await view.getByRole('heading', { name: 'Sentry crash intake' }).waitFor()
    const row = view.getByRole('row').filter({ hasText: 'Run now' })
    await row.getByText(/^Created/).waitFor({ timeout: 30_000 })
    await row.getByRole('button', { name: 'NB-1' }).waitFor()

    await view.getByRole('button', { name: 'Automation actions' }).click()
    await window.getByRole('menuitem', { name: /Delete/ }).click()
    const confirm = window.getByRole('dialog', { name: 'Delete “Sentry crash intake”?' })
    await confirm.getByText('Tasks it created stay.', { exact: false }).waitFor()
    await confirm.getByRole('button', { name: 'Delete' }).click()
    await window.getByRole('region', { name: 'Automations' }).waitFor()
    expect(await ted.listAutomations()).toEqual([])
    expect((await ted.listTasks()).map((t) => t.title)).toContain('Crash on open')

    await writeFile(path.join(home, 'stub-claude.json'), JSON.stringify({ resumeFails: true }))
    const triage = await ted.createAutomation({
      factory: 'NB',
      name: 'Daily triage',
      schedule: { kind: 'weekdays', at: '09:00' },
      on: false,
      prompt: steps({ say: 'Starting' }, { exit: 3 }),
    })
    const failures = async (count: number) =>
      waitUntil(
        async () => {
          const { history: rows } = await history(ted, triage.id)
          return rows.length === count && rows.every((r) => r.result.kind === 'failed')
            ? rows
            : undefined
        },
        `${count} failures`,
        40_000,
      )
    await ted.runAutomation(triage.id)
    await failures(1)
    await ted.runAutomation(triage.id)
    await failures(2)

    await openAutomations(window)
    const pageRow = window.getByRole('row').filter({ hasText: 'Daily triage' })
    await pageRow.getByText(/^Failed/).waitFor()
    await pageRow.getByRole('button', { name: 'Retry' }).waitFor()
    await sidebar(window).getByRole('img', { name: 'An Automation failed' }).waitFor()

    await pageRow.getByRole('button', { name: 'Daily triage' }).click()
    await view.getByRole('heading', { name: 'Daily triage' }).waitFor()
    const rows = view.locator('tbody tr')
    await expect.poll(() => rows.count()).toBe(2)
    expect(await view.getByRole('button', { name: 'Retry' }).count()).toBe(1)
    expect(await rows.nth(0).getByRole('button', { name: 'Retry' }).count()).toBe(1)
    await rows.nth(0).getByRole('button', { name: 'Retry' }).click()
    await expect.poll(() => rows.count(), { timeout: 40_000 }).toBe(3)
    await rows
      .nth(1)
      .getByText(/^Retried at \d\d:\d\d$/)
      .waitFor()
    expect(await rows.nth(0).locator('td').nth(1).textContent()).toMatch(/^Retryof \d\d:\d\d$/)
    await expect
      .poll(() => view.getByRole('button', { name: 'Retry' }).count(), {
        timeout: 40_000,
      })
      .toBe(1)
    expect(await rows.nth(0).getByRole('button', { name: 'Retry' }).count()).toBe(1)

    await view.getByRole('button', { name: 'Automation actions' }).click()
    await window.getByRole('menuitem', { name: /Duplicate/ }).click()
    await view.getByRole('heading', { name: 'Daily triage copy' }).waitFor()
    const copy = (await ted.listAutomations()).find(
      (a: Automation) => a.name === 'Daily triage copy',
    )
    expect(copy).toMatchObject({ on: false, schedule: { kind: 'weekdays', at: '09:00' } })
  })
})
