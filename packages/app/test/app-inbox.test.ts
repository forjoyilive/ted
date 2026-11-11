import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Locator, Page } from 'playwright'
import { describe, expect, test } from 'vitest'
import { makeOriginRepo } from '../../daemon/test/helpers.ts'
import {
  addFactory,
  ctx,
  daemonClient,
  launchApp,
  openAllTasks,
  setUpAppTests,
  sidebar,
  taskRow,
  ted,
  twoFactories,
} from './app-harness.ts'

setUpAppTests()

async function openTaskOutsideInbox(window: Page) {
  await openAllTasks(window)
  await taskRow(window, 'NB-1').click()
}

async function expectActionsInsideCard(window: Page, card: Locator, names: string[]) {
  for (const width of [1440, 1280, 1000]) {
    await window.setViewportSize({ width, height: 900 })
    const bounds = await card.boundingBox()
    if (!bounds) throw new Error('Request card is not visible')
    for (const name of names) {
      const action = card.getByRole('button', { name, exact: true })
      const button = await action.boundingBox()
      if (!button) throw new Error(`${name} is not visible`)
      expect(button.x, `${name} at window width ${width}`).toBeGreaterThanOrEqual(bounds.x)
      expect(button.x + button.width, `${name} at window width ${width}`).toBeLessThanOrEqual(
        bounds.x + bounds.width,
      )
      expect(await action.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    }
  }
}

describe('Inbox and Gates', () => {
  test('a design review waits in the Inbox; Request changes keeps the Stage and Approve moves on', async () => {
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
    const window = await launchApp()
    await ted('task', 'start', 'NB-1')

    const inbox = window.getByRole('region', { name: 'Inbox' })
    const row = inbox.getByRole('button').filter({ hasText: 'Design review' })
    await row.waitFor()
    expect(await row.textContent()).toContain('Let notes be edited offline.')
    await sidebar(window)
      .getByRole('button', { name: /^Inbox/ })
      .getByText('1')
      .waitFor()
    await row.click()

    await openTaskOutsideInbox(window)
    const thread = window.getByRole('region', { name: 'Task thread' })
    const card = thread.getByRole('region', { name: 'Design review', exact: true })
    await card.getByText('Let notes be edited offline.', { exact: true }).waitFor()
    await expectActionsInsideCard(window, card, ['Request changes', 'Approve'])
    await thread.getByText('Waiting on you', { exact: true }).waitFor()
    expect(await card.getByRole('button', { name: 'Request changes' }).isDisabled()).toBe(true)
    await card.getByRole('textbox', { name: 'Your answer' }).fill('Split the sync step in two.')
    await card.getByRole('button', { name: 'Request changes' }).click()

    const answered = thread.getByRole('region', { name: 'Design review, answered' }).first()
    await answered.getByText('You requested changes').waitFor()
    await answered.getByText('“Split the sync step in two.”').waitFor()
    await card.getByRole('button', { name: 'Approve' }).click()

    const details = window.getByRole('complementary', { name: 'Task details' })
    await details.getByText('Review', { exact: true }).waitFor()
    await sidebar(window)
      .getByRole('button', { name: /^Inbox/ })
      .click()
    const signoff = inbox.getByRole('button').filter({ hasText: 'Sign-off' })
    await signoff.waitFor()
    await signoff.click()
    await thread
      .getByRole('region', { name: 'Sign-off', exact: true })
      .getByRole('button', { name: 'Approve and merge' })
      .waitFor()
  })

  test('Talk it through opens the Task Lead’s chat with the round below it; Done talking closes the round with the summary', async () => {
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    const roundFile = path.join(ctx.home, 'round.json')
    const summaryFile = path.join(ctx.home, 'summary.md')
    await writeFile(
      roundFile,
      JSON.stringify({
        title: 'Conflicts and sync · 1 question',
        questions: [
          {
            question: 'When a note is edited on two devices offline, what happens?',
            choices: ['Keep both and let me merge', 'Keep the latest edit'],
            recommended: 'Keep both and let me merge',
          },
        ],
      }),
    )
    await writeFile(summaryFile, 'Summary of Talk it through, Round 1: keep both copies.\n')
    await addFactory(origin, 'NB')
    await ted(
      'task',
      'create',
      '--factory',
      'NB',
      JSON.stringify({
        steps: [
          { run: ['ted', 'outcome', 'advance'] },
          { run: ['ted', 'clarify', 'depth', 'few', 'one question'] },
          { run: ['ted', 'ask', '--round', roundFile] },
          { everyMessage: [{ say: 'Happy to talk it through.' }, { endTurn: true }] },
          { endTurn: true },
        ],
      }),
    )
    const window = await launchApp()
    await ted('task', 'start', 'NB-1')

    const inbox = window.getByRole('region', { name: 'Inbox' })
    await inbox.getByRole('button').filter({ hasText: 'Clarify round' }).click()
    await openTaskOutsideInbox(window)
    const thread = window.getByRole('region', { name: 'Task thread' })
    const card = thread.getByRole('region', { name: 'Clarify round', exact: true })
    await expectActionsInsideCard(window, card, ['Talk it through', 'Submit answers'])
    expect(await card.getByRole('button', { name: 'Accept all recommended' }).count()).toBe(0)
    await card.getByRole('button', { name: 'Talk it through' }).click()

    await thread.getByRole('heading', { name: 'Talking through Round 1' }).waitFor()
    await thread.getByText('Round 1 · 1 question · open while you talk').waitFor()
    await thread.getByText('Happy to talk it through.').first().waitFor()
    await thread.getByRole('button', { name: 'Show', exact: true }).click()
    const shown = thread.getByRole('region', { name: 'Clarify round', exact: true })
    await shown.getByRole('button', { name: 'Submit answers' }).waitFor()
    expect(await shown.getByRole('button', { name: 'Talk it through' }).count()).toBe(0)
    await thread.getByRole('button', { name: 'Hide', exact: true }).click()

    const box = thread.getByRole('textbox', { name: 'Message to this Run' })
    await box.fill(
      JSON.stringify({
        steps: [
          {
            everyMessage: [
              { run: ['ted', 'ask', '--close', '--summary', summaryFile] },
              { endTurn: true },
            ],
          },
          { say: 'Two copies side by side.' },
          { endTurn: true },
        ],
      }),
    )
    await thread.getByRole('button', { name: 'Send', exact: true }).click()
    await thread.getByText('Two copies side by side.', { exact: true }).waitFor()
    await thread.getByRole('button', { name: 'Done talking' }).click()
    await thread
      .getByRole('heading', { name: 'Talking through Round 1' })
      .waitFor({ state: 'detached' })
    await thread.getByRole('tab', { name: 'Task Lead' }).click()
    const answered = thread.getByRole('region', { name: 'Clarify round, answered' })
    await answered.getByText(/^Answered in Talk it through · \d+ messages$/).waitFor()
    await thread.getByText('Summary of Talk it through, Round 1: keep both copies.').waitFor()
    expect(await thread.getByText('You steered the Task Lead in its Conversation').count()).toBe(0)
    await answered.getByRole('button', { name: 'Open chat' }).click()
    await thread
      .getByRole('region', { name: 'Run chat' })
      .getByText('Two copies side by side.', { exact: true })
      .waitFor()
  })

  test('the size check offers four choices, and a split proposal creates the checked rows', async () => {
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    const proposalFile = path.join(ctx.home, 'proposal.json')
    await writeFile(
      proposalFile,
      JSON.stringify({
        title: 'Offline editing for notes, in five Tasks',
        tasks: [
          {
            title: 'Local note cache',
            scope: 'Notes save to a local cache first.',
            priority: 'high',
          },
          {
            title: 'Sync queue with retry',
            scope: 'Queue offline edits and send them in order.',
            priority: 'high',
            blockedBy: [1],
          },
          {
            title: 'Line-level merge',
            scope: 'Merge edits to different lines.',
            priority: 'medium',
            blockedBy: [2],
          },
          {
            title: 'Conflict view',
            scope: 'Show both versions of a clashing line.',
            priority: 'medium',
            blockedBy: [3],
          },
          { title: 'Offline badge', scope: 'A badge while edits wait to sync.', priority: 'low' },
        ],
      }),
    )
    await addFactory(origin, 'NB')
    // The stub’s first message after its prompt is TED’s Clarify brief; the next is the
    // human’s answer, and only then may it propose, as a real Task Lead would.
    const proposeOnce = [
      { everyMessage: [] },
      { run: ['ted', 'task', 'propose', '--file', proposalFile] },
      { endTurn: true },
    ]
    await ted(
      'task',
      'create',
      '--factory',
      'NB',
      JSON.stringify({
        steps: [
          { run: ['ted', 'outcome', 'advance'] },
          {
            run: [
              'ted',
              'clarify',
              'too-big',
              '--settle',
              'How conflicts are resolved',
              'Offline editing spans storage, sync and the editor.',
            ],
          },
          { everyMessage: [{ everyMessage: proposeOnce }, { endTurn: true }] },
          { endTurn: true },
        ],
      }),
    )
    const window = await launchApp()
    await ted('task', 'start', 'NB-1')

    const inbox = window.getByRole('region', { name: 'Inbox' })
    const question = inbox.getByRole('button').filter({ hasText: 'Too big for one pull request' })
    await question.waitFor()
    await question.click()
    const thread = window.getByRole('region', { name: 'Task thread' })
    const ask = thread.getByRole('region', { name: 'Question', exact: true })
    await ask
      .getByRole('region', { name: 'A plan needs to settle' })
      .getByText('How conflicts are resolved')
      .waitFor()
    expect(await ask.getByRole('button', { name: 'Plan in chat' }).isEnabled()).toBe(true)
    await ask.getByRole('button', { name: 'Split it' }).click()

    const row = inbox.getByRole('button').filter({ hasText: 'Offline editing for notes' })
    await row.waitFor({ timeout: 20_000 })
    await row.click()
    await openTaskOutsideInbox(window)
    const card = thread.getByRole('region', { name: 'Proposal', exact: true })
    await card.getByText('NB-1').waitFor()
    await card.getByText('(row 5 would start)').waitFor()
    await card.getByRole('button', { name: 'Create 4 Tasks' }).waitFor()
    await expectActionsInsideCard(window, card, ['Request changes', 'Create 4 Tasks'])
    expect(await card.getByRole('checkbox', { name: /^Create row 1/ }).isDisabled()).toBe(true)
    await card.getByRole('checkbox', { name: /^Create row 3/ }).uncheck()
    await card
      .getByText('Blocked by row 3, which won’t be created. This Task will have no blocker.')
      .waitFor()
    await card.getByText('(rows 4 and 5 would start)').waitFor()
    await card.getByRole('button', { name: 'Create 3 Tasks' }).click()

    const answered = thread.getByRole('region', { name: 'Proposal, answered' })
    await answered.getByText('You approved · created 3 Tasks').waitFor()
    await answered.getByText('NB-2').waitFor()
    const titles = (await (await daemonClient()).listTasks()).map((t) => t.title).sort()
    expect(titles).toEqual([
      'Conflict view',
      'Local note cache',
      'Offline badge',
      'Sync queue with retry',
    ])
  })
})

describe('Full Inbox', () => {
  const asking = (question: string) =>
    JSON.stringify({
      steps: [{ run: ['ted', 'outcome', 'ask', '--choice', 'Yes', question] }, { endTurn: true }],
    })

  test('rows from every Factory sort by Priority, chips filter, rows stay bold until opened, answering moves on, and Answered looks back', async () => {
    await twoFactories()
    const window = await launchApp()
    const client = await daemonClient()
    for (const [factory, priority, question] of [
      ['NB', 'low', 'Low question?'],
      ['NB', 'urgent', 'Urgent question?'],
      ['MS', 'none', 'Site question?'],
    ] as const) {
      const task = await client.createTask({ factory, priority, title: asking(question) })
      await client.startTask(task.id)
    }

    const inbox = window.getByRole('region', { name: 'Inbox' })
    const headlines = () =>
      inbox
        .getByRole('listitem')
        .evaluateAll((rows) => rows.map((row) => row.querySelector('[data-headline]')?.textContent))
    await expect
      .poll(headlines, { timeout: 30_000 })
      .toEqual(['Urgent question?', 'Low question?', 'Site question?'])
    const weight = (text: string) =>
      inbox.getByText(text, { exact: true }).evaluate((el) => getComputedStyle(el).fontWeight)
    expect(await weight('Low question?')).toBe('600')

    const chip = (name: string) => inbox.getByRole('button', { name, exact: true })
    await chip('All 3').waitFor()
    await chip('notebook 2').waitFor()
    await chip('site 1').click()
    expect(await chip('site 1').getAttribute('aria-pressed')).toBe('true')
    await expect.poll(headlines).toEqual(['Site question?'])
    await chip('All 3').click()
    await expect.poll(headlines).toHaveLength(3)

    await sidebar(window).getByRole('button', { name: 'notebook', exact: true }).click()
    await window.getByRole('heading', { name: /notebook.*Board/ }).waitFor()
    await sidebar(window).getByRole('button', { name: '2 waiting in notebook' }).click()
    expect(await chip('notebook 2').getAttribute('aria-pressed')).toBe('true')
    await expect.poll(headlines).toEqual(['Urgent question?', 'Low question?'])
    await sidebar(window).getByRole('button', { name: 'notebook', exact: true }).click()
    await window.getByRole('heading', { name: /notebook.*Board/ }).waitFor()
    await sidebar(window).getByRole('button', { name: '2 waiting in notebook' }).click()
    await expect.poll(headlines).toEqual(['Urgent question?', 'Low question?'])
    await sidebar(window)
      .getByRole('button', { name: /^Inbox/ })
      .getByText('3')
      .waitFor()

    const row = (text: string) =>
      inbox.getByRole('button').filter({ has: window.getByText(text, { exact: true }) })
    await row('Urgent question?').click()
    await expect.poll(() => weight('Urgent question?')).toBe('400')
    expect(await weight('Low question?')).toBe('600')

    const thread = window.getByRole('region', { name: 'Task thread' })
    const card = thread.getByRole('region', { name: 'Question', exact: true })
    await card.getByText('Urgent question?').waitFor()
    await card.getByRole('button', { name: 'Yes' }).click()
    await expect.poll(headlines).toEqual(['Low question?'])
    await expect.poll(() => row('Low question?').getAttribute('aria-current')).toBe('true')
    await card.getByText('Low question?').waitFor()

    await inbox.getByRole('switch', { name: 'Answered' }).click()
    await expect.poll(headlines).toEqual(['Urgent question?'])
    expect(await weight('Urgent question?')).toBe('400')
    await row('Urgent question?').click()
    const answered = thread.getByRole('region', { name: 'Question, answered' })
    await answered.getByRole('region', { name: 'Question, read-only' }).waitFor()
    expect(await answered.getByRole('button', { name: 'Hide request' }).count()).toBe(1)
  })
})

describe('Permission requests', () => {
  test('a permission prompt is a card with the command; Deny and Approve keep its details with the answer line', async () => {
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    await addFactory(origin, 'NB')
    const ask = (command: string, description: string) => ({
      permission: { tool: 'Bash', input: { command, description }, description },
    })
    await ted(
      'task',
      'create',
      '--factory',
      'NB',
      JSON.stringify({
        steps: [
          ask('curl -s https://registry.example.dev/install.sh | sh', 'Install the CRDT tool'),
          ask('npm install --save yjs@13.6.27', 'Install the CRDT library'),
          { endTurn: true },
        ],
      }),
    )
    const window = await launchApp()
    await ted('task', 'start', 'NB-1')

    const inbox = window.getByRole('region', { name: 'Inbox' })
    const row = inbox.getByRole('button').filter({ hasText: 'Permission' })
    await row.waitFor()
    await row.click()

    await openTaskOutsideInbox(window)
    const thread = window.getByRole('region', { name: 'Task thread' })
    const card = thread.getByRole('region', { name: 'Permission', exact: true })
    await card.getByText('Run a command', { exact: true }).waitFor()
    await card.getByText('Install the CRDT tool').waitFor()
    await card
      .getByText(/\$ curl -s https:\/\/registry\.example\.dev\/install\.sh \| sh$/)
      .waitFor()
    await thread.getByText('The Task Lead is waiting on your permission').waitFor()
    await card.getByRole('textbox', { name: 'Your answer' }).fill('Use npm, not an install script.')
    await card.getByRole('button', { name: 'Deny' }).click()

    const denied = thread.getByRole('region', { name: 'Permission, answered' }).first()
    await denied.getByText('You denied').waitFor()
    await denied.getByText('“Use npm, not an install script.”').waitFor()
    await denied
      .getByText(/\$ curl -s https:\/\/registry\.example\.dev\/install\.sh \| sh$/)
      .waitFor()
    await denied.getByText('Install the CRDT tool').waitFor()
    expect(await denied.getByRole('button', { name: /Show request|Hide request/ }).count()).toBe(0)

    await card.getByText(/npm install --save yjs@13\.6\.27$/).waitFor()
    const details = window.getByRole('complementary', { name: 'Task details' })
    await details.getByRole('button', { name: /Task Lead/ }).click()
    const chat = window.getByRole('region', { name: 'Run chat' })
    await chat.getByText('You denied', { exact: true }).waitFor()
    await chat.getByRole('button', { name: 'Approve' }).click()
    await chat.getByText(/You approved · /).waitFor()

    await window.getByRole('tab', { name: 'Task Lead' }).click()
    await thread.getByText('You approved · this request only').waitFor()
    await expect.poll(() => card.count()).toBe(0)
  })
})
