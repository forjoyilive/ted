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

describe('Ted app', () => {
  test('the thread header shows the status, the live activity line and the Stage track', async () => {
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    const go = (n: number) => path.join(ctx.home, `go-${n}`)
    const steps = JSON.stringify({
      steps: [
        { run: ['ted', 'comment', 'Read the brief'] },
        { run: ['ted', 'status', 'Running checks · Tests (2 of 3)'] },
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
    const client = await daemonClient()
    const [factory] = await client.listFactories()
    if (!factory) throw new Error('no Factory')
    const longName = 'Long Factory name '.repeat(3).trim()
    await client.renameFactory(factory.id, longName)
    const factoryName = header.getByText(longName, { exact: true })
    await factoryName.waitFor()
    expect(await factoryName.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
    const headerBox = await header.boundingBox()
    const stageBox = await header.getByText('· Not started').boundingBox()
    if (!headerBox || !stageBox) throw new Error('the header has no layout')
    expect(stageBox.x + stageBox.width).toBeLessThanOrEqual(headerBox.x + headerBox.width)

    await ted('task', 'start', 'NB-1')

    await header.getByText('Working', { exact: true }).waitFor()
    const ring = header.getByText('Working', { exact: true }).locator('svg')
    const spin = () => ring.evaluate((svg) => getComputedStyle(svg).animationName)
    expect(await spin()).not.toBe('none')
    await window.emulateMedia({ reducedMotion: 'reduce' })
    expect(await spin()).toBe('none')
    await window.emulateMedia({ reducedMotion: null })
    await header.getByText('· Running checks · Tests (2 of 3)').waitFor()
    await header.getByRole('img', { name: 'Claude Code, working' }).waitFor()
    await writeFile(go(1), '')
    await header.getByText('Waiting on you', { exact: true }).waitFor()
    await writeFile(go(2), '')
    await thread.getByText('Asking the questions', { exact: true }).waitFor()
    await header.getByText('Clarify', { exact: true }).waitFor()
    expect(await header.getByText('· Running checks').count()).toBe(0)

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

    await client.editTask('NB-1', { title: 'Deny network by default, with grants' })
    await header.getByRole('heading', { name: 'Deny network by default, with grants' }).waitFor()
    await window.setViewportSize({ width: 720, height: 800 })
    const layout = () =>
      header.evaluate((el) => {
        const title = el.querySelector('h1')
        const controls = title?.nextElementSibling
        const row = title?.parentElement
        if (!title || !controls || !row) throw new Error('the header has no title row')
        const titleBox = title.getBoundingClientRect()
        return {
          titleWidth: titleBox.width,
          rowWidth: row.getBoundingClientRect().width,
          titleBottom: titleBox.bottom,
          controlsTop: controls.getBoundingClientRect().top,
          menuInControls: controls.querySelector('[aria-label="Task actions"]') !== null,
        }
      })
    await expect.poll(async () => (await layout()).rowWidth).toBeLessThan(400)
    const narrow = await layout()
    expect(narrow.menuInControls).toBe(true)
    expect(narrow.controlsTop).toBeGreaterThanOrEqual(narrow.titleBottom)
    expect(narrow.titleWidth).toBeCloseTo(narrow.rowWidth, 0)
  })

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
    await banners.getByRole('button', { name: 'Locate…' }).click()

    await window.getByText('Local folder for widgets not found').waitFor({ state: 'detached' })
    const [factory] = await (await daemonClient()).listFactories()
    expect(factory?.localFolder).toEqual({ path: moved, found: true })
  })

  test('quitting with nothing running ends the app and Ted’s background process', async () => {
    const started = performance.now()
    const file = path.join(ctx.home, 'logs', 'empty-app-quit.json')
    let electronPid: number | undefined
    let pid: number | undefined
    const observations: {
      phase: string
      elapsedMs: number
      electronAlive: boolean | null
      daemonAlive: boolean | null
    }[] = []
    const mark = async (phase: string) => {
      const observation = {
        phase,
        elapsedMs: performance.now() - started,
        electronAlive: electronPid === undefined ? null : isAlive(electronPid),
        daemonAlive: pid === undefined ? null : isAlive(pid),
      }
      observations.push(observation)
      console.log('Empty-app quit:', JSON.stringify({ home: ctx.home, ...observation }))
      try {
        await mkdir(path.dirname(file), { recursive: true })
        await writeFile(
          file,
          JSON.stringify({ electronPid, daemonPid: pid, observations }, null, 2),
        )
      } catch {
        console.warn('Empty-app quit: could not save diagnostics')
      }
    }

    try {
      await mark('launch-start')
      await launchApp()
      electronPid = ctx.app?.process().pid
      if (electronPid === undefined) throw new Error('Launched Electron has no process PID')
      await mark('launch-loaded')
      await mark('daemon-pid-start')
      pid = await daemonPid()
      await mark('daemon-pid-read')

      await mark('close-start')
      await ctx.app?.close()
      await mark('close-resolved')
      ctx.app = undefined

      await mark('daemon-exit-start')
      await waitForExit(pid)
      await mark('daemon-exited')
      expect(isAlive(electronPid)).toBe(false)
      await mark('exit-assertions-passed')
    } catch (error) {
      await mark('failed')
      throw error
    }
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
      bridge: Object.keys(globalThis.window.ted).sort(),
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
