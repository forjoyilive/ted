import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { makeOriginRepo } from '../../daemon/test/helpers.ts'
import {
  addFactory,
  ctx,
  daemonClient,
  launchApp,
  openAllTasks,
  openFactoryView,
  openSettings,
  settingsNav,
  setUpAppTests,
  taskRow,
  ted,
} from './app-harness.ts'
import { closeApp } from './close-app.ts'

setUpAppTests()

const captures = fileURLToPath(
  new URL('../../../node_modules/.cache/ted-100/app/', import.meta.url),
)

test('text size changes by 5%, survives relaunch, and keeps terminal size and pane width independent', async () => {
  let window = await launchApp()
  await openSettings(window)
  let client = await daemonClient()
  const textSize = () => window.locator('output').filter({ hasText: /^\d+%$/ })
  const titleSize = () =>
    window
      .getByRole('heading', { name: 'General', exact: true })
      .evaluate((el) => getComputedStyle(el).fontSize)
  const sidebarWidth = () => settingsNav(window).evaluate((el) => el.getBoundingClientRect().width)
  const baseWidth = await sidebarWidth()
  expect(await textSize().textContent()).toBe('100%')
  expect(await titleSize()).toBe('22px')
  await window.getByRole('button', { name: 'Increase text size' }).click()
  await expect.poll(() => titleSize()).toBe('23.1px')
  await expect
    .poll(() => client.getSettings())
    .toMatchObject({ textSize: 105, terminalFontSize: 13 })
  await closeApp(ctx.app)
  ctx.app = undefined
  window = await launchApp()
  client = await daemonClient()
  await openSettings(window)
  expect(await textSize().textContent()).toBe('105%')
  for (const size of [80, 100, 150, 200]) {
    await client.updateSettings({ textSize: size })
    await expect.poll(() => textSize().textContent()).toBe(`${size}%`)
    await expect.poll(() => titleSize()).toBe(`${(22 * size) / 100}px`)
    expect(await sidebarWidth()).toBe(baseWidth)
    expect(
      await window.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--terminal-font-size'),
      ),
    ).toBe('13px')
    if (size === 80)
      expect(await window.getByRole('button', { name: 'Decrease text size' }).isDisabled()).toBe(
        true,
      )
    if (size === 200)
      expect(await window.getByRole('button', { name: 'Increase text size' }).isDisabled()).toBe(
        true,
      )
    await mkdir(captures, { recursive: true })
    await window.screenshot({ path: path.join(captures, `settings-${size}.png`) })
  }
  await window.getByRole('button', { name: 'Default', exact: true }).click()
  await expect.poll(() => titleSize()).toBe('22px')
  await expect.poll(() => client.getSettings()).toMatchObject({ textSize: 100 })
})

test('large app text fits settings controls, Task lists, details and a new Task dialog', async () => {
  const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
  await addFactory(origin, 'NB')
  await ted('task', 'create', '--factory', 'NB', 'A comfortably readable Task')
  const window = await launchApp()
  const client = await daemonClient()
  await client.updateSettings({ textSize: 200, appearance: 'dark' })
  await expect
    .poll(() => window.evaluate(() => getComputedStyle(document.body).fontSize))
    .toBe('28px')
  await openAllTasks(window)
  await taskRow(window, 'NB-1').waitFor()
  await mkdir(captures, { recursive: true })
  await window.screenshot({ path: path.join(captures, 'list-200.png') })
  await openFactoryView(window, 'widgets', 'Board')
  await window.getByRole('region', { name: 'Backlog', exact: true }).waitFor()
  await window.screenshot({ path: path.join(captures, 'board-200.png') })
  await openAllTasks(window)
  await taskRow(window, 'NB-1').click()
  await window.getByRole('region', { name: 'Task thread' }).waitFor()
  const details = window.getByRole('complementary', { name: 'Task details' })
  expect(
    await details
      .locator('dl')
      .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length),
  ).toBe(1)
  const overflow = await details
    .locator('dd')
    .evaluateAll((items) =>
      items.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent),
    )
  expect(overflow).toEqual([])
  await window.screenshot({ path: path.join(captures, 'task-200.png') })
  await window.keyboard.press('Meta+n')
  await window.getByRole('dialog', { name: 'New Task', exact: true }).waitFor()
  await window.screenshot({ path: path.join(captures, 'new-task-200.png') })
  await window.keyboard.press('Escape')
  await openSettings(window)
  await ctx.app?.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setSize(1000, 800),
  )
  const increase = window.getByRole('button', { name: 'Increase text size' })
  await increase.scrollIntoViewIfNeeded()
  const box = await increase.boundingBox()
  expect(box).not.toBeNull()
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
    window.viewportSize()?.width ?? 1000,
  )
  await window.screenshot({ path: path.join(captures, 'settings-200-narrow-dark.png') })
})

test('Run chat and a thread Comment use the text scale', async () => {
  const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
  await addFactory(origin, 'NB')
  const message = 'Larger chat text stays readable.'
  const steps = JSON.stringify({ steps: [{ say: message }, { endTurn: true }] })
  await ted('task', 'create', '--factory', 'NB', '--start', steps)
  const window = await launchApp()
  const client = await daemonClient()
  await client.updateSettings({ textSize: 200 })
  await client.postComment('NB-1', 'A readable Comment in the Task thread.')
  await openAllTasks(window)
  await taskRow(window, 'NB-1').click()
  const thread = window.getByRole('region', { name: 'Task thread' })
  const comment = thread.getByText('A readable Comment in the Task thread.', { exact: true })
  await comment.waitFor()
  expect(await comment.evaluate((el) => getComputedStyle(el).fontSize)).toBe('28px')
  await expect.poll(async () => (await client.listTaskRuns('NB-1')).length).toBeGreaterThan(0)
  const run = (await client.listTaskRuns('NB-1'))[0]
  if (!run) throw new Error('no Task Lead Run')
  await window.getByRole('tab', { name: 'Runs' }).click()
  await window.locator(`[data-run="${run.id}"]`).getByRole('button').first().click()
  const chat = window.getByRole('region', { name: 'Run chat' })
  await chat.getByText(message, { exact: true }).waitFor()
  await mkdir(captures, { recursive: true })
  await window.screenshot({ path: path.join(captures, 'chat-200.png') })
  await client.updateSettings({ textSize: 100 })
  await expect
    .poll(() =>
      chat.getByText(message, { exact: true }).evaluate((el) => getComputedStyle(el).fontSize),
    )
    .toBe('14px')
})
