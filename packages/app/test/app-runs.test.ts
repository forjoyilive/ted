import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { readDaemonInfo } from '@ted/protocol'
import type { Page } from 'playwright'
import { describe, expect, test } from 'vitest'
import {
  commitToOrigin,
  isAlive,
  makeOriginRepo,
  waitForExit,
  waitUntil,
} from '../../daemon/test/helpers.ts'
import {
  addFactory,
  ctx,
  daemonClient,
  daemonPid,
  launchApp,
  openAllTasks,
  openSettings,
  runHostPids,
  settingsNav,
  setUpAppTests,
  sidebar,
  startDaemonAsApp,
  taskRow,
  ted,
} from './app-harness.ts'

setUpAppTests()

describe('Working Runs', () => {
  const forever = () => JSON.stringify({ steps: [{ waitFor: path.join(ctx.home, 'never') }] })

  async function twoTasksOneSlot(): Promise<Page> {
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    await addFactory(origin, 'NB')
    await ted('task', 'create', '--factory', 'NB', forever())
    await ted('task', 'create', '--factory', 'NB', 'Second Task')
    const window = await launchApp()
    await (await daemonClient()).updateSettings({ maxWorkingRuns: 1 })
    return window
  }

  test('the sidebar footer counts working and queued Runs live and opens the popover', async () => {
    const window = await twoTasksOneSlot()
    const footer = sidebar(window).locator('footer')
    await footer.getByText('Nothing running').waitFor()

    await ted('task', 'start', 'NB-1')
    await ted('task', 'start', 'NB-2')
    await footer.getByRole('button', { name: '1 of 1 Runs working · 1 queued' }).click()

    const popover = window.getByRole('dialog', { name: 'Working Runs' })
    const machine = process.platform === 'darwin' ? 'this Mac' : 'this computer'
    await popover.getByText(`1 of 1 slots on ${machine}`).waitFor()
    const working = popover.getByRole('region', { name: 'Working' })
    await working.getByText('NB-1', { exact: true }).waitFor()
    await working.getByText('widgets · Task Lead').waitFor()
    await working.getByText('1 Run', { exact: true }).waitFor()
    const queued = popover.getByRole('region', { name: 'Queued' })
    await queued.getByText('1st', { exact: true }).waitFor()
    await queued.getByText('NB-2 · Second Task').waitFor()
    await queued.getByText('widgets · None').waitFor()

    await popover.getByRole('button', { name: 'Open in List →' }).click()
    await window.getByRole('heading', { name: 'All Tasks', level: 1 }).waitFor()
    expect(await popover.count()).toBe(0)
  })

  test('with nothing working the popover says so', async () => {
    const window = await launchApp()
    await sidebar(window).getByRole('button', { name: 'Nothing running' }).click()
    const popover = window.getByRole('dialog', { name: 'Working Runs' })
    await popover.getByText('No Runs working. Nothing queued.').waitFor()
    await window.keyboard.press('Escape')
    await popover.waitFor({ state: 'detached' })
  })

  test('S starts the open Backlog Task, and Move to Backlog takes a queued one back', async () => {
    const window = await twoTasksOneSlot()
    await ted('task', 'start', 'NB-1')
    await openAllTasks(window)
    await taskRow(window, 'NB-2').click()
    const header = window.getByRole('region', { name: 'Task thread' }).locator('header')
    await header.getByText('· Not started').waitFor()

    await window.keyboard.press('s')
    await header.getByText('Queued · 1st', { exact: true }).waitFor()

    await header.getByRole('button', { name: 'Task actions' }).click()
    const menu = header.getByRole('menu', { name: 'Task actions' })
    expect(await menu.getByRole('menuitem').first().textContent()).toContain('Move to Backlog')
    await menu.getByRole('menuitem', { name: /^Move to Backlog/ }).click()
    await header.getByText('· Not started').waitFor()
    expect((await (await daemonClient()).getSlots()).queued).toBe(0)
  })

  test('a Factory at its cap shows it in the Board and List header', async () => {
    const parent = path.join(ctx.home, 'origin')
    const origin = await makeOriginRepo(parent)
    await commitToOrigin(parent, { '.ted/workflow.yaml': 'version: 1\nmax_working_runs: 1\n' })
    await addFactory(origin, 'NB')
    await ted('task', 'create', '--factory', 'NB', forever())
    const window = await launchApp()
    await sidebar(window).getByRole('button', { name: 'widgets' }).click()
    const board = window.getByRole('region', { name: 'widgets' })
    await board.getByRole('heading', { name: 'widgets', level: 1 }).waitFor()
    expect(await board.getByText('1 of 1 working').count()).toBe(0)

    await ted('task', 'start', 'NB-1')

    await board.getByText('1 of 1 working').waitFor()
    await sidebar(window).getByRole('button', { name: 'List' }).click()
    await window.getByRole('region', { name: 'widgets' }).getByText('1 of 1 working').waitFor()
  })

  test('a nearly full disk shows a warning whose Open Storage shows what uses the space', async () => {
    const free = path.join(ctx.home, 'free-bytes')
    await writeFile(free, String(8.2e9))
    const window = await launchApp({ TED_FREE_BYTES_FILE: free })
    await window.getByText('Disk almost full · 8.2 GB free').waitFor()

    await window.getByRole('button', { name: 'Open Storage' }).click()

    const page = window.getByRole('main', { name: 'Storage' })
    await page.getByText(/used under .* · 8\.2 GB free/).waitFor()
    await page.getByRole('group', { name: 'Space used' }).getByText('Store').waitFor()
    await page.getByRole('group', { name: 'Clean up' }).getByText('None to remove').waitFor()
    await page
      .getByRole('region', { name: 'Backups' })
      .getByText(/^Daily · /)
      .waitFor()
  })

  test('Settings · Limits changes the limit and shows what is working now', async () => {
    const window = await twoTasksOneSlot()
    await ted('task', 'start', 'NB-1')
    await ted('task', 'start', 'NB-2')
    await openSettings(window)
    await settingsNav(window).getByRole('button', { name: 'Limits', exact: true }).click()
    await window.getByText('Now: 1 of 1 Runs working · 1 queued').waitFor()

    await window.getByRole('button', { name: 'More working Runs' }).click()

    await window.getByText('Now: 2 of 2 Runs working').waitFor()
    expect((await (await daemonClient()).getSettings()).maxWorkingRuns).toBe(2)
  })
})

