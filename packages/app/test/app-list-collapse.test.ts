import { mkdtemp } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type ElectronApplication, _electron as electron } from 'playwright'
import { expect, test } from 'vitest'
import { daemonAsApp, makeOriginRepo, removeHome, stopDaemonIn } from '../../daemon/test/helpers.ts'
import { buildRenderer } from './build-renderer.ts'
import { closeApp } from './close-app.ts'
import { loadedWindow } from './first-window.ts'

test('Backlog stays collapsed after visiting Inbox and reloading the app', async () => {
  await buildRenderer()
  const home = await mkdtemp(path.join(tmpdir(), 'ted-list-collapse-'))
  let app: ElectronApplication | undefined
  try {
    const env = { ...process.env, TED_HOME: home, TED_HIDDEN_WINDOW: '1' }
    const origin = await makeOriginRepo(path.join(home, 'origin'))
    const daemon = await daemonAsApp(home, env)
    await daemon.addFactory({ repo: origin, key: 'NB' })
    await daemon.createTask({ factory: 'NB', title: 'Remember collapsed groups' })
    app = await electron.launch({
      executablePath: createRequire(import.meta.url)('electron') as string,
      args: [fileURLToPath(new URL('..', import.meta.url))],
      env,
    })
    const window = await loadedWindow(app)
    const allTasks = () => window.getByRole('button', { name: 'All Tasks', exact: true })
    const backlog = () => window.getByRole('main').getByRole('button', { name: /^Backlog/ })
    await allTasks().click()
    await backlog().click()
    await window.getByRole('button', { name: /^Inbox/ }).click()
    await allTasks().click()
    expect(await backlog().getAttribute('aria-expanded')).toBe('false')
    expect(await window.getByRole('row', { name: /Remember collapsed groups/ }).count()).toBe(0)
    if (process.env.TED_LIST_COLLAPSE_SCREENSHOT) {
      await window.screenshot({ path: process.env.TED_LIST_COLLAPSE_SCREENSHOT })
    }
    await window.reload()
    await allTasks().click()
    expect(await backlog().getAttribute('aria-expanded')).toBe('false')
    await backlog().click()
    await window.getByRole('row', { name: /Remember collapsed groups/ }).waitFor()
  } finally {
    await closeApp(app)
    await stopDaemonIn(home)
    await removeHome(home)
  }
}, 90_000)
