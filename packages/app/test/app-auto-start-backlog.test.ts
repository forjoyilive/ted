import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { makeOriginRepo } from '../../daemon/test/helpers.ts'
import {
  addFactory,
  ctx,
  daemonClient,
  launchApp,
  setUpAppTests,
  sidebar,
  waitFor,
} from './app-harness.ts'

setUpAppTests()

describe('automatic Backlog starting settings', () => {
  test('saves immediately without the repository Save dialog', async () => {
    await addFactory(await makeOriginRepo(path.join(ctx.home, 'origin')), 'NB')
    const window = await launchApp()
    await window.setViewportSize({ width: 1280, height: 800 })
    await sidebar(window).getByRole('button', { name: 'widgets' }).click()
    await sidebar(window).getByRole('button', { name: 'Settings', exact: true }).first().click()
    const autoStart = window.getByRole('switch', { name: 'Start Backlog Tasks automatically' })
    expect(await autoStart.getAttribute('aria-checked')).toBe('false')
    await autoStart.click()
    await waitFor(async () => (await autoStart.getAttribute('aria-checked')) === 'true')
    const client = await daemonClient()
    expect((await client.listFactories())[0]?.autoStartBacklog).toBe(true)
    expect(await window.getByRole('button', { name: 'Review and save…' }).count()).toBe(0)
    await autoStart.click()
    await waitFor(async () => (await autoStart.getAttribute('aria-checked')) === 'false')
    if (process.env.TED_SETTINGS_SCREENSHOT) {
      await mkdir(path.dirname(process.env.TED_SETTINGS_SCREENSHOT), { recursive: true })
      await window.screenshot({ path: process.env.TED_SETTINGS_SCREENSHOT })
    }
  })

  test('automatic Backlog starting disables while saving and keeps the saved value on error', async () => {
    await addFactory(await makeOriginRepo(path.join(ctx.home, 'origin')), 'NB')
    const window = await launchApp()
    await sidebar(window).getByRole('button', { name: 'widgets' }).click()
    await sidebar(window).getByRole('button', { name: 'Settings', exact: true }).first().click()
    const toggle = window.getByRole('switch', { name: 'Start Backlog Tasks automatically' })
    await toggle.waitFor()
    await ctx.app?.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('ted:request')
      ipcMain.handle('ted:request', async () => {
        await new Promise((resolve) => setTimeout(resolve, 500))
        throw new Error('Couldn’t save the Factory option')
      })
    })
    await toggle.click()
    expect(await toggle.isDisabled()).toBe(true)
    expect(await toggle.getAttribute('aria-checked')).toBe('false')
    await window
      .getByRole('alert')
      .filter({ hasText: 'Couldn’t save the Factory option' })
      .waitFor()
    expect(await toggle.isEnabled()).toBe(true)
    expect(await toggle.getAttribute('aria-checked')).toBe('false')
  })
})
