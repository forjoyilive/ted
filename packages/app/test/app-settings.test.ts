import { rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Page } from 'playwright'
import { describe, expect, test } from 'vitest'
import { makeOriginRepo } from '../../daemon/test/helpers.ts'
import {
  addFactory,
  ctx,
  daemonClient,
  githubReady,
  launchApp,
  onePixelPng,
  openAllTasks,
  openSettings,
  pickFolderWith,
  run,
  settingsNav,
  setUpAppTests,
  sidebar,
  ted,
} from './app-harness.ts'

setUpAppTests()

describe('App Settings', () => {
  test('⌘, opens Settings over the whole window; Esc and ← Back return to where the human was', async () => {
    const window = await launchApp()
    await openAllTasks(window)
    await window.getByRole('heading', { name: 'All Tasks' }).waitFor()

    await window.keyboard.press(process.platform === 'darwin' ? 'Meta+,' : 'Control+,')

    await settingsNav(window).waitFor()
    await window.getByRole('heading', { name: 'General', level: 1 }).waitFor()
    expect(await sidebar(window).count()).toBe(0)

    await window.keyboard.press('Escape')
    await window.getByRole('heading', { name: 'All Tasks' }).waitFor()
    expect(await settingsNav(window).count()).toBe(0)

    await openSettings(window)
    await settingsNav(window).getByRole('button', { name: /Back/ }).click()
    await window.getByRole('heading', { name: 'All Tasks' }).waitFor()
  })

  test('Settings lists the eight sections, then each Factory, which leaves for its settings page', async () => {
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    await addFactory(origin, 'NB')
    const window = await launchApp()
    await openSettings(window)
    const nav = settingsNav(window)

    const sections = [
      'General',
      'Notifications',
      'Agents',
      'Limits',
      'Integrations',
      'Library',
      'Storage',
      'Developer',
    ]
    for (const section of sections) {
      await nav.getByRole('button', { name: section, exact: true }).click()
      await window.getByRole('heading', { name: section, level: 1 }).waitFor()
      expect(
        await nav.getByRole('button', { name: section, exact: true }).getAttribute('aria-current'),
      ).toBe('page')
    }

    await nav.getByRole('button', { name: /widgets/ }).click()

    await window.getByRole('heading', { name: /^widgets\s*\/\s*Settings$/, level: 1 }).waitFor()
    expect(await settingsNav(window).count()).toBe(0)
    const card = window.getByRole('article', { name: 'acme/widgets' })
    await card.getByText('Can’t be removed or moved').waitFor()
    await card.getByRole('textbox', { name: /^Setup command/ }).fill('npm ci')
    await window.getByText('1 unsaved change to .ted/workflow.yaml').waitFor()
    await card.getByText('Edited').waitFor()
    await window.getByRole('button', { name: 'Discard' }).click()
    await window.getByText(/unsaved change/).waitFor({ state: 'detached' })
  })

  test('the terminal font size saves on this machine and applies at once', async () => {
    const window = await launchApp()
    await openSettings(window)

    await window.getByRole('combobox', { name: 'Terminal font size' }).selectOption('16')

    await expect
      .poll(() =>
        window.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--terminal-font-size'),
        ),
      )
      .toBe('16px')
    expect((await (await daemonClient()).getSettings()).terminalFontSize).toBe(16)
  })

  test('the profile picture can be changed and removed; initials show without one', async () => {
    const picture = path.join(ctx.home, 'me.png')
    await writeFile(picture, Buffer.from(onePixelPng, 'base64'))
    const window = await launchApp()
    await ctx.app?.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    }, picture)
    await openSettings(window)
    const profile = window.getByRole('group', { name: 'Profile' })
    await profile.getByRole('img').and(profile.locator('span')).waitFor()

    await profile.getByRole('button', { name: 'Change…' }).click()

    await profile.locator('img').waitFor()
    await expect
      .poll(async () => (await (await daemonClient()).getSettings()).profilePicture)
      .toMatch(/^data:image\/png;base64,/)

    await profile.getByRole('button', { name: 'Remove' }).click()

    await profile.locator('img').waitFor({ state: 'detached' })
    expect((await (await daemonClient()).getSettings()).profilePicture).toBeNull()
  })

  test('run from source, the ted command row says only an installed copy can install it', async () => {
    const window = await launchApp()
    await openSettings(window)
    const commandLine = window.getByRole('group', { name: 'Editor and command line' })

    await commandLine.getByText('Only an installed copy of TED can install it.').waitFor()
    expect(await commandLine.getByRole('button', { name: 'Install the ted command' }).count()).toBe(
      0,
    )
  })

  test('About shows the version, and Third-party licenses opens with agent-orchestrator’s NOTICE', async () => {
    const window = await launchApp()
    await openSettings(window)
    const about = window.getByRole('group', { name: 'About and updates' })
    await about.getByText(/^TED \d+\.\d+\.\d+$/).waitFor()

    await about.getByRole('button', { name: 'View' }).click()

    const licenses = window.getByRole('dialog', { name: 'Third-party licenses' })
    await licenses.getByText(/https:\/\/github\.com\/OrchestratorInc\/agent-orchestrator/).waitFor()
    await licenses.getByRole('button', { name: 'Close' }).click()
    await licenses.waitFor({ state: 'detached' })
  })

  test('Developer mode shows Diagnostics and the log viewer; off, they’re hidden', async () => {
    const window = await launchApp()
    await openSettings(window)
    await settingsNav(window).getByRole('button', { name: 'Developer', exact: true }).click()
    const diagnostics = window.getByRole('region', { name: 'Diagnostics' })
    const logs = window.getByRole('region', { name: 'Logs' })
    expect(await diagnostics.count()).toBe(0)
    expect(await logs.count()).toBe(0)

    await window.getByRole('switch', { name: 'Developer mode' }).click()

    await diagnostics.waitFor()
    await logs.waitFor()
    expect((await (await daemonClient()).getSettings()).developerMode).toBe(true)
    await logs.getByText(/TED daemon .* listening/).waitFor()

    await window.getByRole('switch', { name: 'Developer mode' }).click()
    await diagnostics.waitFor({ state: 'detached' })
    expect(await logs.count()).toBe(0)
  })

  test('the log viewer shows a Run’s raw output, and Diagnostics lists the Run', async () => {
    const window = await launchApp()
    const client = await daemonClient()
    await client.updateSettings({ developerMode: true })
    const run = await client.startDevRun({
      prompt: JSON.stringify({ steps: [{ say: 'from the stub' }, { endTurn: true }] }),
      cwd: ctx.home,
    })
    await openSettings(window)
    await settingsNav(window).getByRole('button', { name: 'Developer', exact: true }).click()

    await window
      .getByRole('region', { name: 'Diagnostics' })
      .getByRole('cell', { name: run.id.slice(0, 8), exact: true })
      .waitFor()
    const logs = window.getByRole('region', { name: 'Logs' })
    await logs.getByRole('combobox', { name: 'Log' }).selectOption(run.id)
    await logs.getByText(/from the stub/).waitFor()
  })

  test('Copy report puts the report on the clipboard, and Show in Finder opens TED’s folder', async () => {
    const window = await launchApp()
    await ctx.app?.evaluate(({ shell }) => {
      const opened: string[] = []
      Object.assign(globalThis, { opened })
      shell.openPath = async (folder: string) => {
        opened.push(folder)
        return ''
      }
    })
    await openSettings(window)
    await settingsNav(window).getByRole('button', { name: 'Developer', exact: true }).click()

    await window.getByRole('button', { name: 'Copy report' }).click()
    await window.getByText('Report copied.').waitFor()
    expect(await ctx.app?.evaluate(({ clipboard }) => clipboard.readText())).toMatch(/^TED \S+\n/)

    await window.getByRole('button', { name: /^Show in / }).click()
    await expect
      .poll(() => ctx.app?.evaluate(() => (globalThis as unknown as { opened: string[] }).opened))
      .toEqual([ctx.home])
  })
})

