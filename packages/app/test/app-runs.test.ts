import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { commitToOrigin, makeOriginRepo, waitUntil } from '../../daemon/test/helpers.ts'
import {
  addFactory,
  ctx,
  daemonClient,
  launchApp,
  openAllTasks,
  setUpAppTests,
  taskRow,
  ted,
} from './app-harness.ts'

setUpAppTests()

describe('Working Runs', () => {
  test('a nearly full disk shows a warning whose Open Storage shows what uses the space', async () => {
    const free = path.join(ctx.home, 'free-bytes')
    await writeFile(free, String(8.2e9))
    const window = await launchApp({ TED_FREE_BYTES_FILE: free })
    await window.getByText('Disk almost full · 8.2 GB free').waitFor()
    const client = await daemonClient()
    await expect
      .poll(async () => (await client.listBackups()).backups.length, { timeout: 20_000 })
      .toBeGreaterThan(0)

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
    const menu = header.page().getByRole('menu', { name: /Task actions/ })
    expect(await menu.getByRole('menuitem').allTextContents()).toEqual([
      'Unarchive',
      'Copy Task ID',
      'Full brief',
      'Delete…',
    ])
    await window.keyboard.press('Escape')

    await thread.getByRole('button', { name: 'Unarchive' }).click()
    await thread.getByRole('textbox', { name: 'Comment' }).waitFor()
    expect(
      await thread.getByText('Archived Tasks are read-only. Unarchive to comment.').count(),
    ).toBe(0)
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
    const menu = header.page().getByRole('menu', { name: /Task actions/ })
    const first = menu.getByRole('menuitem').first()
    expect(await first.textContent()).toContain('Stop Task')
    expect(await first.getAttribute('aria-describedby')).toBeTruthy()
    expect(
      await first.evaluate((item) => {
        const label = item.firstElementChild!
        const bubble = label.firstElementChild!.getBoundingClientRect()
        const range = document.createRange()
        range.selectNodeContents(label.firstChild!)
        const text = range.getBoundingClientRect()
        return Math.abs(bubble.y + bubble.height / 2 - (text.y + text.height / 2))
      }),
    ).toBeLessThan(1)
    expect(await menu.getByRole('menuitem', { name: 'Restart', exact: true }).isDisabled()).toBe(
      true,
    )
    await first.click()

    await header.getByText(/^Stopped by you · /).waitFor()
    await header.getByText('· Worktree and Apps kept. 1 Run stopped.').waitFor()
    await header.getByRole('button', { name: 'Task actions' }).click()
    expect(await menu.getByRole('menuitem').first().textContent()).toContain('Resume')
    expect(await menu.getByRole('menuitem', { name: 'Restart', exact: true }).count()).toBe(0)
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
    await window.getByRole('tab', { name: 'Task Lead' }).click()

    await card.getByRole('textbox', { name: 'Your answer' }).fill('Try a smaller change.')
    await card.getByRole('button', { name: 'Retry' }).click()

    await thread.getByText('You retried the Task').waitFor()
    const comments = await client.listComments('NB-1')
    expect(comments.some((c) => c.body === 'Try a smaller change.')).toBe(true)
  }, 90_000)
})
