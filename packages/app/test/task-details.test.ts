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

  test('tabs run in order, arrow keys move between them, and a restart opens on Details', async () => {
    await taskAtDesignGate()
    let window = await launch()
    const details = window.getByRole('complementary', { name: 'Task details' })
    await details
      .getByRole('tabpanel', { name: 'Details' })
      .getByRole('heading', { name: 'Details' })
      .waitFor()
    const terms = await details.locator('dt').allTextContents()
    expect(terms).toContain('Autopilot')
    expect(terms).not.toContain('Sign-offs')
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
