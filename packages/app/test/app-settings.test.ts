import { rm, writeFile } from 'node:fs/promises'
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
      .poll(() =>
        ctx.app?.evaluate(() => (globalThis as typeof globalThis & { opened: string[] }).opened),
      )
      .toEqual([ctx.home])
  })
})

describe('Add Factory', () => {
  const dialog = (window: Page) => window.getByRole('dialog')

  async function openForm(window: Page) {
    await sidebar(window).getByRole('button', { name: 'New Factory or Factory group' }).click()
    await window.getByRole('menuitem', { name: 'New Factory…' }).click()
    await dialog(window).waitFor()
  }

  test('adding from owner/repo checks access, clones, and opens the new Board', async () => {
    await makeOriginRepo(path.join(ctx.home, 'origin'))
    await githubReady(['acme/widgets'])
    const window = await launchApp()
    await openForm(window)
    const form = dialog(window)
    await form.getByRole('heading', { name: 'Add your first Factory' }).waitFor()
    expect(await form.getByText('Show the tutorial').count()).toBe(0)

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
    const client = await daemonClient()
    const [factory] = await client.listFactories()
    expect(factory).toMatchObject({ key: 'WD', cloned: true })
    expect(factory).not.toHaveProperty('showTutorial')
    expect((await client.guides()).map((g) => g.factoryId)).toEqual([factory?.id])
    await window
      .getByRole('region', { name: 'Setup guide' })
      .getByText(/^Setting up widgets$/i)
      .waitFor()
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
})

describe('banners', () => {
  const noChecks = 'No Checks set up · Validate relies on the agent alone'

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
