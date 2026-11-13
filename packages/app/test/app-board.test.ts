import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { DaemonClient } from '@ted/protocol'
import type { Page } from 'playwright'
import { describe, expect, test } from 'vitest'
import { commitToOrigin, makeOriginRepo, waitUntil } from '../../daemon/test/helpers.ts'
import {
  addFactory,
  ctx,
  daemonClient,
  launchApp,
  openFactoryView,
  setUpAppTests,
  sidebar,
  ted,
  twoFactories,
  waitFor,
} from './app-harness.ts'
import { appLoaded } from './first-window.ts'

setUpAppTests()

describe('List and All Tasks', () => {
  const forever = () => JSON.stringify({ steps: [{ waitFor: path.join(ctx.home, 'never') }] })

  const rowIds = (window: Page) =>
    window
      .getByRole('main')
      .locator('tbody tr[data-task]')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-task')))

  test('a failed bulk Task context action keeps its error inside the viewport without shrinking the app', async () => {
    await twoFactories()
    await ted('task', 'create', '--factory', 'NB', 'Notebook covers')
    await ted('task', 'create', '--factory', 'NB', 'Export notes')
    const window = await launchApp()
    await sidebar(window).getByRole('button', { name: 'All Tasks', exact: true }).click()
    const mainWidth = await window
      .getByRole('main')
      .evaluate((element) => element.getBoundingClientRect().width)
    await window.evaluate(() => {
      Object.defineProperty(navigator.clipboard, 'writeText', {
        configurable: true,
        value: async () => {
          throw new Error('Copy refused')
        },
      })
    })
    for (const id of ['NB-1', 'NB-2'])
      await window.locator(`tr[data-task="${id}"]`).click({ modifiers: ['Meta'] })
    await window.locator('tr[data-task="NB-1"]').click({ button: 'right' })
    await window.getByRole('menuitem', { name: 'Copy Task IDs', exact: true }).click()
    const alert = window.getByRole('alert').filter({ hasText: 'Copy refused' })
    await alert.waitFor()
    expect(
      await window.getByRole('main').evaluate((element) => element.getBoundingClientRect().width),
    ).toBe(mainWidth)
    expect(
      await alert.evaluate((element) => {
        const box = element.getBoundingClientRect()
        return (
          box.width > 0 &&
          box.height > 0 &&
          box.top >= 0 &&
          box.bottom <= innerHeight &&
          box.left >= 0 &&
          box.right <= innerWidth
        )
      }),
    ).toBe(true)
  })

  test('Open in List shows the machine-wide queue, and dragging there reorders it', async () => {
    await twoFactories()
    await ted('task', 'create', '--factory', 'NB', forever())
    await ted('task', 'create', '--factory', 'NB', 'Notebook covers')
    await ted('task', 'create', '--factory', 'MS', 'Blog post template')
    const window = await launchApp()
    const client = await daemonClient()
    await client.updateSettings({ maxWorkingRuns: 1 })
    for (const id of ['NB-1', 'NB-2', 'MS-1']) await ted('task', 'start', id)

    await sidebar(window)
      .getByRole('button', { name: /1 queued|2 queued/ })
      .click()
    await window.getByRole('button', { name: 'Open in List →' }).click()
    const main = window.getByRole('main')
    await main.getByText('machine-wide queue, in start order').waitFor()
    await main.getByRole('columnheader', { name: 'Queue' }).waitFor()
    await main.locator('tr[data-task="MS-1"]').getByText('2nd', { exact: true }).waitFor()
    expect(await rowIds(window)).toEqual(['NB-2', 'MS-1'])

    await main
      .locator('tr[data-task="MS-1"]')
      .dragTo(main.locator('tr[data-task="NB-2"]'), { targetPosition: { x: 400, y: 4 } })

    await main.locator('tr[data-task="MS-1"]').getByText('1st', { exact: true }).waitFor()
    expect(
      (await client.getSlots()).queue.map((q) => ('displayId' in q ? q.displayId : q.name)),
    ).toEqual(['MS-1', 'NB-2'])

    await main.getByRole('button', { name: 'Clear Status is Queued' }).click()
    await main.getByText('machine-wide queue, in start order').waitFor({ state: 'detached' })
    expect(await main.getByRole('columnheader', { name: 'Queue' }).count()).toBe(0)
  })
})

