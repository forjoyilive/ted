import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from 'vitest'
import {
  background,
  ctx,
  daemonClient,
  darkApp,
  launchApp,
  lightApp,
  setUpAppTests,
} from './app-harness.ts'

setUpAppTests()

test('usage opens from the sidebar, receives Run reports, fits short windows and opens Agent settings', async () => {
  const window = await launchApp()
  await window.emulateMedia({ colorScheme: 'light' })
  await expect.poll(() => background(window)).toBe(lightApp)
  const tracker = window.getByRole('button', { name: 'Usage', exact: true })
  await tracker.click()
  const panel = window.getByRole('dialog', { name: 'Usage', exact: true })
  await panel.getByText('Shows once a Run has made a request.').waitFor()
  const client = await daemonClient()
  const resetsAt = Math.floor(Date.now() / 1000) + 90 * 60
  await client.startDevRun({
    cwd: ctx.home,
    prompt: JSON.stringify({
      steps: [
        {
          emit: {
            type: 'rate_limit_event',
            rate_limit_info: {
              status: 'allowed',
              rateLimitType: 'five_hour',
              utilization: 0.04,
              resetsAt,
            },
          },
        },
        {
          emit: {
            type: 'rate_limit_event',
            rate_limit_info: {
              status: 'allowed',
              rateLimitType: 'seven_day',
              utilization: 0.08,
              resetsAt: resetsAt + 2 * 86400,
            },
          },
        },
        { endTurn: true },
      ],
    }),
  })
  await tracker.getByText('8%', { exact: true }).waitFor()
  const claude = panel.getByRole('region', { name: 'Claude usage' })
  await expect.poll(() => claude.textContent()).toMatch(/Weekly 2d \dh 8%/)
  expect(await claude.getByRole('progressbar').count()).toBe(0)
  expect(await panel.getByRole('button').allTextContents()).toEqual(['×', 'Provider settings →'])
  await window.keyboard.press('Escape')
  await panel.waitFor({ state: 'detached' })
  expect(await tracker.evaluate((button) => document.activeElement === button)).toBe(true)
  await tracker.click()
  const capture = process.env.TED_USAGE_SCREENSHOTS
  if (capture) {
    await mkdir(capture, { recursive: true })
    await window.screenshot({ path: path.join(capture, 'implemented-light.png') })
  }
  await ctx.app?.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setContentSize(900, 560),
  )
  await tracker.getByText('8%', { exact: true }).waitFor({ state: 'hidden' })
  await expect
    .poll(async () => {
      const box = await panel.boundingBox()
      const height = await window.evaluate(() => globalThis.innerHeight)
      return box !== null && box.y >= 0 && box.y + box.height <= height
    })
    .toBe(true)
  await window.emulateMedia({ colorScheme: 'dark' })
  await expect.poll(() => background(window)).toBe(darkApp)
  if (capture) await window.screenshot({ path: path.join(capture, 'implemented-dark-short.png') })
  await ctx.app?.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setContentSize(900, 800),
  )
  await tracker.getByText('8%', { exact: true }).waitFor()
  await panel.getByRole('button', { name: 'Provider settings', exact: true }).click()
  await window.getByRole('main', { name: 'Providers', exact: true }).waitFor()
  await panel.waitFor({ state: 'detached' })
})
