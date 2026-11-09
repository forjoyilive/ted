import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Page } from 'playwright'
import { describe, expect, test } from 'vitest'
import { commitToOrigin, makeOriginRepo } from '../../daemon/test/helpers.ts'
import {
  addFactory,
  blobHash,
  ctx,
  daemonClient,
  githubReady,
  launchApp,
  openSettings,
  run,
  settingsNav,
  setUpAppTests,
  sidebar,
  ted,
  twoFactories,
  waitFor,
  writeLibrary,
} from './app-harness.ts'

setUpAppTests()

describe('Factory settings sections', () => {
  test('jumping to a section scrolls only the settings, never the app frame', async () => {
    await addFactory(await makeOriginRepo(path.join(ctx.home, 'origin')), 'NB')
    const window = await launchApp()
    await window.setViewportSize({ width: 1280, height: 800 })
    const nav = sidebar(window)
    await nav.getByRole('button', { name: 'widgets' }).click()
    await nav.getByRole('button', { name: 'Settings', exact: true }).first().click()
    await window.getByText('Always last').waitFor()
    const jump = window.getByRole('navigation', { name: 'Jump to a section' })

    for (const section of ['Workflow', 'Factory notes']) {
      await jump.getByRole('button', { name: section }).click()
      await sleep(300)
      const main = await window.getByRole('main').boundingBox()
      const inbox = await nav.getByRole('button', { name: 'Inbox' }).boundingBox()
      expect(main && Math.round(main.y + main.height)).toBe(800)
      expect(main?.y).toBe(0)
      expect(inbox?.y).toBeGreaterThan(0)
    }
  })

  test('Workflow, Permissions and notes edits collect into one Save, and Bypass needs confirming', async () => {
    const parent = path.join(ctx.home, 'origin')
    const origin = await makeOriginRepo(parent)
    await commitToOrigin(parent, {
      '.ted/workflow.yaml':
        'version: 1\nstages:\n  validate:\n    checks:\n      - { name: Typecheck, run: npm run typecheck }\n',
    })
    await githubReady(['acme/widgets'])
    await addFactory(origin, 'NB')
    const window = await launchApp()
    await sidebar(window).getByRole('button', { name: 'widgets' }).click()
    await sidebar(window).getByRole('button', { name: 'Settings', exact: true }).first().click()
    await window.getByRole('heading', { name: 'Workflow' }).waitFor()

    const designGate = window.getByRole('switch', { name: 'Design Gate' })
    expect(await designGate.getAttribute('aria-checked')).toBe('true')
    expect(await window.getByRole('switch', { name: 'Work on' }).isDisabled()).toBe(true)
    await designGate.click()
    await window.getByText('1 unsaved change to .ted/workflow.yaml').waitFor()
    expect(await window.getByRole('textbox', { name: 'Typecheck command' }).inputValue()).toBe(
      'npm run typecheck',
    )

    await window.getByRole('radio', { name: 'Bypass' }).check()
    await window.getByText('Bypass is on.').waitFor()
    await window.getByRole('textbox', { name: 'Factory notes' }).fill('# Notebook\n')
    await window.getByText('3 unsaved changes to 2 files in .ted/').waitFor()

    await window.getByRole('button', { name: 'Review and save…' }).click()
    const dialog = window.getByRole('dialog', { name: 'Save TED settings' })
    await dialog.getByRole('region', { name: 'Changes to .ted/notes.md' }).waitFor()
    await dialog.getByRole('region', { name: 'Changes to .ted/workflow.yaml' }).waitFor()
    await dialog.getByText('This save turns on Bypass.').waitFor()
    const save = dialog.getByRole('button', { name: 'Save and merge' })
    expect(await save.isDisabled()).toBe(true)
    await dialog.getByRole('checkbox', { name: 'Turn on Bypass for widgets' }).check()
    await waitFor(() => save.isEnabled())
  })

  test('a broken workflow.yaml shows the amber notice with the last valid version', async () => {
    const parent = path.join(ctx.home, 'origin')
    const origin = await makeOriginRepo(parent)
    await commitToOrigin(parent, { '.ted/workflow.yaml': 'version: 1\n' })
    await addFactory(origin, 'NB')
    await commitToOrigin(parent, { '.ted/workflow.yaml': 'version: 1\norder: [work]\n' })
    const window = await launchApp()
    await sidebar(window).getByRole('button', { name: 'widgets' }).click()
    await sidebar(window).getByRole('button', { name: 'Settings', exact: true }).first().click()
    const notice = window.getByRole('alert', { name: '.ted/workflow.yaml has an error' })
    await notice.waitFor()
    await notice.getByText('`order` must start with `intake`').waitFor()
    await notice
      .getByText(/TED is using the last valid version, from [0-9a-f]{7}, just now/)
      .waitFor()
  })
})

