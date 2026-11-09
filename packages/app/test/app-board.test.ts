import { mkdir, writeFile } from 'node:fs/promises'
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
  githubReady,
  launchApp,
  openAllTasks,
  run,
  setUpAppTests,
  sidebar,
  taskRow,
  ted,
  twoFactories,
  waitFor,
} from './app-harness.ts'

setUpAppTests()

describe('List and All Tasks', () => {
  const forever = () => JSON.stringify({ steps: [{ waitFor: path.join(ctx.home, 'never') }] })

  const rowIds = (window: Page) =>
    window
      .getByRole('main')
      .locator('tbody tr[data-task]')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-task')))

  test('grouping, sort, columns and filters change the List and are remembered per scope', async () => {
    await twoFactories()
    const window = await launchApp()
    const client = await daemonClient()
    await client.createTask({ factory: 'NB', priority: 'low', title: 'Export notes' })
    await client.createTask({ factory: 'NB', priority: 'high', title: 'Sync notes' })
    await client.createTask({ factory: 'MS', title: 'Pricing page' })
    await openAllTasks(window)
    const main = window.getByRole('main')
    await main.getByRole('button', { name: 'notebook' }).waitFor()
    await main.getByRole('button', { name: 'site' }).waitFor()
    expect(await rowIds(window)).toEqual(['NB-2', 'NB-1', 'MS-1'])
    await main.getByRole('columnheader', { name: 'Factory' }).waitFor()

    await main.getByRole('button', { name: 'Display' }).click()
    await main.getByRole('menuitem', { name: /^Manual/ }).hover()
    await main.getByRole('menuitemradio', { name: 'Title' }).click()
    await main.getByRole('menuitem', { name: 'Factory' }).hover()
    await main.getByRole('menuitemradio', { name: 'None' }).click()
    await main.getByRole('menuitemcheckbox', { name: 'Created by' }).click()
    await window.keyboard.press('Escape')
    await main.getByRole('columnheader', { name: 'Created by' }).waitFor()
    expect(await rowIds(window)).toEqual(['NB-1', 'MS-1', 'NB-2'])

    await main.getByRole('button', { name: 'Filter' }).click()
    await main.getByRole('menuitem', { name: 'Priority' }).hover()
    await main.getByRole('menuitemcheckbox', { name: /High/ }).click()
    await window.keyboard.press('Escape')
    await main.getByText('Priority is High').waitFor()
    expect(await rowIds(window)).toEqual(['NB-2'])

    await sidebar(window).getByRole('button', { name: 'notebook' }).click()
    await sidebar(window).getByRole('button', { name: 'List', exact: true }).click()
    await main.getByRole('button', { name: 'Backlog' }).waitFor()
    expect(await rowIds(window)).toEqual(['NB-2', 'NB-1'])

    await window.keyboard.press('/')
    await window.keyboard.type('export')
    expect(await rowIds(window)).toEqual(['NB-1'])

    const views = (await client.getSettings()).listViews
    expect(views.all).toMatchObject({
      sort: 'title',
      group: 'none',
      filters: { priorities: ['high'] },
    })
    expect(views.all?.columns).toContain('created-by')
    await ctx.app?.close()
    const again = await launchApp()
    await openAllTasks(again)
    await again.getByRole('main').getByText('Priority is High').waitFor()
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

  test('multi-select starts, sets Priority on and archives Tasks of different Factories', async () => {
    await twoFactories()
    await ted('task', 'create', '--factory', 'NB', 'Export notes')
    await ted('task', 'create', '--factory', 'MS', 'Pricing page')
    await ted('task', 'create', '--factory', 'MS', 'Case studies')
    const window = await launchApp()
    const client = await daemonClient()
    await client.updateSettings({ maxWorkingRuns: 1 })
    await ted('task', 'start', 'MS-2')
    await openAllTasks(window)
    const main = window.getByRole('main')

    await taskRow(window, 'NB-1').click({ modifiers: ['Meta'] })
    await taskRow(window, 'MS-1').click({ modifiers: ['Meta'] })
    const bar = main.getByRole('toolbar', { name: 'Selected Tasks' })
    await bar.getByText('2 selected').waitFor()

    await bar.getByRole('button', { name: 'Priority' }).click()
    await bar.getByRole('menuitem', { name: 'Urgent' }).click()
    await waitFor(async () => {
      const tasks = await client.listTasks()
      return ['NB-1', 'MS-1'].every(
        (id) => tasks.find((t) => t.displayId === id)?.priority === 'urgent',
      )
    })

    await bar.getByRole('button', { name: 'Start' }).click()
    await waitFor(async () =>
      (await client.listTasks())
        .filter((t) => ['NB-1', 'MS-1'].includes(t.displayId))
        .every((t) => t.stage !== 'backlog'),
    )

    await bar.getByRole('button', { name: 'Archive' }).click()
    await bar.getByRole('button', { name: 'Archive 2 Tasks' }).click()
    await waitFor(async () =>
      (await client.listTasks())
        .filter((t) => ['NB-1', 'MS-1'].includes(t.displayId))
        .every((t) => t.archived !== undefined),
    )
    await expect.poll(() => rowIds(window)).toEqual(['MS-2'])

    await main.getByRole('button', { name: 'Filter' }).click()
    await main.getByRole('menuitemradio', { name: 'Only' }).click()
    await window.keyboard.press('Escape')
    await main.getByRole('columnheader', { name: 'Archived' }).waitFor()
    expect((await rowIds(window)).sort()).toEqual(['MS-1', 'NB-1'])
    await main.locator('tr[data-task="NB-1"]').getByText('Archived', { exact: true }).waitFor()
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
    await sidebar(window).getByRole('button', { name: 'widgets' }).click()
    const board = window.getByRole('region', { name: 'widgets' })
    await board.getByRole('region', { name: 'Backlog' }).waitFor()
    return board
  }

  const cardIds = (column: ReturnType<Page['getByRole']>) =>
    column
      .locator('[data-task]')
      .evaluateAll((cards) => cards.map((card) => card.getAttribute('data-task')))

  const columnNames = (board: ReturnType<Page['getByRole']>) =>
    board
      .locator('[data-stage]')
      .evaluateAll((columns) => columns.map((column) => column.getAttribute('aria-label')))

  test('columns follow the Factory’s Workflow, with Gated Stages marked', async () => {
    const window = await boardOf(
      'version: 1\norder: [intake, work, review]\nstages:\n  review: { gate: true }\n',
    )
    const board = await openBoard(window)

    await waitFor(async () => (await columnNames(board)).length === 5)
    expect(await columnNames(board)).toEqual(['Backlog', 'Intake', 'Work', 'Review', 'Done'])
    await board.getByRole('region', { name: 'Review' }).getByText('Gate').waitFor()
    expect(await board.getByRole('region', { name: 'Work' }).getByText('Gate').count()).toBe(0)
    await board.getByRole('heading', { name: /widgets\s*\/\s*Board/ }).waitFor()
    await board.getByRole('button', { name: 'Filter' }).waitFor()
    await board.getByRole('button', { name: 'Plan' }).first().waitFor()
  })

  test('dragging Backlog → Intake starts a Task, Queued → Backlog un-starts it, other drops are refused', async () => {
    const window = await boardOf()
    const client = await daemonClient()
    await client.updateSettings({ maxWorkingRuns: 1 })
    await ted('task', 'create', '--factory', 'NB', forever())
    await ted('task', 'create', '--factory', 'NB', 'Export notes')
    await ted('task', 'start', 'NB-1')
    const board = await openBoard(window)
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

    await card.hover()
    await window.mouse.down()
    const intake = board.getByRole('region', { name: 'Intake' })
    const box = await intake.boundingBox()
    if (!box) throw new Error('no Intake column')
    await window.mouse.move(box.x + 100, box.y + 60, { steps: 5 })
    await window.mouse.move(box.x + 110, box.y + 70, { steps: 5 })

    await intake.getByText('Drop to Start').waitFor()
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
  })

  test('Start on a Backlog card starts it; a blocked card has no Start; Filter narrows the cards', async () => {
    const window = await boardOf()
    const client = await daemonClient()
    await client.createTask({ factory: 'NB', priority: 'high', title: 'Sync notes' })
    await client.createTask({ factory: 'NB', title: 'Export notes', blockedBy: ['NB-1'] })
    const board = await openBoard(window)
    const backlog = board.getByRole('region', { name: 'Backlog' })
    await backlog.locator('[data-task="NB-2"]').getByText('Starts when NB-1 merges').waitFor()
    expect(await backlog.getByRole('button', { name: 'Start NB-2' }).count()).toBe(0)

    await board.getByRole('button', { name: 'Filter' }).click()
    expect(await board.getByRole('menuitem', { name: 'Stage' }).count()).toBe(0)
    expect(await board.getByRole('menuitemradio', { name: 'Only' }).count()).toBe(0)
    await board.getByRole('menuitem', { name: 'Priority' }).hover()
    await board.getByRole('menuitemcheckbox', { name: /High/ }).click()
    await window.keyboard.press('Escape')
    await waitFor(async () => (await cardIds(backlog)).join() === 'NB-1')

    await backlog.getByRole('button', { name: 'Start NB-1' }).click()
    await board.getByRole('region', { name: 'Intake' }).locator('[data-task="NB-1"]').waitFor()
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

  test('the Done column lists Done Tasks as compact cards; Show all opens the List; Archive all asks with the count', async () => {
    const window = await boardOf('version: 1\norder: [intake, work, merge]\n')
    await doneTasks(2)
    const board = await openBoard(window)
    const done = board.getByRole('region', { name: 'Done' })

    await waitFor(async () => (await cardIds(done)).length === 2)
    await done.locator('[data-task="NB-2"]').getByText('NB-2 · Merged just now').waitFor()
    await done.getByRole('button', { name: 'Show all 2 →' }).click()
    await window.getByRole('heading', { name: /widgets\s*\/\s*List/ }).waitFor()
    await window.getByText('Stage is Done').waitFor()

    await sidebar(window).getByRole('button', { name: 'Board', exact: true }).click()
    await board.getByRole('button', { name: 'Done column actions' }).click()
    await board.getByRole('menuitem', { name: 'Archive all in Done' }).click()
    const dialog = window.getByRole('dialog', { name: 'Archive 2 Done Tasks?' })
    await dialog.getByRole('button', { name: 'Archive 2' }).click()
    await waitFor(async () => (await cardIds(done)).length === 0)
    expect(await board.getByRole('button', { name: /Show all/ }).count()).toBe(0)
  })

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
    await thread.getByRole('menuitem', { name: /Follow up…/ }).click()
    const dialog = window.getByRole('dialog', { name: 'Follow up NB-1?' })
    await dialog.getByRole('textbox').fill(forever())
    await dialog.getByRole('button', { name: 'Follow up' }).click()
    await thread.getByText(/NB-3\s+·\s+Follow-up to NB-1/).waitFor()
  })
})

describe('setup Tasks', () => {
  test('the setup Task shows its Setup chip, its note, Tutorial Comments and the proposal card', async () => {
    const parent = path.join(ctx.home, 'origin')
    await makeOriginRepo(parent)
    await commitToOrigin(parent, { '.ted/workflow.yaml': 'version: 1\n' })
    await githubReady(['acme/widgets'])
    const files = path.join(ctx.home, 'setup')
    await mkdir(files)
    const at = (name: string) => path.join(files, name)
    await writeFile(
      at('brief.md'),
      '## Goal\n\nSet up Widgets\n\n## Decisions so far\n\nNone.\n\n## Current state\n\nRead.\n\n## Open questions\n\nNone.\n\n## Next step\n\nPropose.\n',
    )
    await writeFile(
      at('design.json'),
      JSON.stringify({
        title: 'Proposed setup for Widgets',
        summary:
          'One repo with an npm test script. I ran each Check on main; one fails there, so I left it off.',
        setup: {
          workflow: [
            { stage: 'intake' },
            { stage: 'clarify', setting: 'Depth: Auto' },
            { stage: 'design', setting: 'Gate on' },
            { stage: 'validate', setting: 'Send back at most 5 times · validate.md for Widgets' },
          ],
          checks: [
            {
              name: 'Unit tests',
              command: 'npm test',
              repo: 'widgets',
              passed: true,
              durationMs: 112000,
            },
            {
              name: 'End-to-end',
              command: 'npm run test:e2e',
              repo: 'widgets',
              passed: false,
              durationMs: 40000,
              reason: 'Fails on main: needs the API running',
            },
          ],
          apps: [
            {
              name: 'Web',
              repo: 'widgets',
              kind: 'web',
              run: 'npm run dev',
              ready: 'ready in 9s at localhost:5174',
              passed: true,
            },
          ],
          files: [
            {
              path: '.ted/notes.md',
              about: 'Factory notes: product, running locally, conventions',
            },
            { path: '.ted/workflow.yaml', about: 'Checks, Apps and Stage settings' },
            { path: '.ted/stages/validate.md', about: 'Start Web, sign in, check the main flow' },
          ],
          defaults: 'Left as TED’s defaults: agents, permissions Auto, 6 working Runs.',
        },
      }),
    )
    const each = [
      { run: ['ted', 'comment', '--tutorial', 'Design is where the Task Lead writes the plan.'] },
      { run: ['ted', 'brief', 'write', '--file', at('brief.md')] },
      { run: ['ted', 'outcome', 'advance', '--design', at('design.json')] },
      { run: ['ted', 'outcome', 'advance'] },
      { endTurn: true },
    ]
    const window = await launchApp()
    const client = await daemonClient()
    await client.createFactory({
      name: 'Widgets',
      key: 'WD',
      repos: [{ source: { remote: 'acme/widgets' }, name: 'widgets' }],
      showTutorial: true,
    })
    const setup = await waitUntil(
      async () => (await client.listTasks()).find((t) => t.setup),
      'the setup Task',
    )
    await client.editTask(setup.id, {
      title: JSON.stringify({ steps: [{ everyMessage: each }, ...each] }),
    })
    await client.startTask(setup.id)
    const clarify = await waitUntil(
      async () => (await client.listInbox()).find((i) => i.request.stage === 'clarify'),
      'the Clarify sign-off',
    )
    await client.answerRequest(clarify.request.id, { action: 'approve' })

    await openAllTasks(window)
    await taskRow(window, 'WD-1').click()
    const thread = window.getByRole('region', { name: 'Task thread' })
    await thread.getByText(/WD-1\s+·\s+Created by TED/).waitFor()
    await thread.getByText('Setup', { exact: true }).waitFor()
    const details = window.getByRole('complementary', { name: 'Task details' })
    await details
      .getByText(
        'The Design and Review Gates are always on for a setup Task. Tasks started before it merges use TED’s defaults.',
      )
      .waitFor()
    await expect(details.locator(':scope > *').first().textContent()).resolves.toContain(
      'always on for a setup Task',
    )
    await thread.getByText('Tutorial', { exact: true }).first().waitFor()

    const card = thread.getByRole('region', { name: 'Design review' })
    await card.waitFor({ timeout: 40_000 })
    await card.getByRole('heading', { name: 'Proposed setup for Widgets' }).waitFor()
    const workflow = card.getByRole('region', { name: 'Workflow' })
    await workflow.getByText('As TED’s default').waitFor()
    await workflow.getByText('Send back at most 5 times · validate.md for Widgets').waitFor()
    const checks = card.getByRole('region', { name: 'Checks · tried on main' })
    expect(await checks.getByRole('listitem').allTextContents()).toEqual([
      '✓Unit testsnpm testwidgets1m 52s',
      '✕End-to-endnpm run test:e2ewidgetsFails on main: needs the API running · left off',
    ])
    const apps = card.getByRole('region', { name: 'Apps · started on main' })
    await apps.getByText('web · ready in 9s at localhost:5174').waitFor()
    await apps.getByText('npm run dev', { exact: true }).waitFor()
    const written = card.getByRole('region', { name: 'Files it will write' })
    expect(await written.getByRole('listitem').count()).toBe(3)
    await card
      .getByText('Left as TED’s defaults: agents, permissions Auto, 6 working Runs.')
      .waitFor()
    await card.getByRole('button', { name: 'Approve' }).waitFor()
    await thread.getByText('TED created this Task to set up this Factory').waitFor()
  }, 90_000)

  test('starting a Task while setup is open shows the setup notice, which never blocks', async () => {
    await makeOriginRepo(path.join(ctx.home, 'origin'))
    await githubReady(['acme/widgets'])
    const window = await launchApp()
    const client = await daemonClient()
    await client.createFactory({
      name: 'Widgets',
      key: 'WD',
      repos: [{ source: { remote: 'acme/widgets' }, name: 'widgets' }],
      showTutorial: false,
    })
    await waitUntil(async () => (await client.listTasks()).find((t) => t.setup), 'the setup Task')
    const task = await client.createTask({ title: 'Offline notes', factory: 'WD' })
    await openAllTasks(window)
    await taskRow(window, task.displayId).click()
    const thread = window.getByRole('region', { name: 'Task thread' })
    await thread.getByRole('button', { name: 'Task actions' }).click()
    await window.getByRole('menuitem', { name: /Start/ }).first().click()
    const notice = window.getByRole('dialog', { name: `Start ${task.displayId}?` })
    await notice.getByText('Setup isn’t finished. This Task will use TED’s defaults.').waitFor()
    await notice.getByRole('button', { name: 'Open setup Task' }).click()
    await thread.getByRole('heading', { name: 'Set up Widgets' }).waitFor()
    expect((await client.listTasks()).find((t) => t.id === task.id)?.stage).toBe('backlog')

    await openAllTasks(window)
    await taskRow(window, task.displayId).click()
    await thread.getByRole('button', { name: 'Task actions' }).click()
    await window.getByRole('menuitem', { name: /Start/ }).first().click()
    await window
      .getByRole('dialog', { name: `Start ${task.displayId}?` })
      .getByRole('button', { name: 'Start anyway' })
      .click()
    await waitUntil(
      async () => (await client.listTasks()).find((t) => t.id === task.id)?.stage !== 'backlog',
      `${task.displayId} to start`,
    )
  }, 60_000)
})

describe('multi-repo Tasks', () => {
  test('the Repos field shows in a multi-repo Factory and changes the Task’s repos', async () => {
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
    await openAllTasks(window)
    await taskRow(window, task.displayId).click()
    const repos = window
      .getByRole('complementary', { name: 'Task details' })
      .getByRole('list', { name: 'Repos' })
    await repos.waitFor()
    expect(await repos.getByLabel('widgets').isChecked()).toBe(true)
    expect(await repos.getByLabel('api').isChecked()).toBe(false)

    await repos.getByLabel('api').click()
    await waitFor(() => repos.getByLabel('api').isChecked())
    const updated = (await client.listTasks()).find((t) => t.id === task.id)
    expect(updated?.chosenRepos).toEqual(['acme/widgets', 'acme/api'])
  })

  test('the Repos field is hidden in a single-repo Factory', async () => {
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    await addFactory(origin, 'NB')
    await ted('task', 'create', '--factory', 'NB', 'Fix the login redirect')
    const window = await launchApp()
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    const details = window.getByRole('complementary', { name: 'Task details' })
    await details.getByText('Clarify depth').waitFor()
    expect(await details.getByText('Repos', { exact: true }).count()).toBe(0)
  })
})
