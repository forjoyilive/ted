import path from 'node:path'
import { expect, test } from 'vitest'
import { makeOriginRepo } from '../../daemon/test/helpers.ts'
import {
  addFactory,
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

test('Autopilot is switched in Settings, shows in the sidebar footer and survives reopening', async () => {
  let window = await launchApp()
  await openAllTasks(window)
  const footerLine = sidebar(window).getByText('Autopilot is on', { exact: true })
  expect(
    await sidebar(window)
      .getByRole('button', { name: /Autopilot/i })
      .count(),
  ).toBe(0)
  expect(await footerLine.count()).toBe(0)

  const origin = await makeOriginRepo(path.join(ctx.home, 'autopilot-origin'))
  await addFactory(origin, 'NB')
  const client = await daemonClient()
  const first = await client.createTask({ factory: 'NB', title: 'Autopilot sample one' })
  const second = await client.createTask({ factory: 'NB', title: 'Autopilot sample two' })
  await openAllTasks(window)
  if ((await window.getByRole('row').filter({ hasText: first.title }).count()) === 0) {
    await window.getByRole('button', { name: /^Backlog/ }).click()
  }
  const firstRow = () => window.getByRole('row').filter({ hasText: first.title })
  const secondRow = () => window.getByRole('row').filter({ hasText: second.title })
  await firstRow().waitFor()
  expect(await firstRow().getByText('Autopilot on', { exact: true }).count()).toBe(0)
  await window.getByRole('checkbox', { name: `Select ${first.displayId}`, exact: true }).check()
  await window.getByRole('checkbox', { name: `Select ${second.displayId}`, exact: true }).check()
  const bulk = window.getByLabel('Autopilot for selected Tasks', { exact: true })
  await bulk.selectOption('on')
  await firstRow().getByText('Autopilot on', { exact: true }).waitFor()
  await secondRow().getByText('Autopilot on', { exact: true }).waitFor()
  expect((await client.listTasks()).find((t) => t.id === first.id)?.stage).toBe('backlog')
  await bulk.selectOption('off')
  await firstRow().getByText('Autopilot off', { exact: true }).waitFor()
  await bulk.selectOption('inherit')
  await firstRow().getByText('Autopilot off', { exact: true }).waitFor({ state: 'detached' })
  await firstRow().getByText(first.title, { exact: true }).click()
  const field = window.getByLabel('Autopilot', { exact: true })
  await field.selectOption('off')
  await expect
    .poll(async () => (await client.listTasks()).find((t) => t.id === first.id)?.autopilot?.choice)
    .toBe('off')
  await openSettings(window)
  const control = window.getByRole('switch', { name: 'Autopilot across all Factories' })
  await control.click()
  await expect.poll(() => control.getAttribute('aria-checked')).toBe('true')
  expect((await (await daemonClient()).getSettings()).overnightMode).toBe(true)
  await window.getByText(/Stays on until you turn it off/).waitFor()
  const screenshots = process.env.TED_OVERNIGHT_SCREENSHOT_DIR
  if (screenshots) {
    await window.getByRole('group', { name: 'Autopilot', exact: true }).screenshot({
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
  await sidebar(window).getByText('Autopilot is on', { exact: true }).waitFor()
  expect(
    await sidebar(window)
      .getByRole('button', { name: /Autopilot/i })
      .count(),
  ).toBe(0)
})
