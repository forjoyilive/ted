import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from 'vitest'
import { makeOriginRepo } from '../../daemon/test/helpers.ts'
import {
  addFactory,
  ctx,
  daemonClient,
  launchApp,
  openAllTasks,
  setUpAppTests,
  taskRow,
} from './app-harness.ts'

setUpAppTests()

test('snoozes from Task actions with app time preferences and shows the saved date', async () => {
  await addFactory(await makeOriginRepo(path.join(ctx.home, 'origin')), 'NB')
  const client = await daemonClient()
  await client.updateSettings({ timeZone: 'Asia/Kolkata', timeFormat: '24-hour' })
  const task = await client.createTask({
    factory: 'NB',
    title: 'Review dependencies next month',
    start: false,
  })
  const window = await launchApp()
  await window.setViewportSize({ width: 1280, height: 850 })
  await openAllTasks(window)
  await taskRow(window, task.displayId).click()
  const actions = window.getByRole('button', { name: 'Task actions' }).last()
  await actions.click()
  await window.getByRole('menuitem', { name: 'Snooze…', exact: true }).click()
  const dialog = window.getByRole('dialog', { name: 'Snooze Task', exact: true })
  await dialog.getByLabel('Date', { exact: true }).fill('2099-11-11')
  await dialog.getByLabel('Hour', { exact: true }).selectOption('9')
  await dialog.getByLabel('Minute', { exact: true }).selectOption('15')
  await dialog.getByText(/Time zone: Asia\/Kolkata/).waitFor()
  if (process.env.TED_SNOOZE_SCREENSHOTS) {
    await mkdir(process.env.TED_SNOOZE_SCREENSHOTS, { recursive: true })
    await window.screenshot({ path: path.join(process.env.TED_SNOOZE_SCREENSHOTS, 'dialog.png') })
  }
  await dialog.getByRole('button', { name: 'Snooze Task', exact: true }).click()
  await expect
    .poll(async () => (await client.listTasks()).find((t) => t.id === task.id)?.snoozedUntil)
    .toBe('2099-11-11T03:45:00.000Z')
  await window
    .getByText(/Scheduled · 11 Nov,? 09:15/)
    .first()
    .waitFor()
  if (process.env.TED_SNOOZE_SCREENSHOTS)
    await window.screenshot({
      path: path.join(process.env.TED_SNOOZE_SCREENSHOTS, 'scheduled.png'),
    })
  await actions.click()
  await window.getByRole('menuitem', { name: 'Change snooze…', exact: true }).click()
  await window
    .getByRole('dialog', { name: 'Change snooze' })
    .getByRole('button', { name: 'Cancel', exact: true })
    .click()
  await actions.click()
  await window.getByRole('menuitem', { name: 'Cancel snooze', exact: true }).click()
  await expect
    .poll(async () => (await client.listTasks()).find((t) => t.id === task.id)?.snoozedUntil)
    .toBeUndefined()
})
