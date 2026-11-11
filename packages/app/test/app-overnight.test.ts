import path from 'node:path'
import { expect, test } from 'vitest'
import {
  ctx,
  daemonClient,
  launchApp,
  openAllTasks,
  openSettings,
  setUpAppTests,
  sidebar,
} from './app-harness.ts'
import { closeApp } from './close-app.ts'

setUpAppTests()

test('overnight mode is switched in Settings, shows in the sidebar footer and survives reopening', async () => {
  let window = await launchApp()
  await openAllTasks(window)
  const footerLine = sidebar(window).getByText('Overnight mode is on', { exact: true })
  expect(
    await sidebar(window)
      .getByRole('button', { name: /overnight mode/i })
      .count(),
  ).toBe(0)
  expect(await footerLine.count()).toBe(0)

  await openSettings(window)
  const control = window.getByRole('switch', { name: 'Overnight mode across all Factories' })
  await control.click()
  await expect.poll(() => control.getAttribute('aria-checked')).toBe('true')
  expect((await (await daemonClient()).getSettings()).overnightMode).toBe(true)
  await window.getByText(/Stays on until you turn it off/).waitFor()
  const screenshots = process.env.TED_OVERNIGHT_SCREENSHOT_DIR
  if (screenshots) {
    await window.getByRole('group', { name: 'Overnight mode', exact: true }).screenshot({
      path: path.join(screenshots, 'settings.png'),
    })
  }
  await window.keyboard.press('Escape')
  await footerLine.waitFor()
  if (screenshots) await window.screenshot({ path: path.join(screenshots, 'sidebar.png') })

  await (await daemonClient()).updateSettings({ overnightMode: false })
  await footerLine.waitFor({ state: 'detached' })
  await (await daemonClient()).updateSettings({ overnightMode: true })
  await footerLine.waitFor()
  await closeApp(ctx.app)
  ctx.app = undefined
  window = await launchApp()
  await sidebar(window).getByText('Overnight mode is on', { exact: true }).waitFor()
  expect(
    await sidebar(window)
      .getByRole('button', { name: /overnight mode/i })
      .count(),
  ).toBe(0)
})
