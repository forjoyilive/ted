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
  ted,
  twoFactories,
} from './app-harness.ts'
import { closeApp } from './close-app.ts'

setUpAppTests()

describe('TED app frame', () => {
  test('the sidebar lists Factories; the current one opens its Board, List and other Views', async () => {
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    await addFactory(origin, 'NB')
    await ted('task', 'create', '--factory', 'NB', 'Offline editing')
    const window = await launchApp()
    const nav = sidebar(window)
    const factory = nav.getByRole('button', { name: 'widgets' })
    const caret = nav
      .getByRole('article', { name: 'widgets' })
      .getByRole('button', { name: 'Views' })
    await factory.waitFor()
    expect(await caret.getAttribute('aria-expanded')).toBe('false')

    await factory.click()

    expect(await caret.getAttribute('aria-expanded')).toBe('true')
    const board = nav.getByRole('button', { name: 'Board', exact: true })
    expect(await board.getAttribute('aria-current')).toBe('page')
    await window.getByRole('region', { name: 'Backlog' }).getByText('Offline editing').waitFor()
    for (const view of ['List', 'Plans', 'Automations']) {
      await nav.getByRole('button', { name: view, exact: true }).waitFor()
    }

    await nav.getByRole('button', { name: 'All Tasks' }).click()
    expect(await caret.getAttribute('aria-expanded')).toBe('true')
  })

  test('the caret collapses and expands any Factory’s Views, and the app remembers it', async () => {
    await twoFactories()
    let window = await launchApp()
    const views = (w: Page, name: string) =>
      sidebar(w).getByRole('article', { name, exact: true }).getByRole('button', { name: 'Views' })
    const board = (w: Page) => sidebar(w).getByRole('button', { name: 'Board', exact: true })
    await sidebar(window).getByRole('button', { name: 'notebook', exact: true }).click()
    await board(window).waitFor()

    await views(window, 'notebook').click()

    expect(await views(window, 'notebook').getAttribute('aria-expanded')).toBe('false')
    await board(window).waitFor({ state: 'detached' })

    await views(window, 'site').focus()
    await window.keyboard.press('Enter')
    expect(await views(window, 'site').getAttribute('aria-expanded')).toBe('true')
    await board(window).waitFor()

    await closeApp(ctx.app)
    window = await launchApp()
    await views(window, 'site').waitFor()
    expect(await views(window, 'notebook').getAttribute('aria-expanded')).toBe('false')
    expect(await views(window, 'site').getAttribute('aria-expanded')).toBe('true')

    await views(window, 'site').press('Space')
    await board(window).waitFor({ state: 'detached' })
    await sidebar(window).getByRole('button', { name: 'notebook', exact: true }).click()
    expect(await views(window, 'notebook').getAttribute('aria-expanded')).toBe('true')
    await board(window).waitFor()
  })

  test('a Factory added while the app is open appears in the sidebar', async () => {
    const window = await launchApp()
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))

    await addFactory(origin, 'NB')

    await sidebar(window).getByRole('button', { name: 'widgets' }).waitFor()
  })

  test('opening a Task shows a back link to where it came from', async () => {
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    await addFactory(origin, 'NB')
    await ted('task', 'create', '--factory', 'NB', 'Offline editing')
    const window = await launchApp()
    const nav = sidebar(window)
    await nav.getByRole('button', { name: 'widgets' }).click()

    for (const [view, back] of [
      ['Board', '← Board'],
      ['List', '← List'],
      ['All Tasks', '← All Tasks'],
    ] as const) {
      await nav.getByRole('button', { name: view, exact: true }).click()
      await window.getByRole('main').getByText('Offline editing').click()
      await window.getByRole('heading', { name: 'Offline editing' }).waitFor()

      await window.getByRole('button', { name: back }).click()

      await window.getByRole('heading', { name: 'Offline editing' }).waitFor({ state: 'detached' })
    }
  })

  test('Blocked by in Task details adds and removes blockers, and refuses a cycle', async () => {
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    await addFactory(origin, 'NB')
    await ted('task', 'create', '--factory', 'NB', 'Crash when search is empty')
    await ted('task', 'create', '--factory', 'NB', 'Offline editing')
    const window = await launchApp()
    await sidebar(window).getByRole('button', { name: 'widgets' }).click()
    await sidebar(window).getByRole('button', { name: 'List', exact: true }).click()
    await window.getByRole('main').getByText('Offline editing').click()
    const details = window.getByRole('complementary', { name: 'Task details' })

    await details.getByRole('button', { name: 'Add blocker' }).click()
    await details.getByLabel('Find a Task').fill('crash')
    await details.getByRole('option', { name: /NB-1/ }).click()

    await details.getByText('Crash when search is empty').waitFor()
    await window.getByRole('main').getByText('Blocked by').first().waitFor()
    await window.getByText('Starts when NB-1 merges').first().waitFor()

    await window.getByRole('button', { name: '← List' }).click()
    await window.getByRole('main').getByText('Crash when search is empty').click()
    await details.getByRole('button', { name: 'Add blocker' }).click()
    await details.getByLabel('Find a Task').fill('offline')
    await details.getByRole('option', { name: /NB-2/ }).click()
    await details
      .getByText('NB-2 can’t block NB-1: that makes a cycle, NB-1 → NB-2 → NB-1')
      .waitFor()

    await window.getByRole('button', { name: '← List' }).click()
    await window.getByRole('main').getByText('Offline editing').click()
    await details.getByRole('button', { name: 'Remove NB-1' }).click()
    await expect
      .poll(
        async () =>
          (await (await daemonClient()).listTasks()).find((t) => t.displayId === 'NB-2')?.blockedBy,
      )
      .toEqual([])
  })

  test('the theme follows the system appearance', async () => {
    const window = await launchApp()

    await window.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => background(window), { timeout: 5_000 }).toBe(darkApp)
    await window.emulateMedia({ colorScheme: 'light' })
    await expect.poll(() => background(window), { timeout: 5_000 }).toBe(lightApp)
  })

  test('the Appearance setting switches the theme at once, from the app or the daemon', async () => {
    const window = await launchApp()
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

  test('a Help (?) shows its note in a tooltip on hover', async () => {
    const window = await launchApp()
    await ted('task', 'create', 'Fix login')

    await window.getByRole('button', { name: 'Help' }).hover()

    await window
      .getByRole('tooltip')
      .getByText(/need your answer/)
      .waitFor()
  })

  test('fonts and styles load under the renderer’s content security policy', async () => {
    const violations: string[] = []
    ctx.app = await electron.launch({ executablePath: electronPath, args: [appDir], env: env() })
    const window = await ctx.app.firstWindow()
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
    expect(await isFocused(window)).toBe(true)
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

  test('the sidebar + and the View header open it too', async () => {
    const window = await withFactory()

    await sidebar(window).getByRole('button', { name: 'New Task' }).click()
    await dialog(window).waitFor()
    await dialog(window).getByRole('button', { name: 'Close' }).click()
    await dialog(window).waitFor({ state: 'detached' })

    await window.getByRole('main').getByRole('button', { name: 'New Task' }).first().click()
    await dialog(window).waitFor()
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

  test('Start now checked starts the Task at Intake', async () => {
    const window = await withFactory()
    await window.keyboard.press('Meta+N')
    const open = dialog(window)
    await open.getByText('Unchecked puts it in Backlog').waitFor()

    await open.getByLabel('Title').fill('Starts now')
    await open.getByLabel('Description').fill(JSON.stringify({ steps: [{ endTurn: true }] }))
    await open.getByRole('button', { name: 'Create', exact: true }).click()

    await window.getByRole('region', { name: 'Intake' }).getByText('Starts now').waitFor()
  })

  test('Create more keeps the dialog open and clears it', async () => {
    const window = await withFactory()
    await window.keyboard.press('Meta+N')
    const open = dialog(window)

    await open.getByLabel('Title').fill('First')
    await open.getByLabel('Description').fill('One')
    await open.getByLabel('Start now').uncheck()
    await open.getByRole('button', { name: 'Create more' }).click()

    await expect.poll(async () => (await tasks()).map((t) => t.title)).toEqual(['First'])
    expect(await open.isVisible()).toBe(true)
    await expect.poll(() => open.getByLabel('Title').inputValue()).toBe('')
    expect(await open.getByLabel('Description').inputValue()).toBe('')
    expect(await isFocused(window)).toBe(true)
  })

  test('attachments dropped or picked are stored and shown on the Task', async () => {
    const window = await withFactory()
    await window.keyboard.press('Meta+N')
    const open = dialog(window)

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

  test('a blocker from any Factory is stored and the footer says the Task waits for it', async () => {
    await ted('task', 'create', 'Crash when search is empty')
    const window = await withFactory()
    await window.keyboard.press('Meta+N')
    const open = dialog(window)

    await open.getByRole('button', { name: 'Add blocker' }).click()
    await open.getByLabel('Find a Task').fill('crash')
    await open.getByRole('option', { name: /DEV-1/ }).click()
    await open.getByText('Waits as Blocked until DEV-1 merges').waitFor()
    await open.getByLabel('Description').fill('After the crash fix')
    await open.getByRole('button', { name: 'Create', exact: true }).click()

    await open.waitFor({ state: 'detached' })
    const [blocker, task] = await tasks()
    expect(task).toMatchObject({ stage: 'backlog', blockedBy: [blocker?.id] })
  })

  test('More shows Clarify depth and the Task Lead from the Factory, and keeps changes', async () => {
    const window = await withFactory()
    await window.keyboard.press('Meta+N')
    const open = dialog(window)
    const more = open.getByRole('button', { name: /^More/ })
    await open.getByText('Clarify depth Auto · Task Lead Claude').waitFor()
    expect(await more.getAttribute('aria-expanded')).toBe('false')

    await more.click()
    await open.getByRole('radiogroup', { name: 'Clarify depth' }).getByText('Grill').click()
    await open.getByLabel('Agent').selectOption('codex')
    await open.getByLabel('Effort').selectOption('high')
    await more.click()
    await open.getByText('Clarify depth Grill · Task Lead Codex · high').waitFor()
    await open.getByLabel('Description').fill('Deep one')
    await open.getByLabel('Start now').uncheck()
    await open.getByRole('button', { name: 'Create', exact: true }).click()

    await open.waitFor({ state: 'detached' })
    expect((await tasks())[0]).toMatchObject({
      clarifyDepth: 'grilling',
      lead: { agent: 'codex', effort: 'high' },
    })
  })
})