describe('Archive, Unarchive and Delete', () => {
  async function blockerAndBlocked() {
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    await addFactory(origin, 'NB')
    await ted('task', 'create', '--factory', 'NB', 'Fix the search crash')
    await ted('task', 'create', '--factory', 'NB', 'Highlight search matches')
    await ted('task', 'block', 'NB-2', '--by', 'NB-1')
    const window = await launchApp()
    await openAllTasks(window)
    await taskRow(window, 'Fix the search crash').click()
    const thread = window.getByRole('region', { name: 'Task thread' })
    await thread.getByRole('heading', { name: 'Fix the search crash' }).waitFor()
    return { window, thread, header: thread.locator('header') }
  }

  test('⌘⌫ archives with Keep it blocked, the Task opens read-only, and Unarchive brings it back', async () => {
    const { window, thread, header } = await blockerAndBlocked()

    await window.keyboard.press('ControlOrMeta+Backspace')
    const dialog = window.getByRole('dialog', { name: 'Archive NB-1?' })
    await dialog.getByText('1 Task is blocked by NB-1').waitFor()
    await dialog.getByText('Highlight search matches').waitFor()
    expect(await dialog.getByRole('radio', { name: 'Unblock it' }).isChecked()).toBe(true)
    await dialog.getByRole('radio', { name: 'Keep it blocked' }).check()
    await dialog.getByRole('button', { name: 'Archive' }).click()
    await dialog.waitFor({ state: 'detached' })

    await thread.getByText(/^Archived \d+ \w+$/).waitFor()
    await header.getByText('· Archived before it started').waitFor()
    await thread.getByText('Archived Tasks are read-only. Unarchive to comment.').waitFor()
    expect(await thread.getByRole('textbox', { name: 'Comment' }).count()).toBe(0)
    await waitUntil(async () => {
      const tasks = await (await daemonClient()).listTasks().catch(() => [])
      return tasks.find((t) => t.displayId === 'NB-2')?.activity === 'Blocked by archived NB-1'
    }, 'NB-2 to read “Blocked by archived NB-1”')

    await header.getByRole('button', { name: 'Task actions' }).click()
    const menu = header.getByRole('menu', { name: 'Task actions' })
    expect(await menu.getByRole('menuitem').allTextContents()).toEqual(['Unarchive', 'Delete…'])
    await window.keyboard.press('Escape')

    await thread.getByRole('button', { name: 'Unarchive' }).click()
    await thread.getByRole('textbox', { name: 'Comment' }).waitFor()
    expect(
      await thread.getByText('Archived Tasks are read-only. Unarchive to comment.').count(),
    ).toBe(0)
  })

  test('Delete from the Task actions menu offers Archive instead, and removes the Task', async () => {
    const { window, header } = await blockerAndBlocked()
    const deleteItem = async () => {
      await header.getByRole('button', { name: 'Task actions' }).click()
      await header
        .getByRole('menu', { name: 'Task actions' })
        .getByRole('menuitem', { name: 'Delete…' })
        .click()
      return window.getByRole('dialog', { name: 'Delete NB-1?' })
    }

    const dialog = await deleteItem()
    await dialog.getByText(/This can’t be undone\.$/).waitFor()
    await dialog.getByText('1 Task is blocked by NB-1').waitFor()
    await dialog.getByRole('button', { name: 'Archive instead' }).click()
    await window.getByRole('dialog', { name: 'Archive NB-1?' }).waitFor()
    await window.keyboard.press('Escape')

    await (await deleteItem()).getByRole('button', { name: 'Delete NB-1' }).click()

    await waitUntil(
      async () => (await taskRow(window, 'Fix the search crash').count()) === 0,
      'NB-1 to leave the List',
    )
    const client = await daemonClient()
    const tasks = await client.listTasks()
    expect(tasks.map((t) => t.displayId)).toEqual(['NB-2'])
    expect(tasks[0]?.blockedBy).toEqual([])
  })
})

