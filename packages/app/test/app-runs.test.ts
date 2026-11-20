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
  startDaemonAsApp,
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

  test('⌘⌫ archives and unblocks the Task it blocks, the Task opens read-only, and Unarchive brings it back', async () => {
    const { window, thread, header } = await blockerAndBlocked()

    await window.keyboard.press('ControlOrMeta+Backspace')
    const dialog = window.getByRole('dialog', { name: 'Archive NB-1?' })
    const unblocks = dialog.getByRole('region', { name: 'Unblocks 1 Task' })
    await unblocks.getByText('Highlight search matches').waitFor()
    expect(await dialog.getByRole('radio').count()).toBe(0)
    await dialog.getByRole('button', { name: 'Archive' }).click()
    await dialog.waitFor({ state: 'detached' })

    await thread.getByText(/^Archived \d+ \w+$/).waitFor()
    await header.getByText('· Archived before it started').waitFor()
    await thread.getByText('Archived Tasks are read-only. Unarchive to comment.').waitFor()
    expect(await thread.getByRole('textbox', { name: 'Comment' }).count()).toBe(0)
    await waitUntil(async () => {
      const tasks = await (await daemonClient()).listTasks().catch(() => [])
      return tasks.find((t) => t.displayId === 'NB-2')?.blockedBy.length === 0
    }, 'NB-2 to be unblocked')

    await header.getByRole('button', { name: 'Task actions' }).click()
    const menu = header.page().getByRole('menu', { name: /Task actions/ })
    const items = await menu.getByRole('menuitem').allTextContents()
    expect(items[0]).toBe('Unarchive')
    expect(items.at(-1)).toBe('Delete…')
    expect(items).not.toContain('Copy Task ID')
    expect(items).not.toContain('Full brief')
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
        const label = item.firstElementChild
        const words = label?.firstChild
        const tip = label?.firstElementChild
        if (!words || !tip) throw new Error('Stop Task has no label and tooltip')
        const bubble = tip.getBoundingClientRect()
        const range = document.createRange()
        range.selectNodeContents(words)
        const text = range.getBoundingClientRect()
        return Math.abs(bubble.y + bubble.height / 2 - (text.y + text.height / 2))
      }),
    ).toBeLessThan(1)
    await first.hover()
    const tooltip = header.page().getByRole('tooltip')
    await tooltip.waitFor()
    expect(
      await tooltip.evaluate((element) => {
        const box = element.getBoundingClientRect()
        const menu = element.ownerDocument.querySelector('[role="menu"]')?.getBoundingClientRect()
        const middleX = box.left + box.width / 2
        const middleY = box.top + box.height / 2
        const edges = [
          [box.left + 2, middleY],
          [box.right - 2, middleY],
          [middleX, box.top + 2],
          [middleX, box.bottom - 2],
        ]
        const style = (element as HTMLElement).style
        const pointerEvents = style.pointerEvents
        style.pointerEvents = 'auto'
        const visible = edges.every(([x, y]) => {
          const hit = document.elementFromPoint(x ?? 0, y ?? 0)
          return hit === element || element.contains(hit)
        })
        style.pointerEvents = pointerEvents
        return {
          visible,
          besideMenu: !!menu && (box.right <= menu.left || box.left >= menu.right),
        }
      }),
    ).toEqual({ visible: true, besideMenu: true })
    expect(await menu.getByRole('menuitem', { name: 'Restart', exact: true }).count()).toBe(0)
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
    await expect
      .poll(async () => (await client.listComments('NB-1')).at(-1)?.delivered)
      .toBeDefined()
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

    const answer = thread.getByRole('region', { name: 'Answer', exact: true })
    await answer.getByRole('button', { name: 'Open last Run' }).click()
    await window.getByRole('region', { name: 'Run chat' }).getByText('Starting.').first().waitFor()
    await window.getByRole('tab', { name: 'Task Lead' }).click()

    await answer.getByRole('textbox', { name: 'Your answer' }).fill('Try a smaller change.')
    await answer.getByRole('radio', { name: 'Retry', exact: true }).check()
    expect((await client.listTasks())[0]?.status?.kind).toBe('failed')
    await answer.getByRole('button', { name: 'Send', exact: true }).click()

    await thread.getByText('You retried the Task').waitFor()
    const comments = await client.listComments('NB-1')
    expect(comments.some((c) => c.body === 'Try a smaller change.')).toBe(true)
  }, 90_000)
})

describe('Run chat', () => {
  const bash = (id: string, command: string, description: string) => [
    {
      emit: {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id, name: 'Bash', input: { command, description } }],
        },
      },
    },
    {
      emit: {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }],
        },
      },
    },
  ]

  test('long tool-call descriptions stay on one line inside their row and show in full on hover', async () => {
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    await commitToOrigin(path.join(ctx.home, 'origin'), {
      '.ted/workflow.yaml': 'version: 1\norder: [intake, work, merge]\n',
    })
    await startDaemonAsApp()
    await addFactory(origin, 'NB')
    const long =
      'Find the renderer API used to answer a Task request and the preload route it goes through on its way to the daemon'
    const steps = [
      { everyMessage: [{ say: 'Noted.' }, { endTurn: true }] },
      ...bash('t1', '', long),
      ...bash(
        't2',
        `grep -n "answerRequest" ${'packages/app/src/renderer/ted.ts '.repeat(4)}`,
        long,
      ),
      ...bash('t3', 'ls', long),
      { say: 'Done.' },
      { endTurn: true },
    ]
    await ted('task', 'create', '--factory', 'NB', JSON.stringify({ steps }))
    await ted('task', 'start', 'NB-1')
    const client = await daemonClient()
    await expect
      .poll(async () => (await client.listTasks())[0]?.runs[0]?.state, { timeout: 20_000 })
      .toBe('idle')

    const window = await launchApp()
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    const details = window.getByRole('complementary', { name: 'Task details' })
    await details.getByRole('tab', { name: 'Runs' }).click()
    await details.getByRole('button', { name: /Task Lead/ }).click()
    const chat = window.getByRole('region', { name: 'Run chat' })
    await chat.getByText('Done.').waitFor()
    await chat.getByRole('button', { name: /3 tool calls/ }).click()

    const rows = chat.getByRole('button', { name: /^Bash/ })
    await expect.poll(() => rows.count()).toBe(3)
    for (const row of await rows.all()) {
      const description = row.getByTitle(long)
      await description.waitFor()
      const layout = await row.evaluate((head) => {
        const box = head.getBoundingClientRect()
        const parts = [...head.querySelectorAll('span')].map((part) => part.getBoundingClientRect())
        return {
          inside: parts.every((part) => part.left >= box.left && part.right <= box.right + 0.5),
          scrolls: head.scrollWidth > head.clientWidth,
        }
      })
      expect(layout).toEqual({ inside: true, scrolls: false })
      const text = await description.evaluate((meta) => ({
        lines: meta.getClientRects().length,
        clipped: meta.scrollWidth > meta.clientWidth,
        whiteSpace: getComputedStyle(meta).whiteSpace,
      }))
      expect(text).toEqual({ lines: 1, clipped: true, whiteSpace: 'nowrap' })
    }

    const both = rows.nth(1)
    const command = both.locator('[title^="grep -n"]')
    const commandWidth = (await command.boundingBox())?.width ?? 0
    const descriptionWidth = (await both.getByTitle(long).boundingBox())?.width ?? 0
    expect(commandWidth).toBeGreaterThan((commandWidth + descriptionWidth) * 0.4)
  }, 90_000)
})
