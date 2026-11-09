import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { commitToOrigin, isAlive, makeOriginRepo, waitForExit } from '../../daemon/test/helpers.ts'
import {
  addFactory,
  channelsOf,
  ctx,
  daemonClient,
  daemonPid,
  launchApp,
  openAllTasks,
  pickFolderWith,
  setUpAppTests,
  sidebar,
  taskRow,
  ted,
} from './app-harness.ts'

setUpAppTests()

describe('TED app', () => {
  test('the Task Lead field shows the agent, model and effort, and saves a change', async () => {
    await ted('task', 'create', 'Fix login')
    const window = await launchApp()
    await openAllTasks(window)
    await taskRow(window, 'DEV-1').click()
    const details = window.getByRole('complementary', { name: 'Task details' })
    await expect.poll(() => details.getByLabel('Agent').inputValue()).toBe('claude')

    await details.getByLabel('Agent').selectOption('codex')
    await details.getByLabel('Model').fill('gpt-6-mini')
    await details.getByLabel('Effort').selectOption('low')
    await details.getByRole('button', { name: 'Save' }).click()

    await details.getByText('Codex · gpt-6-mini · low').waitFor()

    await ted('task', 'lead', 'DEV-1', 'claude', '--model', 'opus')
    await expect.poll(() => details.getByLabel('Model').inputValue()).toBe('opus')
    expect(await details.getByLabel('Agent').inputValue()).toBe('claude')
    expect(await details.getByLabel('Effort').inputValue()).toBe('')
  })

  test('a model the plan doesn’t include shows Model unavailable until the human picks the default', async () => {
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    await addFactory(origin, 'NB')
    await ted('task', 'create', '--factory', 'NB', JSON.stringify({ steps: [{ endTurn: true }] }))
    await ted('task', 'lead', 'NB-1', 'claude', '--model', 'unavailable-9')
    const window = await launchApp()
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    const details = window.getByRole('complementary', { name: 'Task details' })
    await details.getByText('Backlog').waitFor()

    await ted('task', 'start', 'NB-1')

    await details.getByText('Model unavailable').waitFor()
    await window
      .getByRole('region', { name: 'Task thread' })
      .getByText(/won’t switch models on its own/)
      .waitFor()
    await details.getByRole('button', { name: 'Use the default model' }).click()
    await details.getByText('Model unavailable').waitFor({ state: 'detached' })
  })

  test('the thread header shows the status, the live activity line and the Stage track', async () => {
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    const go = (n: number) => path.join(ctx.home, `go-${n}`)
    const steps = JSON.stringify({
      steps: [
        { run: ['ted', 'comment', 'Read the brief'] },
        { run: ['ted', 'status', 'Running Checks · Tests (2 of 3)'] },
        { waitFor: go(1) },
        { hook: 'PermissionRequest' },
        { waitFor: go(2) },
        { run: ['ted', 'outcome', 'advance'] },
        { run: ['ted', 'comment', 'Asking the questions'] },
        { endTurn: true },
      ],
    })
    await addFactory(origin, 'NB')
    await ted('task', 'create', '--factory', 'NB', steps)
    const window = await launchApp()
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    const thread = window.getByRole('region', { name: 'Task thread' })
    const header = thread.locator('header')
    await header.getByText('· Not started').waitFor()

    await ted('task', 'start', 'NB-1')

    await header.getByText('Working', { exact: true }).waitFor()
    const ring = header.getByText('Working', { exact: true }).locator('svg')
    const spin = () => ring.evaluate((svg) => getComputedStyle(svg).animationName)
    expect(await spin()).not.toBe('none')
    await window.emulateMedia({ reducedMotion: 'reduce' })
    expect(await spin()).toBe('none')
    await window.emulateMedia({ reducedMotion: null })
    await header.getByText('· Running Checks · Tests (2 of 3)').waitFor()
    await header.getByRole('img', { name: 'Claude Code, working' }).waitFor()
    await writeFile(go(1), '')
    await header.getByText('Waiting on you', { exact: true }).waitFor()
    await writeFile(go(2), '')
    await thread.getByText('Asking the questions', { exact: true }).waitFor()
    await header.getByText('Clarify', { exact: true }).waitFor()
    expect(await header.getByText('· Running Checks').count()).toBe(0)

    const intake = header.getByRole('button', { name: 'Intake, done' })
    await intake.click()
    expect(await intake.getAttribute('aria-pressed')).toBe('true')
    await thread.getByText('Asking the questions', { exact: true }).waitFor({ state: 'detached' })
    await thread.getByText('Read the brief', { exact: true }).waitFor()
    await header.getByRole('button', { name: 'Clarify, now' }).click()
    await thread.getByText('Read the brief', { exact: true }).waitFor({ state: 'detached' })
    await thread.getByText('Asking the questions', { exact: true }).waitFor()
    await header.getByRole('button', { name: 'Clarify, now' }).click()
    await thread.getByText('Read the brief', { exact: true }).waitFor()
    await thread.getByText('Asking the questions', { exact: true }).waitFor()
    expect(
      await header.getByRole('button', { name: 'Design, not yet' }).getAttribute('aria-pressed'),
    ).toBeNull()
  })

  test('Validate’s ✓ row shows each Check’s state, the Blocking findings box, and opens the output', async () => {
    const parent = path.join(ctx.home, 'origin')
    const origin = await makeOriginRepo(parent)
    const flag = 'stub-failed-once'
    await commitToOrigin(parent, {
      '.gitignore': 'stub-*\n',
      '.ted/workflow.yaml': [
        'version: 1',
        'order: [intake, work, validate]',
        'stages:',
        '  validate:',
        '    checks:',
        '      - { name: Typecheck, run: "echo typed" }',
        `      - { name: Tests, run: "if [ -e '${flag}' ]; then echo ok; else touch '${flag}'; echo 'SearchPanel hangs'; exit 1; fi" }`,
        '      - { name: Lint, run: "echo linted" }',
        '',
      ].join('\n'),
    })
    const advance = { run: ['ted', 'outcome', 'advance'] }
    const steps = JSON.stringify({
      steps: [{ everyMessage: [{ run: ['sh', '-c', 'echo x > work.txt'] }, advance] }, advance],
    })
    await addFactory(origin, 'NB')
    await ted('task', 'create', '--factory', 'NB', steps)
    const window = await launchApp()
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    const thread = window.getByRole('region', { name: 'Task thread' })

    await ted('task', 'start', 'NB-1')

    const sentBack = thread.getByRole('listitem').filter({
      hasText: 'Validate sent this back to Work (round 1 of 5)',
    })
    await sentBack.waitFor({ timeout: 40_000 })
    const row = sentBack.getByRole('list', { name: 'Checks' })
    await row.getByRole('button', { name: '✓ Typecheck' }).waitFor()
    await row.getByRole('button', { name: '✗ Tests' }).waitFor()
    await row.getByRole('listitem').filter({ hasText: 'Lint · not run' }).waitFor()
    await sentBack
      .getByRole('region', { name: 'Blocking findings' })
      .getByText(/The Check “Tests”/)
      .waitFor()
    await thread
      .getByText(/^(Checks passed at Validate|Validate passed)$/)
      .first()
      .waitFor({ timeout: 40_000 })

    await row.getByRole('button', { name: '✗ Tests' }).click()
    const dialog = window.getByRole('dialog', { name: 'Tests output' })
    await dialog.getByText('SearchPanel hangs', { exact: true }).waitFor()
    await dialog.getByRole('tab', { name: 'Typecheck' }).click()
    await window
      .getByRole('dialog', { name: 'Typecheck output' })
      .getByText('typed', { exact: true })
      .waitFor()
    await window.getByRole('button', { name: 'Close' }).click()
    await dialog.waitFor({ state: 'detached' })
  }, 90_000)

  test('the Review sign-off card starts with the confirmation row, Review notes included', async () => {
    const parent = path.join(ctx.home, 'origin')
    const origin = await makeOriginRepo(parent)
    await commitToOrigin(parent, {
      '.gitignore': 'stub-*\nn\nbrief.md\n',
      '.ted/workflow.yaml': [
        'version: 1',
        'order: [intake, work, validate, review]',
        'stages:',
        '  validate:',
        '    checks:',
        '      - { name: Typecheck, run: "echo typed" }',
        '',
      ].join('\n'),
    })
    const brief = [
      '## Goal',
      'Export works.',
      '## Decisions so far',
      'None.',
      '## Current state',
      'Done.',
      '## Open questions',
      'None.',
      '## Next step',
      'Merge.',
    ].join('\n\n')
    const script = [
      'n=$(cat n 2>/dev/null || echo 0); n=$((n+1)); echo $n > n;',
      'case $n in',
      '2) echo x > work.txt; ted outcome advance;;',
      '3) ted outcome advance --review pass --review-notes 2 --visual pass;;',
      `4) printf '%s' '${brief}' > brief.md; ted brief write --file brief.md; ted outcome advance;;`,
      '[5-9]) :;;',
      '*) ted outcome advance;;',
      'esac',
    ].join(' ')
    const run = { run: ['sh', '-c', script] }
    const steps = JSON.stringify({ steps: [{ everyMessage: [run, { endTurn: true }] }, run] })
    await addFactory(origin, 'NB')
    await ted('task', 'create', '--factory', 'NB', steps)
    const window = await launchApp()
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    const thread = window.getByRole('region', { name: 'Task thread' })

    await ted('task', 'start', 'NB-1')

    const passed = thread.getByRole('listitem').filter({ hasText: 'Validate passed' })
    await passed.waitFor({ timeout: 40_000 })
    await passed.getByRole('listitem').filter({ hasText: 'Review · 2 notes' }).waitFor()
    const card = thread.getByRole('region', { name: 'Sign-off' })
    await card.waitFor({ timeout: 40_000 })
    const row = card.getByRole('list', { name: 'Checks' })
    await row.getByRole('button', { name: '✓ Typecheck' }).waitFor()
    await row.getByRole('listitem').filter({ hasText: '✓Review · 2 notes' }).waitFor()
    await row
      .getByRole('listitem')
      .filter({ hasText: /^✓Visual$/ })
      .waitFor()
  }, 90_000)

  test('the Code section shows No worktree yet, then the branch and worktree path', async () => {
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    await addFactory(origin, 'NB')
    await ted('task', 'create', '--factory', 'NB', JSON.stringify({ steps: [{ endTurn: true }] }))
    const window = await launchApp()
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    const code = window
      .getByRole('complementary', { name: 'Task details' })
      .getByRole('region', { name: 'Code' })
    await code.getByText('No worktree yet').waitFor()

    await ted('task', 'start', 'NB-1')

    await code.getByText(/^ted\/nb-1/).waitFor()
    await code.getByText(path.join(ctx.home, 'worktrees', 'NB-1', 'widgets')).waitFor()
  })

  test('a missing local folder raises a Factory banner whose Locate picks a new folder', async () => {
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    const folder = path.join(ctx.home, 'local')
    const moved = path.join(ctx.home, 'moved')
    await mkdir(folder)
    await addFactory(origin, 'NB', folder)
    await rm(folder, { recursive: true })
    await mkdir(moved)

    const window = await launchApp()
    await pickFolderWith(moved)
    await sidebar(window).getByRole('button', { name: 'widgets' }).click()

    const banners = window.getByRole('region', { name: 'widgets problems' })
    await banners.getByText('Local folder for widgets not found').waitFor()
    await banners.getByRole('button', { name: 'Locate' }).click()

    await window.getByText('Local folder for widgets not found').waitFor({ state: 'detached' })
    const [factory] = await (await daemonClient()).listFactories()
    expect(factory?.localFolder).toEqual({ path: moved, found: true })
  })

  test('quitting with nothing running ends the app and TED’s background process', async () => {
    await launchApp()
    const pid = await daemonPid()
    const electronPid = ctx.app?.process().pid ?? 0

    await ctx.app?.close()
    ctx.app = undefined

    await waitForExit(pid)
    expect(isAlive(electronPid)).toBe(false)
  })

  test('the app takes over a daemon that ted started, which never learned the app’s token', async () => {
    await ted('task', 'create', 'Fix login')
    const pid = await daemonPid()

    const window = await launchApp()

    await openAllTasks(window)
    await taskRow(window, 'DEV-1').waitFor()
    expect(await daemonPid()).not.toBe(pid)
    expect(await (await daemonClient()).caller()).toMatchObject({ kind: 'app' })
  })

  test('the renderer has no Node, filesystem or store access, only the bridge', async () => {
    const window = await launchApp()

    const globals = await window.evaluate(() => ({
      require: typeof (globalThis as { require?: unknown }).require,
      process: typeof (globalThis as { process?: unknown }).process,
      bridge: Object.keys((globalThis as unknown as { ted: object }).ted).sort(),
    }))

    expect(globals).toEqual({
      require: 'undefined',
      process: 'undefined',
      bridge: ['onEvent', 'request'],
    })
  })

  test.runIf(process.platform === 'linux')(
    'the daemon the app starts shares no pipes or sockets with Electron',
    async () => {
      await launchApp()
      const electronPid = ctx.app?.process().pid
      if (electronPid === undefined) throw new Error('no Electron pid')

      const electron = new Set(await channelsOf(electronPid))
      const shared = (await channelsOf(await daemonPid())).filter((c) => electron.has(c))

      expect(shared).toEqual([])
    },
  )
})