describe('Stop and Resume', () => {
  async function workingTask(steps: unknown[], daemonEnv: Record<string, string> = {}) {
    ctx.extraEnv = daemonEnv
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    await addFactory(origin, 'NB')
    await ted('task', 'create', '--factory', 'NB', '--start', JSON.stringify({ steps }))
    const window = await launchApp()
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    const thread = window.getByRole('region', { name: 'Task thread' })
    return { thread, header: thread.locator('header') }
  }

  test('the Task actions menu stops the Task, and Send and resume starts a fresh Run', async () => {
    const { thread, header } = await workingTask([{ waitFor: path.join(ctx.home, 'never') }])
    await header.getByText('Working', { exact: true }).waitFor()

    await header.getByRole('button', { name: 'Task actions' }).click()
    const menu = header.getByRole('menu', { name: 'Task actions' })
    const first = menu.getByRole('menuitem').first()
    expect(await first.textContent()).toContain('Stop Task')
    expect(await first.getAttribute('aria-describedby')).toBeTruthy()
    await first.click()

    await header.getByText(/^Stopped by you · /).waitFor()
    await header.getByText('· Worktree and Apps kept. 1 Run stopped.').waitFor()
    await header.getByRole('button', { name: 'Task actions' }).click()
    expect(await menu.getByRole('menuitem').first().textContent()).toContain('Resume')
    await header.page().keyboard.press('Escape')
    await header.getByRole('button', { name: 'Resume' }).waitFor()

    const box = thread.getByRole('textbox', { name: 'Comment' })
    await box.fill('Use the swipe actions.')
    await thread.getByRole('button', { name: 'Send and resume' }).click()

    await header.getByText('Working', { exact: true }).waitFor()
    const client = await daemonClient()
    const comments = await client.listComments('NB-1')
    expect(comments.at(-1)?.delivered).toBeDefined()
  })

  test('an idle Task Lead is nudged, then TED asks with Nudge again', async () => {
    const { thread } = await workingTask(
      [
        { say: 'Templates are wired into New Note.' },
        { endTurn: true },
        { everyMessage: [{ say: 'I’ll check the empty template next.' }, { endTurn: true }] },
      ],
      { TED_NUDGE_AFTER_MS: '200' },
    )
    const card = thread.getByRole('region', { name: 'Question' })
    await card.getByText('The Task Lead stopped without saying why').waitFor()
    await card.getByText('“I’ll check the empty template next.”').waitFor()
    await thread
      .getByText('TED nudged the Task Lead: “Continue, or post a Comment if you need the human.”')
      .first()
      .waitFor()

    await card.getByRole('button', { name: 'Nudge again' }).click()

    await thread.getByText('You answered: Nudge again').waitFor()
  })
})

