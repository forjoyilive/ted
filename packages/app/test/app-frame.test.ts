import path from 'node:path'
import { _electron as electron, type Page } from 'playwright'
import { describe, expect, test } from 'vitest'
import { makeOriginRepo } from '../../daemon/test/helpers.ts'
import {
  addFactory,
  appDir,
  background,
  ctx,
  daemonClient,
  darkApp,
  electronPath,
  env,
  launchApp,
  lightApp,
  openFactoryView,
  openSettings,
  setUpAppTests,
  startDaemonAsApp,
} from './app-harness.ts'
import { appLoaded, firstWindow } from './first-window.ts'

setUpAppTests()

describe('Ted app frame', () => {
  test('the Appearance setting switches the theme at once, from the app or the daemon', async () => {
    const window = await launchApp()
    await window.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => background(window), { timeout: 5_000 }).toBe(darkApp)
    await window.emulateMedia({ colorScheme: 'light' })
    await expect.poll(() => background(window), { timeout: 5_000 }).toBe(lightApp)
    await window.emulateMedia({ colorScheme: null })
    await openSettings(window)
    const appearance = window.getByRole('radiogroup', { name: 'Appearance' })

    await appearance.getByText('Dark').click()
    await expect.poll(() => background(window), { timeout: 5_000 }).toBe(darkApp)
    expect((await (await daemonClient()).getSettings()).appearance).toBe('dark')

    await (await daemonClient()).updateSettings({ appearance: 'light' })
    await expect.poll(() => background(window), { timeout: 5_000 }).toBe(lightApp)
    await expect
      .poll(() => appearance.getByRole('radio', { name: 'Light' }).isChecked(), { timeout: 5_000 })
      .toBe(true)
  })

  test('the Appearance setting applies when the app starts', async () => {
    await startDaemonAsApp()
    await (await daemonClient()).updateSettings({ appearance: 'dark' })

    const window = await launchApp()

    await expect.poll(() => background(window), { timeout: 5_000 }).toBe(darkApp)
  })

  test('fonts and styles load under the renderer’s content security policy', async () => {
    const violations: string[] = []
    ctx.app = await electron.launch({ executablePath: electronPath, args: [appDir], env: env() })
    const window = await firstWindow(ctx.app)
    window.on('console', (message) => {
      if (/Content Security Policy/i.test(message.text())) violations.push(message.text())
    })
    await appLoaded(window)

    const loaded = await window.evaluate(async () => {
      const faces = [
        ...(await document.fonts.load('14px "Geist Variable"')),
        ...(await document.fonts.load('12px "Geist Mono Variable"')),
      ]
      return faces.map((face) => `${face.family} ${face.status}`)
    })
    expect(loaded).toEqual(['Geist Variable loaded', 'Geist Mono Variable loaded'])
    expect(violations).toEqual([])
  })
})

