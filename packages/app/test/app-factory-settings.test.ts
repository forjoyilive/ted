import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { describe, expect, test } from 'vitest'
import { makeOriginRepo } from '../../daemon/test/helpers.ts'
import {
  addFactory,
  ctx,
  launchApp,
  openFactoryView,
  openSettings,
  run,
  settingsNav,
  setUpAppTests,
  sidebar,
  waitFor,
} from './app-harness.ts'

setUpAppTests()

async function pushFiles(origin: string, files: Record<string, string>): Promise<void> {
  const work = path.join(ctx.home, 'seed-files')
  const git = (...args: string[]) =>
    run('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
      cwd: work,
    })
  await run('git', ['clone', origin, work])
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(work, name)), { recursive: true })
    await writeFile(path.join(work, name), text)
  }
  await git('add', '.')
  await git('commit', '-m', 'Stage files')
  await git('push', 'origin', 'main')
}

describe('Factory settings sections', () => {
  test('permission mode confirms and saves on this computer without a settings pull request', async () => {
    await addFactory(await makeOriginRepo(path.join(ctx.home, 'origin')), 'NB')
    const window = await launchApp()
    await window.setViewportSize({ width: 1280, height: 900 })
    await openFactoryView(window, 'widgets', 'Settings')
    await window
      .getByRole('navigation', { name: 'Factory settings' })
      .getByRole('button', { name: 'Permissions' })
      .click()
    const permissions = window.getByRole('region', { name: 'Permission mode', exact: true })
    await permissions.getByText('Auto is on.').waitFor()
    const captures = path.join(process.cwd(), 'node_modules/.cache/ted-22-design')
    await permissions.screenshot({ path: path.join(captures, 'app-auto.png') })
    await permissions.getByRole('button', { name: 'Enable Bypass…' }).click()
    const dialog = window.getByRole('dialog', { name: 'Enable Bypass on this computer?' })
    const enable = dialog.getByRole('button', { name: 'Enable Bypass', exact: true })
    expect(await enable.isDisabled()).toBe(true)
    await window.screenshot({ path: path.join(captures, 'app-confirmation.png') })
    await dialog.getByRole('checkbox').check()
    await enable.click()
    await permissions.getByText('Bypass is on.').waitFor()
    expect(await window.getByRole('button', { name: 'Review and save' }).count()).toBe(0)
    await permissions.getByRole('button', { name: 'Use Auto' }).click()
    await permissions.getByText('Auto is on.').waitFor()
  })

  test('switching pages scrolls only the settings, and a narrow Workflow never scrolls sideways', async () => {
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    await pushFiles(origin, {
      '.ted/workflow.yaml': 'version: 1\nstages:\n  clarify: { based_on: abcdef0 }\n',
      '.ted/stages/clarify.md': `# Clarify\n\n${'Ask the human what the Task means before anything is built. '.repeat(12)}\n`,
    })
    await addFactory(origin, 'NB')
    const window = await launchApp()
    await window.setViewportSize({ width: 1280, height: 800 })
    await openFactoryView(window, 'widgets', 'Settings')
    await window.getByRole('region', { name: 'General', exact: true }).waitFor()
    const jump = window.getByRole('navigation', { name: 'Factory settings' })
    const nav = sidebar(window)

    for (const width of [1280, 900]) {
      await window.setViewportSize({ width, height: 800 })
      await jump.getByRole('button', { name: 'Checks', exact: true }).click()
      const checks = window.getByRole('region', { name: 'Checks', exact: true })
      const help = checks.getByRole('button', { name: 'Help', exact: true }).last()
      for (const input of ['hover', 'focus'] as const) {
        if (input === 'hover') await help.hover()
        else {
          await window.mouse.move(0, 0)
          await help.focus()
        }
        const tooltip = checks.getByRole('tooltip')
        await tooltip.waitFor()
        expect(
          await tooltip.evaluate((element) => {
            const rect = element.getBoundingClientRect()
            const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
            return hit === element || element.contains(hit)
          }),
        ).toBe(true)
        await help.press('Escape')
        await window.keyboard.press('Tab')
      }
    }

    await jump.getByRole('button', { name: /^Workflow/ }).click()
    const workflow = window.getByRole('region', { name: 'Workflow', exact: true })
    const drift = workflow.getByRole('region', { name: 'Clarify drift' })
    await drift.getByRole('button', { name: 'Keep mine' }).waitFor()
    const sideways = (element: HTMLElement | SVGElement) =>
      [element, ...element.querySelectorAll('*')].filter(
        (e) => e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 1,
      ).length
    expect(await workflow.evaluate(sideways)).toBe(0)
    const edit = await workflow.getByRole('button', { name: 'Edit file' }).first().boundingBox()
    expect(edit && edit.x + edit.width).toBeLessThanOrEqual(900)
    await window.setViewportSize({ width: 1280, height: 800 })

    for (const section of ['Workflow', 'Factory notes', 'Danger zone']) {
      await jump.getByRole('button', { name: section }).click()
      await sleep(300)
      const main = await window.getByRole('main').boundingBox()
      const inbox = await nav.getByRole('button', { name: 'Inbox' }).boundingBox()
      expect(main && Math.round(main.y + main.height)).toBe(800)
      expect(main?.y).toBe(0)
      expect(inbox?.y).toBeGreaterThan(0)
    }

    const dangerZone = window.getByRole('region', { name: 'Danger zone', exact: true })
    expect(
      await window
        .getByRole('region', { name: 'General', exact: true })
        .getByRole('button', {
          name: 'Remove Factory…',
        })
        .count(),
    ).toBe(0)
    await dangerZone.getByRole('button', { name: 'Remove Factory…' }).click()
    const dialog = window.getByRole('dialog', { name: 'Remove Factory widgets?' })
    await dialog.waitFor()
    expect(
      await dialog.getByRole('button', { name: 'Remove Factory', exact: true }).isDisabled(),
    ).toBe(true)
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await dialog.waitFor({ state: 'detached' })
  })
})

