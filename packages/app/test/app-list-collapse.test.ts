import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { type ElectronApplication, _electron as electron } from 'playwright'
import { expect, test } from 'vitest'
import {
  commitToOrigin,
  daemonAsApp,
  makeOriginRepo,
  removeHome,
  stopDaemonIn,
} from '../../daemon/test/helpers.ts'
import { buildRenderer } from './build-renderer.ts'
import { closeApp } from './close-app.ts'
import { loadedWindow } from './first-window.ts'
import { resolveElectron } from './support/electron-installation.ts'

test('Backlog stays collapsed after visiting Inbox and reloading the app', async () => {
  await buildRenderer()
  const home = await mkdtemp(path.join(tmpdir(), 'ted-list-collapse-'))
  let app: ElectronApplication | undefined
  try {
    const env = { ...process.env, TED_HOME: home, TED_HIDDEN_WINDOW: '1' }
    const originFolder = path.join(home, 'origin')
    const origin = await makeOriginRepo(originFolder)
    await commitToOrigin(originFolder, {
      '.ted/workflow.yaml': 'version: 1\norder: [intake, work, merge]\n',
    })
    const daemon = await daemonAsApp(home, env)
    await daemon.updateSettings({ appearance: 'light' })
    await daemon.addFactory({ repo: origin, key: 'NB' })
    const task = await daemon.createTask({
      factory: 'NB',
      title: 'Remember collapsed groups',
      description: JSON.stringify({
        steps: [{ run: ['ted', 'outcome', 'advance'] }, { endTurn: true }],
      }),
    })
    app = await electron.launch({
      executablePath: resolveElectron(),
      args: [fileURLToPath(new URL('..', import.meta.url))],
      env,
    })
    const window = await loadedWindow(app)
    const allTasks = () => window.getByRole('button', { name: 'All Tasks', exact: true })
    const backlog = () => window.getByRole('main').getByRole('button', { name: /^Backlog\s*\d/ })
    await allTasks().click()
    await backlog().click()
    await window.getByRole('button', { name: /^Inbox/ }).click()
    await allTasks().click()
    expect(await backlog().getAttribute('aria-expanded')).toBe('false')
    expect(await window.getByRole('row', { name: /Remember collapsed groups/ }).count()).toBe(0)
    const size = window.viewportSize()
    await window.setViewportSize({ width: 900, height: 640 })
    const statusHead = window.getByRole('columnheader', { name: 'Status', exact: true })
    const narrow = (await statusHead.boundingBox())?.width ?? 0
    expect(narrow).toBeGreaterThanOrEqual(110)
    expect(narrow).toBeLessThan(300)
    await window.setViewportSize({ width: 1600, height: 640 })
    expect((await statusHead.boundingBox())?.width).toBeCloseTo(300, 0)
    if (size) await window.setViewportSize(size)
    if (process.env.TED_LIST_COLLAPSE_SCREENSHOT) {
      await window.screenshot({ path: process.env.TED_LIST_COLLAPSE_SCREENSHOT })
    }
    await window.reload()
    await allTasks().click()
    expect(await backlog().getAttribute('aria-expanded')).toBe('false')
    await backlog().click()
    await window.getByRole('row', { name: /Remember collapsed groups/ }).waitFor()
    const groupSelection = window.getByRole('checkbox', { name: 'Select all Backlog Tasks' })
    await allTasks().focus()
    await window.mouse.move(0, 0)
    expect(await groupSelection.evaluate((el) => getComputedStyle(el).opacity)).toBe('0')
    await backlog().hover()
    expect(await groupSelection.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
    const captures = process.env.TED_PREPARATION_SCREENSHOT_DIR
    if (captures) await window.screenshot({ path: path.join(captures, 'list-hover.png') })
    await groupSelection.check()
    const rowSelection = window.getByRole('checkbox', { name: `Select ${task.displayId}` })
    const centre = async (box: typeof rowSelection) => {
      const bounds = await box.boundingBox()
      if (!bounds) throw new Error('The checkbox is not visible.')
      return bounds.x + bounds.width / 2
    }
    expect(await centre(groupSelection)).toBeCloseTo(await centre(rowSelection), 0)
    const actions = window.getByRole('toolbar', { name: 'Selected Tasks' })
    await actions.getByRole('button', { name: 'Archive…', exact: true }).waitFor()
    expect(await actions.getByRole('button', { name: 'Clear selection' }).count()).toBe(0)
    if (captures) await window.screenshot({ path: path.join(captures, 'list-selection.png') })
    await actions.getByRole('button', { name: 'Prepare', exact: true }).click()
    const notice = window.getByRole('dialog')
    await notice.getByRole('heading', { name: 'Prepare through Design' }).waitFor()
    if (captures) await window.screenshot({ path: path.join(captures, 'preparation-notice.png') })
    await notice.getByRole('button', { name: 'Cancel' }).click()
    await groupSelection.focus()
    await window.keyboard.press('Escape')
    expect(await actions.count()).toBe(0)
    await daemon.startTask(task.id, { prepare: true })
    await window.getByText('Ready for Work', { exact: true }).waitFor()
    const later = await daemon.createTask({ factory: 'NB', title: 'Not started yet' })
    const headers = await window.locator('thead th').allTextContents()
    expect(headers.slice(-2)).toEqual(['Updated', 'Started'])
    const started = window
      .getByRole('row', { name: /Remember collapsed groups/ })
      .locator('td')
      .last()
    await expect.poll(() => started.textContent()).toBe('now')
    const neverStarted = window
      .getByRole('row', { name: /Not started yet/ })
      .locator('td')
      .last()
    await expect.poll(() => neverStarted.textContent()).toBe('—')
    await daemon.blockTask(later.id, task.id)
    await window.setViewportSize({ width: 900, height: 640 })
    const blockedStatus = window
      .getByRole('row', { name: /Not started yet/ })
      .locator('td')
      .nth(headers.indexOf('Status'))
    await expect.poll(() => blockedStatus.textContent()).toMatch(/^Blocked by ?NB-/)
    const fits = await blockedStatus.evaluate((cell) => {
      const right = cell.getBoundingClientRect().right
      return [...cell.querySelectorAll('*')].every(
        (el) => el.getBoundingClientRect().right <= right + 0.5,
      )
    })
    expect(fits, 'status badges wrap inside the Status cell').toBe(true)
    if (size) await window.setViewportSize(size)
    if (captures) await window.screenshot({ path: path.join(captures, 'ready-for-work.png') })
  } finally {
    await closeApp(app)
    await stopDaemonIn(home)
    await removeHome(home)
  }
}, 90_000)