describe('Add Factory', () => {
  const dialog = (window: Page) => window.getByRole('dialog')

  async function openForm(window: Page) {
    await sidebar(window).getByRole('button', { name: 'Add Factory' }).click()
    await dialog(window).waitFor()
  }

  test('adding from owner/repo checks access, clones, and opens the new Board', async () => {
    await makeOriginRepo(path.join(ctx.home, 'origin'))
    await githubReady(['acme/widgets'])
    const window = await launchApp()
    await openForm(window)
    const form = dialog(window)
    await form.getByRole('heading', { name: 'Add your first Factory' }).waitFor()
    expect(await form.getByLabel('Show the tutorial').isChecked()).toBe(true)

    await form.getByLabel('GitHub URL or owner/repo').fill('acme/widgets')
    await form.getByLabel('GitHub URL or owner/repo').press('Enter')
    await form.getByText('Can push and open pull requests').waitFor()
    expect(await form.getByLabel('Name', { exact: true }).first().inputValue()).toBe('widgets')
    expect(await form.getByLabel('Key').inputValue()).toBe('WD')
    await form.getByText('TED clones the repo, then starts the setup Task WD-1.').waitFor()

    await form.getByRole('button', { name: 'Add Factory' }).click()
    await dialog(window).waitFor({ state: 'detached' })
    await sidebar(window).getByRole('button', { name: 'Widgets' }).waitFor()
    await window.getByRole('region', { name: 'Setting up Widgets' }).waitFor({ state: 'detached' })
    const [factory] = await (await daemonClient()).listFactories()
    expect(factory).toMatchObject({ key: 'WD', cloned: true, showTutorial: true })
  })

  test('access problems and a taken key show their messages and keep Add Factory disabled', async () => {
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    await githubReady(['acme/widgets'])
    await addFactory(origin, 'NB')
    const window = await launchApp()
    await openForm(window)
    const form = dialog(window)
    await form.getByRole('heading', { name: 'Add Factory' }).waitFor()

    await form.getByLabel('GitHub URL or owner/repo').fill('acme/nope')
    await form.getByLabel('GitHub URL or owner/repo').press('Enter')
    await form.getByText('Repository not found, or your GitHub account can’t see it.').waitFor()
    await form.getByRole('button', { name: 'Check again' }).waitFor()
    await form.getByRole('button', { name: 'GitHub settings' }).waitFor()

    await form.getByRole('button', { name: 'Clear the primary repo' }).click()
    await form.getByLabel('GitHub URL or owner/repo').fill('acme/widgets')
    await form.getByLabel('GitHub URL or owner/repo').press('Enter')
    await form.getByText(/is the primary repo of Factory widgets\./).waitFor()
    await form.getByRole('button', { name: 'Open widgets' }).waitFor()

    await form.getByLabel('Key').fill('NB')
    await form.getByText('NB is already the key of widgets.').waitFor()
    await form.getByText('Fix the 1 repo problem and the key to continue.').waitFor()
    expect(await form.getByRole('button', { name: 'Add Factory' }).isDisabled()).toBe(true)
  })

  test('Choose folder reads the folder’s GitHub remote', async () => {
    await makeOriginRepo(path.join(ctx.home, 'origin'))
    await githubReady(['acme/widgets'])
    const folder = path.join(ctx.home, 'code', 'widgets')
    await run('git', ['clone', path.join(ctx.home, 'origin', 'acme', 'widgets.git'), folder])
    await run('git', ['remote', 'set-url', 'origin', 'git@github.com:acme/widgets.git'], {
      cwd: folder,
    })
    const window = await launchApp()
    await pickFolderWith(folder)
    await openForm(window)
    const form = dialog(window)

    await form.getByRole('button', { name: 'Choose folder…' }).click()
    await form.getByText('acme/widgets').waitFor()
    await form.getByText('from a folder').waitFor()
    await form.getByText('Can push and open pull requests').waitFor()
  })

  test('a failed clone shows a red row and the banner; Retry recovers', async () => {
    await makeOriginRepo(path.join(ctx.home, 'origin'))
    await githubReady(['acme/widgets'])
    const origin = path.join(ctx.home, 'origin', 'acme', 'widgets.git')
    await rename(origin, `${origin}.hidden`)
    const window = await launchApp()
    await openForm(window)
    const form = dialog(window)
    await form.getByLabel('GitHub URL or owner/repo').fill('acme/widgets')
    await form.getByLabel('GitHub URL or owner/repo').press('Enter')
    await form.getByText('Can push and open pull requests').waitFor()
    await form.getByRole('button', { name: 'Add Factory' }).click()

    const panel = window.getByRole('region', { name: 'Setting up Widgets' })
    await panel.getByText(/Clone failed:/).waitFor()
    const banners = window.getByRole('region', { name: 'Widgets problems' })
    await banners
      .getByText('Couldn’t clone acme/widgets · Widgets can’t start Tasks until it’s cloned')
      .waitFor()
    await sidebar(window).getByRole('img', { name: 'A problem stops work' }).waitFor()

    await rename(`${origin}.hidden`, origin)
    await banners.getByRole('button', { name: 'Retry' }).click()
    await panel.waitFor({ state: 'detached' })
    await banners.getByText(/Couldn’t clone/).waitFor({ state: 'detached' })
  })
})

