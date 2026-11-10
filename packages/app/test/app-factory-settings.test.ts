import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { describe, expect, test } from 'vitest'
import { makeOriginRepo } from '../../daemon/test/helpers.ts'
import {
  addFactory,
  ctx,
  launchApp,
  openSettings,
  settingsNav,
  setUpAppTests,
  sidebar,
  waitFor,
} from './app-harness.ts'

setUpAppTests()

describe('Factory settings sections', () => {
  test('permission mode confirms and saves on this computer without a settings pull request', async () => {
    await addFactory(await makeOriginRepo(path.join(ctx.home, 'origin')), 'NB')
    const window = await launchApp()
    await window.setViewportSize({ width: 1280, height: 900 })
    const nav = sidebar(window)
    await nav.getByRole('button', { name: 'widgets' }).click()
    await nav.getByRole('button', { name: 'Settings', exact: true }).first().click()
    await window
      .getByRole('navigation', { name: 'Jump to a section' })
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

  test('jumping to a section scrolls only the settings, never the app frame', async () => {
    await addFactory(await makeOriginRepo(path.join(ctx.home, 'origin')), 'NB')
    const window = await launchApp()
    await window.setViewportSize({ width: 1280, height: 800 })
    const nav = sidebar(window)
    await nav.getByRole('button', { name: 'widgets' }).click()
    await nav.getByRole('button', { name: 'Settings', exact: true }).first().click()
    await window.getByText('Always last').waitFor()
    const jump = window.getByRole('navigation', { name: 'Jump to a section' })

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
  test('Edit in Library and a Gate change save straight to the Library folder', async () => {
    const window = await launchApp()
    await openSettings(window)
    await settingsNav(window).getByRole('button', { name: 'Library', exact: true }).click()
    await window.getByRole('heading', { name: 'Stage files' }).waitFor()
    await window
      .getByText('Applies to every Factory that doesn’t override it, from each Task’s next Stage.')
      .waitFor()

    await window.getByRole('switch', { name: 'Design Gate' }).click()
    await window.getByText('1 unsaved change to the Library').waitFor()
    await window.getByRole('button', { name: 'Edit in Library' }).nth(5).click()
    const editor = window.getByRole('textbox', { name: 'Review Stage file' })
    await editor.fill(`${await editor.inputValue()}\n## Also\n\nRead the changelog.\n`)
    await window.getByRole('tab', { name: 'Compare with default' }).click()
    await window.getByRole('region', { name: 'review.md compared with TED’s default' }).waitFor()
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