describe('Failed', () => {
  test('a Task Lead that keeps dying shows Failed, the FAILED ask and the sidebar line; Retry starts again', async () => {
    await writeFile(path.join(ctx.home, 'stub-claude.json'), JSON.stringify({ resumeFails: true }))
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    await commitToOrigin(path.join(ctx.home, 'origin'), {
      '.ted/workflow.yaml': 'version: 1\norder: [intake, work, merge]\n',
    })
    await addFactory(origin, 'NB')
    await ted(
      'task',
      'create',
      '--factory',
      'NB',
      '--start',
      JSON.stringify({ steps: [{ say: 'Starting.' }, { exit: 1 }] }),
    )
    const client = await daemonClient()
    await expect
      .poll(async () => (await client.listTasks())[0]?.status?.kind, { timeout: 30_000 })
      .toBe('failed')

    const window = await launchApp()
    const sidebar = window.getByRole('navigation')
    await sidebar.getByRole('button', { name: '1 failed' }).click()
    await taskRow(window, 'NB-1').filter({ hasText: 'Failed' }).click()
    const thread = window.getByRole('region', { name: 'Task thread' })
    await thread.getByText('Waiting on you to retry').waitFor()
    await thread.getByText('Resume failed · started a fresh Task Lead Run from the brief').waitFor()
    const card = thread.getByRole('region', { name: 'FAILED' })
    await card.getByText('The Task Lead stopped twice in 30 minutes').waitFor()
    await card.getByText('claude exited with code 1').waitFor()

    await card.getByRole('button', { name: 'Open last Run' }).click()
    await window.getByRole('region', { name: 'Run chat' }).getByText('Starting.').first().waitFor()
    await window.getByRole('tab', { name: 'Thread' }).click()

    await card.getByRole('textbox', { name: 'Your answer' }).fill('Try a smaller change.')
    await card.getByRole('button', { name: 'Retry' }).click()

    await thread.getByText('You retried the Task').waitFor()
    const comments = await client.listComments('NB-1')
    expect(comments.some((c) => c.body === 'Try a smaller change.')).toBe(true)
  }, 90_000)
})

