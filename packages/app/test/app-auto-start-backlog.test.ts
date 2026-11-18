import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { makeOriginRepo } from '../../daemon/test/helpers.ts'
import {
  addFactory,
  ctx,
  daemonClient,
  launchApp,
  openAllTasks,
  setUpAppTests,
  waitFor,
} from './app-harness.ts'

setUpAppTests()

describe('automatic Backlog starts', () => {
  test('All Tasks turns them on for a chosen Factory and saves on this machine at once', async () => {
    await addFactory(await makeOriginRepo(path.join(ctx.home, 'origin')), 'NB')
    const window = await launchApp()
    await window.setViewportSize({ width: 1280, height: 800 })
    await openAllTasks(window)
    await window.getByRole('button', { name: 'Backlog starts: Off' }).click()
    const autoStart = window.getByRole('switch', { name: 'Start Backlog Tasks automatically' })
    await autoStart.click()
    await waitFor(async () => (await autoStart.getAttribute('aria-checked')) === 'true')
    await window.getByRole('checkbox', { name: /widgets/ }).click()
    const client = await daemonClient()
    const [factory] = await client.listFactories()
    await waitFor(async () => {
      const { backlogStarts } = await client.getSettings()
      return backlogStarts.enabled && backlogStarts.factoryIds.includes(factory?.id ?? '')
    })
    expect(await window.getByRole('button', { name: 'Backlog starts: widgets' }).count()).toBe(1)
    if (process.env.TED_SETTINGS_SCREENSHOT) {
      await mkdir(path.dirname(process.env.TED_SETTINGS_SCREENSHOT), { recursive: true })
      await window.screenshot({ path: process.env.TED_SETTINGS_SCREENSHOT })
    }
  })
})
