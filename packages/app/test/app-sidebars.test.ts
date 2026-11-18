import { cp, mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { Locator, Page } from 'playwright'
import { expect, test } from 'vitest'
import { makeOriginRepo } from '../../daemon/test/helpers.ts'
import {
  addFactory,
  ctx,
  daemonClient,
  launchApp,
  openAllTasks,
  openSettings,
  settingsNav,
  setUpAppTests,
  taskRow,
} from './app-harness.ts'

setUpAppTests()

const value = (divider: Locator) => divider.getAttribute('aria-valuenow').then(Number)

async function drag(window: Page, divider: Locator, distance: number) {
  const box = await divider.boundingBox()
  if (!box) throw new Error('Missing sidebar divider')
  await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await window.mouse.down()
  await window.mouse.move(box.x + box.width / 2 + distance, box.y + box.height / 2, { steps: 8 })
  await window.mouse.up()
}

async function capture(window: Page, name: string) {
  const directory = process.env.TED_SIDEBAR_SCREENSHOTS
  if (!directory) return
  await mkdir(directory, { recursive: true })
  await window.screenshot({ path: path.join(directory, name) })
}

test('sidebars resize, persist, fit the window and share navigation width with Settings', async () => {
  const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
  await addFactory(origin, 'NB')
  for (const { name, key } of [
    { name: 'gadgets', key: 'NC' },
    { name: 'gizmos', key: 'ND' },
  ]) {
    const copy = path.join(path.dirname(origin), `${name}.git`)
    await cp(origin, copy, { recursive: true })
    await addFactory(copy, key)
  }
  const client = await daemonClient()
  await client.createTask({
    factory: 'NB',
    title: 'Allow the user to change the width of the sidebars',
    description: 'Resize either sidebar to give Task details more room.',
    start: false,
  })
  const window = await launchApp()
  await ctx.app?.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setSize(1280, 900),
  )
  await openAllTasks(window)
  await taskRow(window, 'Allow the user to change the width').click()
  const navigation = window.getByRole('separator', { name: 'Navigation sidebar width' })
  const details = window.getByRole('separator', { name: 'Details sidebar width' })
  await details.waitFor()
  expect(await value(navigation)).toBe(210)
  expect(await value(details)).toBe(320)
  await capture(window, 'default.png')
  await drag(window, navigation, 60)
  await drag(window, details, -120)
  expect(await value(navigation)).toBe(270)
  expect(await value(details)).toBe(440)
  expect(
    await window
      .getByRole('complementary', { name: 'Task details' })
      .evaluate((aside) => Math.round(aside.getBoundingClientRect().width)),
  ).toBe(440)
  await capture(window, 'resized.png')
  await details.focus()
  await window.keyboard.press('ArrowRight')
  await window.keyboard.press('Shift+ArrowLeft')
  expect(await value(details)).toBe(470)
  await window.reload()
  await openAllTasks(window)
  await taskRow(window, 'Allow the user to change the width').click()
  await details.waitFor()
  expect([await value(navigation), await value(details)]).toEqual([270, 470])
  await ctx.app?.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setSize(900, 900),
  )
  await expect.poll(() => value(details)).toBe(310)
  await expect
    .poll(() =>
      window
        .getByRole('region', { name: 'Task thread' })
        .evaluate((pane) => Math.round(pane.getBoundingClientRect().width)),
    )
    .toBe(320)
  await ctx.app?.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setSize(1280, 900),
  )
  await expect.poll(() => value(details)).toBe(470)
  await details.dblclick()
  expect(await value(details)).toBe(320)
  await openSettings(window)
  await settingsNav(window).waitFor()
  expect(await value(navigation)).toBe(270)
  expect(await details.count()).toBe(0)
  await navigation.focus()
  await window.keyboard.press('ArrowLeft')
  expect(await value(navigation)).toBe(260)
  await window.keyboard.press('Escape')
  await details.waitFor()
  expect(await value(navigation)).toBe(260)

  const sidebar = window.getByRole('navigation', { name: 'Sidebar' })
  const views = sidebar.getByRole('button', { name: 'Views', exact: true, expanded: false })
  for (let left = await views.count(); left > 0; left--) await views.first().click()
  expect(await views.count()).toBe(0)
  await ctx.app?.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.setSize(1280, 560),
  )
  await expect.poll(() => window.evaluate(() => globalThis.innerHeight)).toBeLessThan(600)
  const top = (name: string) =>
    sidebar
      .getByRole('button', { name, exact: true })
      .first()
      .evaluate((b) => b.getBoundingClientRect().top)
  const dashboardTop = await top('Dashboard')
  const factoryList = sidebar.getByRole('article').first().locator('xpath=../..')
  const scroll = () =>
    factoryList.evaluate((list) => ({
      overflows: list.scrollHeight > list.clientHeight,
      sidebarScrolls:
        (list.parentElement?.scrollHeight ?? 0) > (list.parentElement?.clientHeight ?? 0),
    }))
  expect(await scroll()).toEqual({ overflows: true, sidebarScrolls: false })
  await capture(window, 'factory-list-scrolls.png')
  await factoryList.evaluate((list) => list.scrollTo({ top: list.scrollHeight }))
  expect(await top('Dashboard')).toBe(dashboardTop)
  const settings = sidebar.getByRole('button', { name: /^Settings/ }).last()
  expect(
    await settings.evaluate((b) => b.getBoundingClientRect().bottom <= globalThis.innerHeight),
  ).toBe(true)
  await capture(window, 'factory-list-scrolled.png')

  const edges = () =>
    factoryList.evaluate((list) => {
      const style = getComputedStyle(list)
      const clear = 'rgba(0, 0, 0, 0)'
      return { above: style.borderTopColor !== clear, below: style.borderBottomColor !== clear }
    })
  await expect.poll(edges).toEqual({ above: true, below: false })
  await factoryList.evaluate((list) => list.scrollTo({ top: 0 }))
  await expect.poll(edges).toEqual({ above: false, below: true })

  const rows = factoryList.locator(':scope > div > article')
  const names = () => rows.evaluateAll((all) => all.map((row) => row.getAttribute('aria-label')))
  const [first, ...rest] = await names()
  const start = await rows.first().boundingBox()
  const list = await factoryList.boundingBox()
  if (!start || !list) throw new Error('Missing Factory list')
  const x = start.x + start.width / 2
  await window.mouse.move(x, start.y + start.height / 2)
  await window.mouse.down()
  await window.mouse.move(x, start.y + start.height, { steps: 4 })
  const edgeY = list.y + list.height - 6
  let nudge = 0
  await expect
    .poll(async () => {
      nudge = 1 - nudge
      await window.mouse.move(x + nudge, edgeY)
      return factoryList.evaluate((box) => box.scrollTop + box.clientHeight >= box.scrollHeight - 1)
    })
    .toBe(true)
  const end = await factoryList.locator(':scope > div').last().boundingBox()
  if (!end) throw new Error('Missing end of the Factory list')
  await window.mouse.move(x, end.y + end.height / 2, { steps: 2 })
  await window.mouse.up()
  await expect.poll(names).toEqual([...rest, first])
})