describe('daemon crashes', () => {
  const reconnecting = (window: Page) =>
    window.getByRole('status', { name: 'Reconnecting to TED…' })

  async function killDaemon(): Promise<number> {
    const pid = await daemonPid()
    process.kill(pid, 'SIGKILL')
    await waitForExit(pid)
    return pid
  }

  async function waitForNewDaemon(old: number): Promise<number> {
    await expect
      .poll(
        async () => {
          const info = await readDaemonInfo(ctx.home)
          return info !== undefined && info.pid !== old && isAlive(info.pid)
        },
        { timeout: 20_000 },
      )
      .toBe(true)
    return daemonPid()
  }

  test('killing the daemon shows the Reconnecting bar and turns actions off while the Run keeps going; the restarted daemon picks the Run back up', async () => {
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    await commitToOrigin(path.join(ctx.home, 'origin'), {
      '.ted/workflow.yaml': 'version: 1\norder: [intake, work, merge]\n',
    })
    const steps = JSON.stringify({
      steps: [
        { waitFor: path.join(ctx.home, 'go') },
        { everyMessage: [{ run: ['ted', 'outcome', 'advance'] }] },
        { run: ['ted', 'outcome', 'advance'] },
      ],
    })
    await addFactory(origin, 'NB')
    await ted('task', 'create', '--factory', 'NB', steps)
    const window = await launchApp({ TED_RESTART_DELAYS_MS: '1500,0,0' })
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    const details = window.getByRole('complementary', { name: 'Task details' })
    await ted('task', 'start', 'NB-1')
    await details.getByText('Intake', { exact: true }).waitFor()
    await expect.poll(async () => (await runHostPids()).length).toBe(2)
    const hosts = await runHostPids()

    const old = await killDaemon()

    await reconnecting(window).waitFor()
    await reconnecting(window)
      .getByText('Runs keep going. Actions are off until TED is back.')
      .waitFor()
    expect(await sidebar(window).getByRole('button', { name: 'All Tasks' }).isDisabled()).toBe(true)
    expect(hosts.every(isAlive)).toBe(true)

    await waitForNewDaemon(old)
    await reconnecting(window).waitFor({ state: 'detached', timeout: 20_000 })
    expect(await sidebar(window).getByRole('button', { name: 'All Tasks' }).isDisabled()).toBe(
      false,
    )
    await writeFile(path.join(ctx.home, 'go'), '')
    await details.getByText('Done', { exact: true }).waitFor({ timeout: 20_000 })
  })

  test('after reconnecting, the sidebar shows slots that changed while the app was away', async () => {
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    await addFactory(origin, 'NB')
    await ted(
      'task',
      'create',
      '--factory',
      'NB',
      JSON.stringify({ steps: [{ waitFor: path.join(ctx.home, 'never') }] }),
    )
    const window = await launchApp({ TED_RESTART_DELAYS_MS: '6000,0,0' })
    await ted('task', 'start', 'NB-1')
    const footer = sidebar(window).locator('footer')
    await footer.getByRole('button', { name: /^1 of \d+ Runs working$/ }).waitFor()

    await killDaemon()
    await reconnecting(window).waitFor()
    await startDaemonAsApp()
    await (await daemonClient()).updateSettings({ maxWorkingRuns: 7 })

    await reconnecting(window).waitFor({ state: 'detached', timeout: 20_000 })
    await footer.getByRole('button', { name: '1 of 7 Runs working' }).waitFor()
  })

  test('after reconnecting, the Inbox shows a request raised while the app was away', async () => {
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    const briefFile = path.join(ctx.home, 'brief.md')
    await writeFile(
      briefFile,
      [
        '## Goal\n\nLet notes be edited offline.',
        '## Decisions so far\n\n- Keep both edits on a clash.',
        '## Current state\n\nThe approach is written up.',
        '## Open questions\n\nNone.',
        '## Next step\n\nBuild it.\n',
      ].join('\n\n'),
    )
    const gate = [
      { run: ['ted', 'brief', 'write', '--file', briefFile] },
      { run: ['ted', 'outcome', 'advance'] },
      { endTurn: true },
    ]
    await addFactory(origin, 'NB')
    await ted(
      'task',
      'create',
      '--factory',
      'NB',
      JSON.stringify({ steps: [{ everyMessage: gate }, ...gate] }),
    )
    const window = await launchApp({ TED_RESTART_DELAYS_MS: '8000,0,0' })
    const inbox = window.getByRole('region', { name: 'Inbox' })
    await inbox.waitFor()

    await killDaemon()
    await reconnecting(window).waitFor()
    await ted('task', 'start', 'NB-1')
    await expect
      .poll(async () => (await (await daemonClient()).listInbox()).length, { timeout: 20_000 })
      .toBe(1)

    await reconnecting(window).waitFor({ state: 'detached', timeout: 20_000 })
    await inbox.getByRole('button').filter({ hasText: 'Design review' }).waitFor()
  })

  test('three crashes in ten minutes stop restarts and raise the banner; its menu copies a report and restarts TED', async () => {
    const window = await launchApp({ TED_RESTART_DELAYS_MS: '0,0,0' })
    await ctx.app?.evaluate(({ clipboard }) => {
      const record = globalThis as unknown as { copied: string[] }
      record.copied = []
      clipboard.writeText = async (text: string) => {
        record.copied.push(text)
      }
    })
    const recorded = () => ctx.app?.evaluate(() => globalThis as unknown as { copied: string[] })

    await waitForNewDaemon(await killDaemon())
    await reconnecting(window).waitFor({ state: 'detached', timeout: 20_000 })
    await waitForNewDaemon(await killDaemon())
    await reconnecting(window).waitFor({ state: 'detached', timeout: 20_000 })
    await expect
      .poll(() => readFile(path.join(ctx.home, 'logs', 'daemon.log'), 'utf8').catch(() => ''), {
        timeout: 20_000,
      })
      .toMatch(/TED daemon .* listening on/)
    const last = await killDaemon()

    const banner = window.getByRole('region', { name: 'Problems' }).getByRole('alert')
    await banner.getByText('TED’s background process keeps stopping').waitFor()
    expect(await reconnecting(window).count()).toBe(0)
    expect(await sidebar(window).getByRole('button', { name: 'All Tasks' }).isDisabled()).toBe(true)
    await sleep(500)
    expect(await daemonPid()).toBe(last)

    await banner.getByRole('button', { name: 'Restart' }).click()
    await window.getByRole('menuitem', { name: 'Copy report' }).click()
    await expect.poll(async () => (await recorded())?.copied.length).toBe(1)
    const [report] = (await recorded())?.copied ?? []
    expect(report).toContain('crash report')
    expect(report).toMatch(/TED daemon .* listening on/)
    expect(report).toContain('starting TED’s daemon')

    await banner.getByRole('button', { name: 'Restart' }).click()
    await window.getByRole('menuitem', { name: 'Restart TED in the background' }).click()

    await banner.waitFor({ state: 'detached', timeout: 20_000 })
    await waitForNewDaemon(last)
    await reconnecting(window).waitFor({ state: 'detached', timeout: 20_000 })
    expect(await sidebar(window).getByRole('button', { name: 'All Tasks' }).isDisabled()).toBe(
      false,
    )
  })
})
