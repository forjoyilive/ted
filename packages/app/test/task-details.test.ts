import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type ElectronApplication, _electron as electron, type Page } from 'playwright'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  daemonAsApp,
  makeOriginRepo,
  removeHome,
  stopDaemonIn,
  waitUntil,
} from '../../daemon/test/helpers.ts'
import { buildRenderer } from './build-renderer.ts'
import { closeApp } from './close-app.ts'
import { loadedWindow } from './first-window.ts'
import { resolveElectron } from './support/electron-installation.ts'

const briefText = [
  '## Goal\n\nStop the TypeError in SearchPanel.',
  '## Decisions so far\n\n- Guard in SearchPanel.\n- Empty list for an empty query.',
  '## Current state\n\nBoth pull requests open.',
  '## Open questions\n\nNone.',
  '## Next step\n\nYour sign-off.\n',
].join('\n\n')

const appDir = fileURLToPath(new URL('..', import.meta.url))
const electronPath = resolveElectron()
const stubClaudePath = fileURLToPath(
  new URL('../../daemon/test/fixtures/stub-claude.ts', import.meta.url),
)

describe('Task details in the app', () => {
  vi.setConfig({ testTimeout: 90_000 })
  let home: string
  let app: ElectronApplication | undefined

  beforeAll(async () => {
    await buildRenderer()
  })

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'ted-app-details-'))
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
  })

  async function launch(): Promise<Page> {
    app = await electron.launch({ executablePath: electronPath, args: [appDir], env: env() })
    const window = await loadedWindow(app)
    await window.emulateMedia({ colorScheme: null })
    const sidebar = window.getByRole('navigation', { name: 'Sidebar' })
    await sidebar.getByRole('button', { name: 'All Tasks' }).click()
    await window.getByRole('row').filter({ hasText: 'NB-1' }).click()
    await window.getByRole('region', { name: 'Task thread' }).waitFor()
    return window
  }

  async function taskAtDesignGate() {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    const briefFile = path.join(home, 'brief.md')
    await writeFile(briefFile, briefText)
    const gate = [
      { run: ['ted', 'brief', 'write', '--file', briefFile] },
      { run: ['ted', 'outcome', 'advance'] },
      { endTurn: true },
    ]
    const daemon = await daemonAsApp(home, env())
    await daemon.addFactory({ repo: origin, key: 'NB' })
    const task = await daemon.createTask({
      factory: 'NB',
      title: JSON.stringify({ steps: [{ everyMessage: gate }, ...gate] }),
    })
    await daemon.startTask(task.id)
    await waitUntil(
      async () => (await daemon.listInbox()).some((i) => i.request.kind === 'review') || undefined,
      'the Design review',
    )
    return { daemon, task }
  }

  test('Task sign-offs edit, cancel, reset and refresh stale choices while a posted Sign-off stays locked', async () => {
    const { daemon, task } = await taskAtDesignGate()
    const window = await launch()
    const details = window.getByRole('complementary', { name: 'Task details' })
    await details.getByRole('button', { name: 'Use Workflow · Edit' }).click()
    let editor = details.getByRole('region', { name: 'Sign-offs for this Task' })
    await expect(editor.getByLabel('Design', { exact: false }).isDisabled()).resolves.toBe(true)
    const review = () => editor.locator(`select[id="gate-${task.id}-review"]`)
    await review().selectOption('off')
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
    expect((await daemon.taskGates(task.id)).overrides).toEqual({})
    await details.getByRole('button', { name: 'Use Workflow · Edit' }).click()
    await review().selectOption('off')
    await editor.getByRole('button', { name: 'Save', exact: true }).click()
    await details.getByRole('button', { name: '1 overridden · Edit' }).waitFor()
    expect((await daemon.taskGates(task.id)).overrides).toEqual({ review: false })
    await details.getByRole('button', { name: '1 overridden · Edit' }).click()
    const current = await daemon.taskGates(task.id)
    await daemon.setTaskGates(task.id, { overrides: { review: true }, revision: current.revision })
    await editor
      .getByText('The Task or Workflow changed. Reload sign-offs before saving.')
      .waitFor()
    await expect(
      editor.getByRole('button', { name: 'Save', exact: true }).isDisabled(),
    ).resolves.toBe(true)
    await editor.getByRole('button', { name: 'Reload sign-offs' }).click()
    await expect.poll(() => review().inputValue()).toBe('on')
    await editor.getByRole('button', { name: 'Use Workflow', exact: true }).click()
    await editor.getByRole('button', { name: 'Save', exact: true }).click()
    await details.getByRole('button', { name: 'Use Workflow · Edit' }).waitFor()
    expect((await daemon.taskGates(task.id)).overrides).toEqual({})
    await details.getByRole('button', { name: 'Use Workflow · Edit' }).click()
    editor = details.getByRole('region', { name: 'Sign-offs for this Task' })
    await editor.waitFor()
    if (process.env.TED_GATE_SCREENSHOT) {
      await daemon.editTask(task.id, { title: 'Let notes be edited offline.' })
      if (app)
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.setSize(1400, 1050),
        )
      await window.getByRole('heading', { name: 'Let notes be edited offline.' }).waitFor()
      await details.evaluate((element) => {
        element.scrollTop = 0
      })
      await window.screenshot({ path: process.env.TED_GATE_SCREENSHOT })
    }
  })

  test('Grilling keeps a saved Clarify sign-off Off and editable', async () => {
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    const daemon = await daemonAsApp(home, env())
    await daemon.addFactory({ repo: origin, key: 'NB' })
    const task = await daemon.createTask({
      factory: 'NB',
      title: 'Choose the Clarify sign-off',
      clarifyDepth: 'few',
    })
    const before = await daemon.taskGates(task.id)
    await daemon.setTaskGates(task.id, { overrides: { clarify: false }, revision: before.revision })
    const window = await launch()
    const details = window.getByRole('complementary', { name: 'Task details' })
    await details.getByRole('button', { name: '1 overridden · Edit' }).click()
    const editor = details.getByRole('region', { name: 'Sign-offs for this Task' })
    const clarify = editor.getByLabel('Clarify', { exact: true })
    await expect(clarify.inputValue()).resolves.toBe('off')
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
    await daemon.setClarifyDepth(task.id, { depth: 'grilling' })
    await details.getByRole('button', { name: '1 overridden · Edit' }).click()
    await expect(clarify.inputValue()).resolves.toBe('off')
    await expect(clarify.isDisabled()).resolves.toBe(false)
    expect(await editor.getByText('Required at grilling depth', { exact: true }).count()).toBe(0)
    expect((await daemon.taskGates(task.id)).overrides.clarify).toBe(false)
    if (process.env.TED_REQUIRED_GATE_SCREENSHOT) {
      if (app)
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.setSize(1400, 1050),
        )
      for (const theme of ['light', 'dark'] as const) {
        await window.emulateMedia({ colorScheme: theme })
        await window.evaluate((mode) => {
          document.documentElement.style.colorScheme = mode
        }, theme)
        await editor.scrollIntoViewIfNeeded()
        await window.screenshot({
          path: `${process.env.TED_REQUIRED_GATE_SCREENSHOT}-${theme}.png`,
        })
      }
    }
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
    await daemon.setClarifyDepth(task.id, { depth: 'few' })
    await details.getByRole('button', { name: '1 overridden · Edit' }).click()
    await expect(clarify.inputValue()).resolves.toBe('off')
    await expect(clarify.isDisabled()).resolves.toBe(false)
  })

  test('tabs run in order, arrow keys move between them, and a restart opens on Details', async () => {
    await taskAtDesignGate()
    let window = await launch()
    const details = window.getByRole('complementary', { name: 'Task details' })
    await details
      .getByRole('tabpanel', { name: 'Details' })
      .getByRole('heading', { name: 'Details' })
      .waitFor()
    expect(
      await details
        .getByRole('tablist', { name: 'Task details sections' })
        .getByRole('tab')
        .evaluateAll((els) => els.map((e) => e.ariaLabel)),
    ).toEqual(['Details', 'Code', 'Changes', 'Files', 'Runs', 'Apps'])
    expect(await details.getByRole('region', { name: 'Task brief' }).count()).toBe(0)
    await window.getByRole('button', { name: 'Brief', exact: true }).click()
    const full = window.getByRole('region', { name: 'Full brief' })
    await full.getByText('Stop the TypeError in SearchPanel.').waitFor()
    await full.getByText('Your sign-off.', { exact: true }).waitFor()
    await full.getByRole('button', { name: '← Task Lead' }).click()

    await details.getByRole('tab', { name: 'Runs' }).click()
    const runs = details.getByRole('tabpanel', { name: 'Runs' })
    await runs.getByText(/^Task Lead (idle|working)/).waitFor()
    await runs.getByRole('list').first().waitFor()
    await details.getByRole('tab', { name: 'Runs' }).press('ArrowLeft')
    await details.getByRole('tabpanel', { name: 'Files' }).waitFor()
    await expect
      .poll(() => window.evaluate(() => document.activeElement?.getAttribute('aria-label')))
      .toBe('Files')
    await window.keyboard.press('End')
    await details.getByRole('tabpanel', { name: 'Apps' }).waitFor()

    await closeApp(app)
    window = await launch()
    await window
      .getByRole('complementary', { name: 'Task details' })
      .getByRole('tabpanel', { name: 'Details' })
      .waitFor()
  })
})