describe('banners', () => {
  const noChecks = 'No Checks set up · Validate relies on the agent alone'

  test('a Factory banner shows on that Factory’s pages only, and × hides a warning', async () => {
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    await addFactory(origin, 'NB')
    const window = await launchApp()
    const nav = sidebar(window)
    const factoryBanners = window.getByRole('region', { name: 'widgets problems' })

    await nav.getByRole('button', { name: 'widgets' }).click()
    await factoryBanners.getByText(noChecks).waitFor()
    await nav.getByRole('button', { name: 'List', exact: true }).click()
    await factoryBanners.getByText(noChecks).waitFor()
    expect(await nav.getByRole('img', { name: 'A problem stops work' }).count()).toBe(0)

    await nav.getByRole('button', { name: 'All Tasks' }).click()
    await window.getByRole('region', { name: 'All Tasks' }).waitFor()
    expect(await window.getByText(noChecks).count()).toBe(0)

    await nav.getByRole('button', { name: 'Board', exact: true }).click()
    await factoryBanners.getByRole('button', { name: 'Dismiss for 24 hours' }).click()
    await factoryBanners.waitFor({ state: 'detached' })
    const [banner] = await (await daemonClient()).listBanners()
    expect(banner?.dismissedUntil).toBeDefined()
  })

  test('a stops-work Factory banner marks the sidebar row, and Retry clears it', async () => {
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    await addFactory(origin, 'NB')
    await ted('task', 'create', '--factory', 'NB', 'Offline editing')
    const window = await launchApp()
    const nav = sidebar(window)
    await nav.getByRole('button', { name: 'widgets' }).click()
    const factoryBanners = window.getByRole('region', { name: 'widgets problems' })
    await factoryBanners.getByText(noChecks).waitFor()

    await rm(path.join(ctx.home, 'repos'), { recursive: true, force: true })
    await run('mv', [origin, `${origin}.hidden`])
    await expect(ted('task', 'start', 'NB-1')).rejects.toMatchObject({ code: 1 })

    const failed = factoryBanners.getByRole('alert')
    await failed.getByText('Couldn’t clone acme/widgets').waitFor()
    expect(await factoryBanners.locator('[role=alert], [role=status]').allTextContents()).toEqual([
      expect.stringContaining('Couldn’t clone'),
      expect.stringContaining('No Checks'),
    ])
    expect(await failed.getByRole('button', { name: 'Dismiss for 24 hours' }).count()).toBe(0)
    await nav.getByRole('img', { name: 'A problem stops work' }).waitFor()

    await run('mv', [`${origin}.hidden`, origin])
    await failed.getByRole('button', { name: 'Retry' }).click()

    await failed.waitFor({ state: 'detached' })
    await nav.getByRole('img', { name: 'A problem stops work' }).waitFor({ state: 'detached' })
  })
})