describe('Drift', () => {
  test('a changed inherited Stage file turns its row amber with Keep mine, Use inherited and Merge with an agent', async () => {
    const v1 = '# Review\n\n- Check the diff against the Design brief.\n'
    const v2 = '# Review\n\n- Check the diff against the Design brief and the Decisions.\n'
    await writeLibrary({ 'stages/review.md': v1 })
    const parent = path.join(ctx.home, 'origin')
    const origin = await makeOriginRepo(parent)
    await commitToOrigin(parent, {
      '.ted/workflow.yaml': `version: 1\nstages:\n  review: { based_on: ${blobHash(v1)} }\n`,
      '.ted/stages/review.md': `${v1}- Also check the docs.\n`,
    })
    await addFactory(origin, 'NB')
    await writeLibrary({ 'stages/review.md': v2 })
    const window = await launchApp()
    await sidebar(window).getByRole('button', { name: 'widgets' }).click()
    const settings = sidebar(window).getByRole('button', { name: /^Settings 1$/ })
    await settings.waitFor()
    await settings.click()
    await window.getByRole('button', { name: 'Workflow 1' }).waitFor()

    const drift = window.getByRole('region', { name: 'Review drift' })
    await drift
      .getByText(
        `Inherited version changed. Your Library’s review.md changed. Your copy is based on ${blobHash(v1)}.`,
      )
      .waitFor()
    await drift.getByText('- Check the diff against the Design brief and the Decisions.').waitFor()
    await drift.getByRole('button', { name: 'Use inherited' }).waitFor()
    await drift.getByRole('button', { name: 'Merge with an agent' }).waitFor()
    await drift.getByRole('button', { name: 'Keep mine' }).click()
    await drift.waitFor({ state: 'detached' })
    await window.getByText('1 unsaved change to .ted/workflow.yaml').waitFor()
  })

  test('a Library copy of a changed default shows Keep mine and Use default only', async () => {
    await writeLibrary({
      'workflow.yaml': 'version: 1\nstages:\n  review:\n    based_on: abcdef0\n',
      'stages/review.md': 'My review steps\n',
    })
    const window = await launchApp()
    await openSettings(window)
    const library = settingsNav(window).getByRole('button', { name: 'Library 1' })
    await library.waitFor()
    await library.click()
    const drift = window.getByRole('region', { name: 'Review drift' })
    await drift
      .getByText(
        /Default version changed\. TED’s default review\.md changed in TED .+\. Your copy is based on abcdef0\./,
      )
      .waitFor()
    await drift.getByRole('button', { name: 'Use default' }).waitFor()
    expect(await drift.getByRole('button', { name: 'Merge with an agent' }).count()).toBe(0)
    await drift.getByRole('button', { name: 'Keep mine' }).click()
    await window.getByText('1 unsaved change to the Library').waitFor()
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
      /design:\n {4}gate: false\n {2}review:\n {4}based_on: [0-9a-f]{7}\n/,
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

  test('Agent defaults save to the Library and show the Library tag', async () => {
    const window = await launchApp()
    await openSettings(window)
    await settingsNav(window).getByRole('button', { name: 'Agents', exact: true }).click()
    const restart = window.getByRole('switch', {
      name: 'Restart idle Runs onto new agent versions',
    })
    expect(await restart.getAttribute('aria-checked')).toBe('true')
    await restart.click()
    await waitFor(
      async () => (await (await daemonClient()).getSettings()).restartIdleRuns === false,
    )

    const defaults = window.getByRole('group', { name: 'Defaults for all Factories' })
    await defaults.getByRole('combobox', { name: 'Reviewer effort' }).selectOption('high')
    await defaults.getByRole('button', { name: 'Reset to TED default' }).waitFor()
    await defaults.getByText('Library', { exact: true }).waitFor()
    expect(await readFile(path.join(ctx.home, 'library', 'workflow.yaml'), 'utf8')).toMatch(
      /^version: 1\nreviewer: \{agent: \w+, effort: high\}\n$/,
    )
    await defaults.getByRole('button', { name: 'Reset to TED default' }).click()
    await waitFor(
      async () =>
        (await readFile(path.join(ctx.home, 'library', 'workflow.yaml'), 'utf8')) ===
        'version: 1\n',
    )
  })
})

describe('Factory row menu', () => {
  const row = (window: Page, name: string) =>
    sidebar(window).getByRole('article', { name, exact: true })
  const rowNames = (window: Page) =>
    sidebar(window)
      .getByRole('article')
      .evaluateAll((rows) => rows.map((r) => r.getAttribute('aria-label')))

  test('Rename edits the name in place: Enter saves and Esc cancels', async () => {
    await twoFactories()
    const window = await launchApp()
    await row(window, 'notebook').click({ button: 'right' })
    const menu = window.getByRole('menu', { name: 'Factory actions' })
    expect(await menu.getByRole('menuitem').allTextContents()).toEqual([
      'New Task',
      'Plan',
      'Rename…',
      'Move up',
      'Move down',
      'Factory settings',
      'Open on GitHub',
      'Remove Factory…',
    ])
    expect(await menu.getByRole('menuitem', { name: 'Move up' }).isDisabled()).toBe(true)
    await menu.getByRole('menuitem', { name: 'Rename…' }).click()
    const field = sidebar(window).getByRole('textbox', { name: 'Rename notebook' })
    await field.fill('Throwaway')
    await field.press('Escape')
    await row(window, 'notebook').waitFor()

    await row(window, 'notebook').getByRole('button', { name: 'Factory actions' }).click()
    await window.getByRole('menuitem', { name: 'Rename…' }).click()
    await field.fill('Notebook app')
    await field.press('Enter')
    await row(window, 'Notebook app').waitFor()
    const client = await daemonClient()
    const renamed = (await client.listFactories()).find((f) => f.key === 'NB')
    expect(renamed?.name).toBe('Notebook app')
  })

  test('Move down changes the order, and ⌘1 follows it', async () => {
    await twoFactories()
    const window = await launchApp()
    await row(window, 'notebook').waitFor()
    expect(await rowNames(window)).toEqual(['notebook', 'site'])

    await row(window, 'notebook').click({ button: 'right' })
    await window.getByRole('menuitem', { name: 'Move down' }).click()
    await waitFor(async () => (await rowNames(window)).join() === 'site,notebook')

    await window.keyboard.press('ControlOrMeta+1')
    const site = row(window, 'site').getByRole('button', { name: 'Views' })
    await waitFor(async () => (await site.getAttribute('aria-expanded')) === 'true')
    await window.keyboard.press('ControlOrMeta+2')
    const notebook = row(window, 'notebook').getByRole('button', { name: 'Views' })
    await waitFor(async () => (await notebook.getAttribute('aria-expanded')) === 'true')
  })

  test('Remove Factory needs the typed key, then the Factory and its Tasks are gone', async () => {
    await twoFactories()
    await ted('task', 'create', '--factory', 'MS', 'Fix the footer')
    const window = await launchApp()
    await row(window, 'site').click({ button: 'right' })
    await window.getByRole('menuitem', { name: 'Remove Factory…' }).click()
    const dialog = window.getByRole('dialog', { name: 'Remove Factory site?' })
    await dialog
      .getByText('Deletes 1 Task with their Comments, Runs and Conversations from TED.')
      .waitFor()
    const remove = dialog.getByRole('button', { name: 'Remove Factory' })
    expect(await remove.isDisabled()).toBe(true)
    await dialog.getByLabel('Type MS to confirm').fill('NB')
    expect(await remove.isDisabled()).toBe(true)
    await dialog.getByLabel('Type MS to confirm').fill('MS')
    await remove.click()
    await dialog.waitFor({ state: 'detached' })
    await row(window, 'site').waitFor({ state: 'detached' })
    const client = await daemonClient()
    expect((await client.listFactories()).map((f) => f.key)).toEqual(['NB'])
    expect(await client.listTasks()).toEqual([])
  })

  test('Remove from Factory is refused while an open Task uses the repo, and otherwise greys the card until Save', async () => {
    await makeOriginRepo(path.join(ctx.home, 'origin'))
    const widgets = path.join(ctx.home, 'origin', 'acme', 'widgets.git')
    await run('git', [
      'clone',
      '--bare',
      '-q',
      widgets,
      path.join(ctx.home, 'origin', 'acme', 'api.git'),
    ])
    await githubReady(['acme/widgets', 'acme/api'], {
      'repos/acme/widgets/contents/.ted?ref=main': { body: [] },
    })
    const window = await launchApp()
    const client = await daemonClient()
    const factory = await client.createFactory({
      name: 'Widgets',
      key: 'WD',
      repos: [
        { source: { remote: 'acme/widgets' }, name: 'widgets' },
        { source: { remote: 'acme/api' }, name: 'api' },
      ],
      showTutorial: false,
    })
    await waitFor(
      async () => (await client.listFactories()).find((f) => f.id === factory.id)?.cloned === true,
    )
    const task = await client.createTask({ title: 'Offline notes', factory: 'WD' })
    await client.setTaskRepos(task.id, { set: ['widgets', 'api'] })

    await row(window, 'Widgets').click({ button: 'right' })
    await window.getByRole('menuitem', { name: 'Factory settings' }).click()
    const api = window.getByRole('article', { name: 'acme/api' })
    await api.getByRole('button', { name: 'More for acme/api' }).click()
    await window.getByRole('menuitem', { name: 'Remove from Factory…' }).click()
    const refused = window.getByRole('dialog', { name: 'acme/api can’t be removed yet' })
    await refused.getByText(task.displayId).waitFor()
    await refused.getByRole('button', { name: 'OK' }).click()

    await client.archiveTask(task.id, {})
    await api.getByRole('button', { name: 'More for acme/api' }).click()
    await window.getByRole('menuitem', { name: 'Remove from Factory…' }).click()
    await api.getByText('Removed when you save').waitFor()
    await window.getByText('1 unsaved change to .ted/workflow.yaml').waitFor()
    await api.getByRole('button', { name: 'Undo' }).click()
    await api.getByText('Removed when you save').waitFor({ state: 'detached' })
    await api.getByRole('button', { name: 'More for acme/api' }).waitFor()
  })
})

describe('Empty states', () => {
  test('an empty Inbox offers New Task until a Factory has a Task, then Show answered', async () => {
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    await addFactory(origin, 'NB')
    const window = await launchApp()
    const inbox = window.getByRole('region', { name: 'Inbox' })
    await inbox.getByText('Nothing waiting on you', { exact: true }).waitFor()

    await inbox.getByRole('button', { name: 'New Task' }).click()
    await window.getByRole('dialog', { name: 'New Task' }).getByLabel('Close').click()

    await ted('task', 'create', '--factory', 'NB', 'Offline editing')
    await inbox.getByRole('button', { name: 'Show answered' }).click()
    expect(await inbox.getByRole('switch', { name: 'Answered' }).getAttribute('aria-checked')).toBe(
      'true',
    )
    await inbox.getByText('Nothing answered in the last 30 days', { exact: true }).waitFor()
  })

  test('an Inbox filtered to one Factory names it and offers Show all Factories', async () => {
    await twoFactories()
    const window = await launchApp()
    const inbox = window.getByRole('region', { name: 'Inbox' })

    await inbox.getByRole('button', { name: 'notebook 0', exact: true }).click()
    await inbox.getByText('Nothing waiting in notebook', { exact: true }).waitFor()
    await inbox.getByRole('button', { name: 'Show all Factories' }).click()

    expect(
      await inbox.getByRole('button', { name: 'All 0', exact: true }).getAttribute('aria-pressed'),
    ).toBe('true')
    await inbox.getByText('Nothing waiting on you', { exact: true }).waitFor()
  })

  test('a Board with no Tasks keeps its columns and offers New Task and Plan', async () => {
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    await addFactory(origin, 'NB')
    const window = await launchApp()
    await sidebar(window).getByRole('button', { name: 'widgets' }).click()
    const empty = window.getByRole('region', { name: 'No Tasks yet' })
    await empty.waitFor()
    await window.getByRole('region', { name: 'Backlog' }).waitFor()

    await empty.getByRole('button', { name: 'New Task' }).click()
    await window.getByRole('dialog', { name: 'New Task' }).getByLabel('Close').click()
    await empty.getByRole('button', { name: 'Plan' }).click()

    expect(
      await sidebar(window)
        .getByRole('button', { name: 'Plans', exact: true })
        .getAttribute('aria-current'),
    ).toBe('page')
    await window.getByRole('region', { name: 'New planning chat' }).waitFor()
  })

  test('Board filters that match nothing offer Clear filters', async () => {
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    await addFactory(origin, 'NB')
    await ted('task', 'create', '--factory', 'NB', 'Offline editing')
    const window = await launchApp()
    await sidebar(window).getByRole('button', { name: 'widgets' }).click()
    const main = window.getByRole('main')
    await main.getByRole('region', { name: 'Backlog' }).getByText('Offline editing').waitFor()

    await main.getByRole('button', { name: 'Filter' }).click()
    await main.getByRole('menuitem', { name: 'Priority' }).hover()
    await main.getByRole('menuitemcheckbox', { name: /Urgent/ }).click()
    await window.keyboard.press('Escape')
    const empty = main.getByRole('region', { name: 'No Tasks match these filters' })
    await empty.getByRole('button', { name: 'Clear filters' }).click()

    await main.getByRole('region', { name: 'Backlog' }).getByText('Offline editing').waitFor()
    await empty.waitFor({ state: 'detached' })

    const box = main.getByRole('searchbox', { name: 'Filter by ID or title' })
    await box.fill('no such task')
    await empty.getByRole('button', { name: 'Clear filters' }).click()
    await main.getByRole('region', { name: 'Backlog' }).getByText('Offline editing').waitFor()
    expect(await box.inputValue()).toBe('')
  })
})
