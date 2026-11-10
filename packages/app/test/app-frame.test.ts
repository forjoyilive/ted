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
  openSettings,
  setUpAppTests,
  sidebar,
  startDaemonAsApp,
} from './app-harness.ts'
import { firstWindow } from './first-window.ts'

setUpAppTests()

describe('TED app frame', () => {
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
    await sidebar(window).waitFor()

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
    await sidebar(window).getByRole('button', { name: 'widgets' }).click()
    return window
  }

  const dialog = (window: Page) => window.getByRole('dialog', { name: 'New Task' })

  const tasks = async () => (await daemonClient()).listTasks()

  const isFocused = (window: Page) =>
    dialog(window)
      .getByLabel('Description')
      .evaluate((el) => el === document.activeElement)

  test('⌘N and C open it with the current Factory selected and the description focused', async () => {
    const window = await withFactory()

    await window.keyboard.press('Meta+N')

    const open = dialog(window)
    await open.waitFor()
    const [factory] = await (await daemonClient()).listFactories()
    expect(await open.getByLabel('Factory').inputValue()).toBe(factory?.id)
    await expect.poll(() => isFocused(window)).toBe(true)
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

  test('Start now unchecked puts the Task in Backlog, titled from the description’s first line', async () => {
    const window = await withFactory()
    await window.keyboard.press('Meta+N')
    const open = dialog(window)

    await open.getByLabel('Description').fill('Search ignores accents\nTyping cafe finds Café.')
    await open.getByLabel('Priority').selectOption('high')
    await open.getByLabel('Start now').uncheck()
    await open.getByText('Waits in Backlog until you start it').waitFor()
    await window.keyboard.press('Meta+Enter')

    await open.waitFor({ state: 'detached' })
    await window
      .getByRole('region', { name: 'Backlog' })
      .getByText('Search ignores accents')
      .waitFor()
    expect(await tasks()).toMatchObject([
      {
        title: 'Search ignores accents',
        description: 'Search ignores accents\nTyping cafe finds Café.',
        priority: 'high',
        stage: 'backlog',
      },
    ])
  })

  test('attachments dropped or picked are stored and shown on the Task', async () => {
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
    await open.getByText('notes.txt').waitFor()
    await open.getByLabel('Attach files').setInputFiles({
      name: 'cafe.png',
      mimeType: 'image/png',
      buffer: Buffer.from('png'),
    })
    await open.getByText('cafe.png').waitFor()
    await open.getByLabel('Description').fill('With files')
    await open.getByLabel('Start now').uncheck()
    await open.getByRole('button', { name: 'Create', exact: true }).click()

    await window.getByRole('main').getByText('With files').click()
    const details = window.getByRole('complementary', { name: 'Task details' })
    await details.getByText('notes.txt').waitFor()
    await details.getByText('cafe.png').waitFor()
    expect((await tasks())[0]?.attachments.map((a) => a.name)).toEqual(['notes.txt', 'cafe.png'])
  })
})