describe('Board', () => {
  const forever = () => JSON.stringify({ steps: [{ waitFor: path.join(ctx.home, 'never') }] })

  async function boardOf(workflow?: string): Promise<Page> {
    const parent = path.join(ctx.home, 'origin')
    const origin = await makeOriginRepo(parent)
    if (workflow !== undefined) await commitToOrigin(parent, { '.ted/workflow.yaml': workflow })
    await addFactory(origin, 'NB')
    return launchApp()
  }

  async function openBoard(window: Page) {
    await openFactoryView(window, 'widgets', 'Board')
    const board = window.getByRole('region', { name: 'widgets' })
    await board.getByRole('region', { name: 'Backlog' }).waitFor()
    return board
  }

  const cardIds = (column: ReturnType<Page['getByRole']>) =>
    column
      .locator('[data-task]')
      .evaluateAll((cards) => cards.map((card) => card.getAttribute('data-task')))

  test('dragging Backlog → Intake starts a Task, Queued → Backlog un-starts it, other drops are refused', async () => {
    const window = await boardOf()
    const client = await daemonClient()
    await client.updateSettings({ maxWorkingRuns: 1 })
    const activity =
      'Couldn’t start: git worktree failed at /projects/a-very-long-worktree-path/'.repeat(2)
    await ted(
      'task',
      'create',
      '--factory',
      'NB',
      JSON.stringify({
        steps: [{ run: ['ted', 'status', activity] }, { waitFor: path.join(ctx.home, 'never') }],
      }),
    )
    await ted('task', 'create', '--factory', 'NB', 'Export notes')
    await ted('task', 'start', 'NB-1')
    const board = await openBoard(window)
    const activityLine = board.getByText(activity, { exact: true })
    await activityLine.waitFor()
    expect(
      await board
        .locator('[data-stage]')
        .evaluateAll((columns) =>
          columns.every((column) => column.getBoundingClientRect().width === 248),
        ),
    ).toBe(true)
    expect(
      await activityLine.evaluate((element) => {
        const card = element.closest('[data-task]')
        if (!card) return false
        const line = element.getBoundingClientRect()
        const bounds = card.getBoundingClientRect()
        return (
          line.left >= bounds.left &&
          line.right <= bounds.right &&
          element.scrollWidth > element.clientWidth &&
          getComputedStyle(element).textOverflow === 'ellipsis'
        )
      }),
    ).toBe(true)
    await board.getByRole('region', { name: 'Done', exact: true }).scrollIntoViewIfNeeded()
    expect(
      await board.getByRole('region', { name: 'Done', exact: true }).evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        return bounds.left >= 0 && bounds.right <= innerWidth
      }),
    ).toBe(true)
    const backlog = board.getByRole('region', { name: 'Backlog' })
    const intake = board.getByRole('region', { name: 'Intake' })
    await backlog.locator('[data-task="NB-2"]').waitFor()

    await backlog.locator('[data-task="NB-2"]').dragTo(board.getByRole('region', { name: 'Work' }))
    await sleep(300)
    expect((await client.listTasks()).find((t) => t.displayId === 'NB-2')?.stage).toBe('backlog')

    await backlog.locator('[data-task="NB-2"]').dragTo(intake)
    await intake.locator('[data-task="NB-2"]').getByText('Queued · 1st').waitFor()
    await intake.locator('[data-task="NB-2"]').getByText('Waiting for a free Run slot').waitFor()

    await intake.locator('[data-task="NB-2"]').dragTo(backlog)
    await backlog.locator('[data-task="NB-2"]').waitFor()
    expect((await client.getSlots()).queued).toBe(0)
  })

  test('the drag shows the drop slot in Intake and dims the columns it can’t go to', async () => {
    const window = await boardOf()
    await ted('task', 'create', '--factory', 'NB', 'Export notes')
    const board = await openBoard(window)
    const card = board.getByRole('region', { name: 'Backlog' }).locator('[data-task="NB-1"]')
    await card.waitFor()

    const cardBox = await card.boundingBox()
    if (!cardBox) throw new Error('no Backlog card')
    await card.hover()
    await window.mouse.down()
    const work = board.getByRole('region', { name: 'Work' })
    const workBox = await work.boundingBox()
    if (!workBox) throw new Error('no Work column')
    const pointer = { x: workBox.x + 100, y: workBox.y + 100 }
    await window.mouse.move(pointer.x, pointer.y, { steps: 5 })
    await window.mouse.move(pointer.x, pointer.y + 1)
    const hint = board.getByText('Can’t drop here')
    await hint.waitFor()
    const hintBox = await hint.boundingBox()
    if (!hintBox) throw new Error('no refused drop feedback')
    const previewTop = pointer.y + 1 - cardBox.height / 2
    expect(
      hintBox.y + hintBox.height <= previewTop - 12 ||
        hintBox.y >= previewTop + cardBox.height + 12,
    ).toBe(true)
    const viewport = await window.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    expect(hintBox.x).toBeGreaterThanOrEqual(8)
    expect(hintBox.x + hintBox.width).toBeLessThanOrEqual(viewport.width - 8)
    expect(hintBox.y).toBeGreaterThanOrEqual(8)
    expect(hintBox.y + hintBox.height).toBeLessThanOrEqual(viewport.height - 8)
    const intake = board.getByRole('region', { name: 'Intake' })
    const box = await intake.boundingBox()
    if (!box) throw new Error('no Intake column')
    await window.mouse.move(box.x + 100, box.y + 60, { steps: 5 })
    await window.mouse.move(box.x + 110, box.y + 70, { steps: 5 })

    await intake.getByText('Drop to Start').waitFor()
    expect(await hint.count()).toBe(0)
    await intake.getByText('Joins the queue as Queued · 1st').waitFor()
    expect(await board.getByRole('region', { name: 'Work' }).getAttribute('data-drop')).toBe('no')
    await window.mouse.up()
  })

  test('dragging up a column changes rank, and across Priority groups the Priority', async () => {
    const window = await boardOf()
    const client = await daemonClient()
    await client.createTask({ factory: 'NB', priority: 'high', title: 'Sync notes' })
    await client.createTask({ factory: 'NB', title: 'Export notes' })
    await client.createTask({ factory: 'NB', title: 'Note history' })
    const board = await openBoard(window)
    const backlog = board.getByRole('region', { name: 'Backlog' })
    await waitFor(async () => (await cardIds(backlog)).length === 3)
    expect(await cardIds(backlog)).toEqual(['NB-1', 'NB-2', 'NB-3'])

    await backlog
      .locator('[data-task="NB-3"]')
      .dragTo(backlog.locator('[data-task="NB-2"]'), { targetPosition: { x: 40, y: 4 } })
    await waitFor(async () => (await cardIds(backlog)).join() === 'NB-1,NB-3,NB-2')
    expect((await client.listTasks()).find((t) => t.displayId === 'NB-3')?.priority).toBe('none')

    await backlog
      .locator('[data-task="NB-2"]')
      .dragTo(backlog.locator('[data-task="NB-1"]'), { targetPosition: { x: 40, y: 4 } })
    await waitFor(async () => (await cardIds(backlog)).join() === 'NB-2,NB-1,NB-3')
    expect((await client.listTasks()).find((t) => t.displayId === 'NB-2')?.priority).toBe('high')

    await backlog.locator('[data-task="NB-1"] [data-card-title]').click()
    const details = window.getByLabel('Task details')
    const children = details.getByRole('region', { name: 'Children' })
    await children.getByRole('button', { name: 'Create child' }).click()
    const dialog = window.getByRole('dialog')
    await dialog
      .getByText('NB-1 waits for this Task to merge before it does its own remaining work.')
      .waitFor()
    await dialog.getByLabel('Title').fill('Offline badge')
    await dialog.getByLabel('Description').fill('Show a badge while edits wait to sync.')
    await dialog.getByLabel('Start now').uncheck()
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    await children.locator('[data-task="NB-4"]').waitFor()
    await children.getByRole('button', { name: 'Add existing Task' }).click()
    await children.getByLabel('Find a Task to add').fill('Note history')
    await children.getByLabel('Find a Task to add').press('Enter')
    await children.locator('[data-task="NB-3"]').waitFor()
    await children.getByText('Will wait for 2 children:', { exact: false }).waitFor()
    const tasks = await client.listTasks()
    const id = (displayId: string) => tasks.find((t) => t.displayId === displayId)?.id
    expect(tasks.find((t) => t.displayId === 'NB-4')?.parentId).toBe(id('NB-1'))
    expect(tasks.find((t) => t.displayId === 'NB-3')?.parentId).toBe(id('NB-1'))

    await children.locator('[data-task="NB-4"]').click()
    await window
      .getByRole('region', { name: 'Task thread' })
      .getByText('Offline badge')
      .first()
      .waitFor()
    await details.getByRole('button', { name: /NB-1/ }).waitFor()

    await window.reload()
    await appLoaded(window)
    const again = await openBoard(window)
    await again.locator('[data-task="NB-1"] [data-card-title]').click()
    const reloaded = window.getByLabel('Task details').getByRole('region', { name: 'Children' })
    await reloaded.locator('[data-task="NB-3"]').waitFor()
    await reloaded.locator('[data-task="NB-4"]').waitFor()
  })

  const toDone = JSON.stringify({
    steps: [
      { everyMessage: [{ run: ['ted', 'outcome', 'advance'] }] },
      { run: ['ted', 'outcome', 'advance'] },
    ],
  })

  async function doneTasks(count: number): Promise<DaemonClient> {
    const client = await daemonClient()
    for (let i = 0; i < count; i++) {
      const task = await client.createTask({ factory: 'NB', title: toDone })
      await client.startTask(task.id)
    }
    await waitUntil(
      async () =>
        (await client.listTasks()).filter((t) => t.stage === 'done').length === count || undefined,
      'the Tasks to reach Done',
      30_000,
    )
    return client
  }

  test('a Comment on a Done Task offers Comment only and Follow up, which opens the linked Task', async () => {
    const window = await boardOf('version: 1\norder: [intake, work, merge]\n')
    await doneTasks(1)
    const board = await openBoard(window)
    const done = board.getByRole('region', { name: 'Done' })
    await done.locator('[data-task="NB-1"]').getByRole('button').click()
    const thread = window.getByRole('region', { name: 'Task thread' })
    await thread.getByText(/· Merged just now/).waitFor()

    const box = thread.getByRole('textbox', { name: 'Comment' })
    await box.fill(forever())
    await thread.getByRole('button', { name: 'Comment only' }).waitFor()
    await thread.getByRole('button', { name: 'Follow up' }).click()

    await thread.getByText(/NB-2\s+·\s+Follow-up to NB-1/).waitFor()
    await thread.getByRole('button', { name: 'NB-1' }).click()
    await thread.getByText('You followed up in NB-2').waitFor()

    await thread.getByRole('button', { name: 'Task actions' }).click()
    await window.getByRole('menuitem', { name: /Follow up…/ }).click()
    const dialog = window.getByRole('dialog', { name: 'Follow up NB-1?' })
    await dialog.getByRole('textbox').fill(forever())
    await dialog.getByRole('button', { name: 'Follow up' }).click()
    await thread.getByText(/NB-3\s+·\s+Follow-up to NB-1/).waitFor()
  })
})
