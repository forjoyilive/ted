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

test('overnight controls share the saved mode across Settings, the sidebar and reopening', async () => {
  let window = await launchApp()
  await openAllTasks(window)
  const on = sidebar(window).getByRole('button', { name: 'Turn on overnight mode' })
  await on.click()
  await sidebar(window).getByText('On · all Factories').waitFor()
  expect((await (await daemonClient()).getSettings()).overnightMode).toBe(true)
  const screenshots = process.env.TED_OVERNIGHT_SCREENSHOT_DIR
  if (screenshots) await window.screenshot({ path: path.join(screenshots, 'sidebar.png') })

  await openSettings(window)
  const control = window.getByRole('switch', { name: 'Overnight mode across all Factories' })
  await expect.poll(() => control.getAttribute('aria-checked')).toBe('true')
  await window.getByText(/Stays on until you turn it off/).waitFor()
  if (screenshots) {
    await window.getByRole('group', { name: 'Overnight mode', exact: true }).screenshot({
      path: path.join(screenshots, 'settings.png'),
    })
  }
  await control.click()
  await expect.poll(() => control.getAttribute('aria-checked')).toBe('false')
  await window.keyboard.press('Escape')
  await sidebar(window).getByRole('button', { name: 'Turn on overnight mode' }).waitFor()

  await (await daemonClient()).updateSettings({ overnightMode: true })
  await sidebar(window).getByRole('button', { name: 'Turn off overnight mode' }).waitFor()
  await closeApp(ctx.app)
  ctx.app = undefined
  window = await launchApp()
  await sidebar(window).getByText('On · all Factories').waitFor()
  await sidebar(window).getByRole('button', { name: 'Turn off overnight mode' }).click()
  await sidebar(window).getByRole('button', { name: 'Turn on overnight mode' }).waitFor()
  expect((await (await daemonClient()).getSettings()).overnightMode).toBe(false)
})