describe('New Task dialog', () => {
  async function withFactory(): Promise<Page> {
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    await addFactory(origin, 'NB')
    const window = await launchApp()
    await openFactoryView(window, 'widgets', 'Board')
    return window
  }

  const dialog = (window: Page) => window.getByRole('dialog', { name: 'New Task' })

  const tasks = async () => (await daemonClient()).listTasks()

  const isFocused = (window: Page) =>
    dialog(window)
      .getByLabel('Title')
      .evaluate((el) => el === document.activeElement)

  test('⌘N and C open it with the current Factory selected and the title focused', async () => {
    const window = await withFactory()

    await window.keyboard.press('Meta+N')

    const open = dialog(window)
    await open.waitFor()
    const [factory] = await (await daemonClient()).listFactories()
    expect(await open.getByRole('combobox', { name: 'Factory' }).getAttribute('data-value')).toBe(
      factory?.id,
    )
    await expect.poll(() => isFocused(window)).toBe(true)
    const heading = await open.getByRole('heading', { name: 'New Task' }).boundingBox()
    const picker = await open.getByRole('combobox', { name: 'Factory' }).boundingBox()
    const close = await open.getByRole('button', { name: 'Close' }).boundingBox()
    const dialogBounds = await open.boundingBox()
    if (!heading || !picker || !close || !dialogBounds) throw new Error('header has no bounds')
    expect(picker.x - (heading.x + heading.width)).toBeLessThan(40)
    expect(close.x - (picker.x + picker.width)).toBeGreaterThan(100)
    expect(dialogBounds.x + dialogBounds.width - (close.x + close.width)).toBeLessThan(40)
    await window.keyboard.press('Escape')
    await open.waitFor({ state: 'detached' })

    await window.keyboard.press('c')
    await open.waitFor()
    expect(await open.getByLabel('Description').inputValue()).toBe('')

    await open.getByLabel('Description').fill('Keep editing')
    const bounds = await open.boundingBox()
    if (!bounds) throw new Error('New Task dialog has no bounds')
    await window.mouse.click(bounds.x + 2, bounds.y + 2)
    expect(await open.isVisible()).toBe(true)
    await open.getByRole('heading', { name: 'New Task' }).click()
    expect(await open.getByLabel('Description').inputValue()).toBe('Keep editing')

    await window.mouse.click(bounds.x - 10, bounds.y + bounds.height / 2)
    await open.waitFor({ state: 'detached' })
    await expect.poll(async () => (await tasks()).filter((task) => !task.setup)).toEqual([])
  })

  test('Start now unchecked puts the Task in Backlog with its title and description', async () => {
    const window = await withFactory()
    await window.keyboard.press('Meta+N')
    const open = dialog(window)

    await open.getByLabel('Title').fill('Search ignores accents')
    await open.getByLabel('Description').fill('Typing cafe finds Café.')
    await open.getByLabel('Priority').selectOption('high')
    await open.getByLabel('Start now').uncheck()
    await open.getByText('Waits in Backlog until you start it').waitFor()
    await open
      .locator('label', { hasText: 'Start now' })
      .locator('xpath=..')
      .getByRole('button', { name: 'Help' })
      .hover()
    const tooltip = open.getByRole('tooltip')
    await tooltip.waitFor()
    expect(
      await tooltip.evaluate((element) => {
        const box = element.getBoundingClientRect()
        return [
          [box.left + 2, box.top + 2],
          [box.right - 2, box.bottom - 2],
        ].every(([x, y]) => {
          const hit = document.elementFromPoint(x ?? 0, y ?? 0)
          return hit !== null && element.contains(hit)
        })
      }),
    ).toBe(true)
    await window.mouse.move(0, 0)
    await expect
      .poll(() => open.getByRole('button', { name: 'Create', exact: true }).isEnabled())
      .toBe(true)
    await window.keyboard.press('Meta+Enter')

    await open.waitFor({ state: 'detached' })
    await window
      .getByRole('region', { name: 'Backlog' })
      .getByText('Search ignores accents')
      .waitFor()
    expect(await tasks()).toMatchObject([
      {
        title: 'Search ignores accents',
        description: 'Typing cafe finds Café.',
        priority: 'high',
        stage: 'backlog',
      },
    ])
  })

  test('attachments dropped or picked are stored and shown on the Task', async () => {
    const pixel = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64',
    )
    const window = await withFactory()
    await window.keyboard.press('Meta+N')
    const open = dialog(window)
    await expect.poll(() => open.getByLabel('Description', { exact: true }).isEnabled()).toBe(true)

    const dropped = await window.evaluateHandle(() => {
      const data = new DataTransfer()
      data.items.add(new File(['hello'], 'notes.txt', { type: 'text/plain' }))
      return data
    })
    await open
      .getByRole('button', { name: /Drop files here/ })
      .dispatchEvent('drop', { dataTransfer: dropped })
    const tiles = open.getByRole('list', { name: 'Attached files' })
    await tiles.getByRole('button', { name: 'Remove notes.txt' }).waitFor()
    expect(await tiles.locator('[data-attachment="notes.txt"]').textContent()).toContain('TXT')
    const [chooser] = await Promise.all([
      window.waitForEvent('filechooser'),
      open.getByRole('group', { name: 'Attachments' }).click({ position: { x: 4, y: 20 } }),
    ])
    await chooser.setFiles([
      { name: 'cafe.png', mimeType: 'image/png', buffer: pixel },
      { name: 'map.png', mimeType: 'image/png', buffer: pixel },
    ])
    for (const name of ['cafe.png', 'map.png']) {
      await expect
        .poll(() =>
          tiles.locator(`img[alt="${name}"]`).evaluate((i: HTMLImageElement) => i.naturalWidth),
        )
        .toBe(1)
    }

    await tiles.getByRole('button', { name: 'View cafe.png' }).click()
    await window.getByRole('dialog', { name: 'cafe.png' }).waitFor()
    await window.keyboard.press('ArrowRight')
    await window.getByRole('dialog', { name: 'map.png' }).waitFor()
    await window.keyboard.press('Escape')
    await window.getByRole('dialog', { name: 'map.png' }).waitFor({ state: 'detached' })
    await tiles.getByRole('button', { name: 'View cafe.png' }).focus()
    await window.keyboard.press('ArrowRight')
    expect(
      await tiles
        .getByRole('button', { name: 'View map.png' })
        .evaluate((b) => b === document.activeElement),
    ).toBe(true)
    await tiles.getByRole('button', { name: 'Remove map.png' }).click()
    await tiles.locator('img[alt="map.png"]').waitFor({ state: 'detached' })

    await open.getByLabel('Title').fill('With files')
    await open.getByLabel('Start now').uncheck()
    await open.getByRole('button', { name: 'Create', exact: true }).click()

    await window.getByRole('main').getByText('With files').click()
    const details = window.getByRole('complementary', { name: 'Task details' })
    await details.getByText('notes.txt').waitFor()
    await details.getByText('cafe.png').waitFor()
    expect((await tasks())[0]?.attachments.map((a) => a.name)).toEqual(['notes.txt', 'cafe.png'])

    const thread = window.getByRole('region', { name: 'Task thread' })
    await thread.getByLabel('Choose files to attach').setInputFiles({
      name: 'reply.png',
      mimeType: 'image/png',
      buffer: pixel,
    })
    await thread
      .getByRole('list', { name: 'Attached files' })
      .locator('img[alt="reply.png"]')
      .waitFor()
  })
})