describe('agent health', () => {
  test('a signed-out agent pauses its Task, shows a Fix banner and a red Agents card', async () => {
    await writeFile(path.join(ctx.home, 'stub-claude.json'), JSON.stringify({ signedIn: false }))
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    await addFactory(origin, 'NB')
    await ted('task', 'create', '--factory', 'NB', 'Offline editing')
    await ted('task', 'start', 'NB-1')
    const window = await launchApp()

    const problems = window.getByRole('region', { name: 'Problems' })
    const banner = problems.getByRole('alert').filter({ hasText: 'Claude Code is signed out' })
    await banner.getByRole('button', { name: 'Fix' }).waitFor()
    await sidebar(window).getByRole('button', { name: 'widgets' }).click()
    await window.getByText('Paused · Claude Code is signed out').waitFor()

    await openSettings(window)
    await settingsNav(window).getByRole('button', { name: 'Agents', exact: true }).click()
    const card = window.getByRole('region', { name: 'Claude Code' })
    await card.getByText(/^Signed out/).waitFor()
    await card.getByText('Not signed in.').waitFor()
    await card.getByRole('button', { name: 'Sign in' }).waitFor()
    await card.getByRole('button', { name: 'Copy command' }).waitFor()
    expect(await card.getAttribute('data-state')).toBe('signed-out')

    await writeFile(path.join(ctx.home, 'stub-claude.json'), JSON.stringify({ signedIn: true }))
    await card.getByRole('button', { name: 'Check again' }).click()
    await card.getByText('Ready').waitFor()
    await banner.waitFor({ state: 'detached' })
  })
})
