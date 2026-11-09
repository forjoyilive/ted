import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tedVersion } from '@ted/protocol'
import { type ElectronApplication, _electron as electron, type Page } from 'playwright'
import { build } from 'vite'
import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { startDaemon } from '../../daemon/src/index.ts'
import {
  api,
  editEventlog,
  pretendStateSchemaChanged,
  stopDaemonIn,
} from '../../daemon/test/helpers.ts'
import { closeApp } from './close-app.ts'

const appDir = fileURLToPath(new URL('..', import.meta.url))
const electronPath = createRequire(import.meta.url)('electron') as string

let home: string
let app: ElectronApplication | undefined

beforeAll(async () => {
  await build({ configFile: path.join(appDir, 'vite.config.ts'), logLevel: 'warn' })
})

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'ted-app-data-'))
})

afterEach(async () => {
  await closeApp(app)
  app = undefined
  await stopDaemonIn(home)
  await rm(home, { recursive: true, force: true })
})

async function launchApp(): Promise<Page> {
  app = await electron.launch({
    executablePath: electronPath,
    args: [appDir],
    env: { ...process.env, TED_HOME: home, TED_IDLE_EXIT_MS: '30000', TED_HIDDEN_WINDOW: '1' },
  })
  const window = await app.firstWindow()
  await window.emulateMedia({ colorScheme: null })
  return window
}

async function withDaemon(
  version: string,
  work: (ted: ReturnType<typeof api>) => Promise<unknown>,
): Promise<void> {
  const daemon = await startDaemon({ home, version })
  try {
    await work(api(daemon.port, { appKey: daemon.appToken }))
  } finally {
    await daemon.stop()
  }
}

const sidebar = (window: Page) => window.getByRole('navigation', { name: 'Sidebar' })

describe('data screens', () => {
  test('a store from a newer TED shows “This data needs TED 9.0 or later”, and its backup restores', async () => {
    await withDaemon('0.0.1', (ted) => ted.call('POST', '/tasks', { title: 'Fix login' }))
    await pretendStateSchemaChanged(home)
    await withDaemon('9.0.0', (ted) => ted.call('PATCH', '/settings', { appearance: 'dark' }))
    await editEventlog(
      home,
      `UPDATE eventlog SET name = 'v9.FromTheFuture' WHERE name IN ('v1.AppearanceChanged', 'v1.MachineSettingsChanged')`,
    )

    const window = await launchApp()

    await window.getByRole('heading', { name: 'This data needs TED 9.0 or later' }).waitFor()
    await window
      .getByText(`was last opened by TED 9.0.0. This is TED ${tedVersion}, which can’t read it.`, {
        exact: false,
      })
      .waitFor()
    await window.getByRole('button', { name: 'Download TED 9.0' }).waitFor()
    await window.getByText(/^Loses changes since \d{1,2} \w{3} \d{4}, \d{2}:\d{2}\.$/).waitFor()
    expect(await sidebar(window).count()).toBe(0)

    await window.getByRole('button', { name: 'Copy report' }).click()
    await window.getByRole('button', { name: 'Copied' }).waitFor()
    const report = await app?.evaluate(({ clipboard }) => clipboard.readText())
    expect(report).toContain('"state": "needs-newer"')

    await window.getByRole('button', { name: 'Restore the backup from before the update' }).click()

    await sidebar(window).waitFor()
    await sidebar(window).getByRole('button', { name: 'All Tasks' }).click()
    await window.getByRole('row').filter({ hasText: 'Fix login' }).waitFor()
  })

  test('a failed rebuild shows “TED couldn’t update its data” with where it stopped', async () => {
    await withDaemon('0.0.1', async (ted) => {
      await ted.call('POST', '/tasks', { title: 'Fix login' })
      await ted.call('POST', '/tasks', { title: 'Add dark mode' })
    })
    await pretendStateSchemaChanged(home)
    await editEventlog(
      home,
      `UPDATE eventlog SET argsJson = '{}' WHERE seqNumGlobal = (SELECT MAX(seqNumGlobal) FROM eventlog)`,
    )

    const window = await launchApp()

    await window.getByRole('heading', { name: 'TED couldn’t update its data' }).waitFor()
    await window.getByText('Rebuild stopped at event 4 of 4').waitFor()
    await window
      .getByText(
        /^Loses changes since \d{1,2} \w{3} \d{4}, \d{2}:\d{2}, when TED 0\.0\.1 last ran\.$/,
      )
      .waitFor()
    await window.getByText('Runs keep going in the background.', { exact: false }).waitFor()

    const closed = new Promise<void>((resolve) => app?.once('close', () => resolve()))
    await window.getByRole('button', { name: 'Quit TED' }).click()
    await closed
    app = undefined
  })

  test('a failed daily backup shows a warning banner', async () => {
    await writeFile(path.join(home, 'backups'), 'not a folder')

    const window = await launchApp()

    await sidebar(window).waitFor()
    await window
      .getByRole('status')
      .getByText(`Today’s backup failed: ${path.join(home, 'backups')} isn’t a folder`)
      .waitFor()
  })
})