describe('Library settings', () => {
  test('Edit in Library and a sign-off change save straight to the Library folder', async () => {
    const window = await launchApp()
    await openSettings(window)
    await settingsNav(window).getByRole('button', { name: 'Library', exact: true }).click()
    await window.getByRole('heading', { name: 'Stage files' }).waitFor()
    await window
      .getByText('Applies to every Factory that doesn’t override it, from each Task’s next Stage.')
      .waitFor()

    await window.getByRole('switch', { name: 'Design sign-off' }).click()
    await window.getByText('1 unsaved change to the Library').waitFor()
    await window.getByRole('button', { name: 'Edit in Library' }).nth(5).click()
    const editor = window.getByRole('textbox', { name: 'Review Stage file' })
    await editor.fill(`${await editor.inputValue()}\n## Also\n\nRead the changelog.\n`)
    await window.getByRole('tab', { name: 'Compare with default' }).click()
    await window.getByRole('region', { name: 'review.md compared with Ted’s default' }).waitFor()
    await window.getByText('2 unsaved changes to the Library').waitFor()
    await window.getByRole('button', { name: 'Save', exact: true }).click()
    await window.getByText('2 unsaved changes to the Library').waitFor({ state: 'detached' })

    const library = path.join(ctx.home, 'library')
    expect(await readFile(path.join(library, 'stages', 'review.md'), 'utf8')).toContain(
      'Read the changelog.',
    )
    expect(await readFile(path.join(library, 'workflow.yaml'), 'utf8')).toMatch(
      /design:\n {4}gate: false\n {2}review:\n {4}based_on: "?[0-9a-f]{7}"?\n/,
    )

    await window.getByRole('button', { name: 'Reset to default' }).first().click()
    await window.getByRole('button', { name: 'Save', exact: true }).click()
    await waitFor(async () =>
      readFile(path.join(library, 'stages', 'review.md')).then(
        () => false,
        () => true,
      ),
    )
  })
})

test('Stage effort saves in Library and a Factory override can return to inheritance', async () => {
  await addFactory(await makeOriginRepo(path.join(ctx.home, 'origin')), 'NB')
  const window = await launchApp()
  await window.setViewportSize({ width: 1440, height: 1000 })
  await openSettings(window)
  await settingsNav(window).getByRole('button', { name: 'Library', exact: true }).click()
  await window.getByRole('combobox', { name: 'Design effort', exact: true }).selectOption('high')
  await window.getByRole('combobox', { name: 'Work effort', exact: true }).selectOption('medium')
  await window.getByRole('button', { name: 'Save', exact: true }).click()
  await window.getByText('2 unsaved changes to the Library').waitFor({ state: 'detached' })
  expect(await readFile(path.join(ctx.home, 'library', 'workflow.yaml'), 'utf8')).toContain(
    'effort: high',
  )

  await settingsNav(window).getByRole('button', { name: /Back/ }).click()
  await openFactoryView(window, 'widgets', 'Settings')
  await window
    .getByRole('navigation', { name: 'Factory settings' })
    .getByRole('button', { name: 'Workflow', exact: true })
    .click()
  const design = window.getByRole('combobox', { name: 'Design effort', exact: true })
  await design.waitFor()
  expect(await design.inputValue()).toBe('')
  expect(await design.locator('option:checked').textContent()).toContain('high · Library')
  await design.selectOption('ultra')
  await window.getByText('1 unsaved change to .ted/workflow.yaml', { exact: true }).waitFor()
  await design.selectOption('')
  expect(await design.locator('option:checked').textContent()).toContain('high · Library')
  if (process.env.TED_TEST_SCREENSHOT) {
    await window
      .getByRole('navigation', { name: 'Factory settings' })
      .getByRole('button', { name: 'Workflow', exact: true })
      .click()
    await sleep(300)
    await window.screenshot({ path: process.env.TED_TEST_SCREENSHOT, fullPage: true })
  }
})
