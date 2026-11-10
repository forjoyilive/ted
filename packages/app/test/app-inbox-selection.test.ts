import path from 'node:path'
import { expect, test } from 'vitest'
import { makeOriginRepo } from '../../daemon/test/helpers.ts'
import { addFactory, ctx, daemonClient, launchApp, setUpAppTests, ted } from './app-harness.ts'

setUpAppTests()

test('live resolution selects another waiting item and clears the panes when the last item leaves', async () => {
  const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
  await addFactory(origin, 'NB')
  for (const question of ['First question?', 'Second question?']) {
    await ted(
      'task',
      'create',
      '--factory',
      'NB',
      JSON.stringify({
        steps: [{ run: ['ted', 'outcome', 'ask', '--choice', 'Yes', question] }, { endTurn: true }],
      }),
    )
  }
  const window = await launchApp()
  await ted('task', 'start', 'NB-1')
  await ted('task', 'start', 'NB-2')
  const inbox = window.getByRole('region', { name: 'Inbox', exact: true })
  const row = (question: string) =>
    inbox.getByRole('button').filter({ has: window.getByText(question, { exact: true }) })
  await row('Second question?').waitFor()
  await row('First question?').click()
  const thread = window.getByRole('region', { name: 'Task thread' })
  await thread
    .getByRole('region', { name: 'Question', exact: true })
    .getByText('First question?')
    .waitFor()

  const client = await daemonClient()
  const first = (await client.listInbox()).find((item) => item.request.body === 'First question?')
  if (!first) throw new Error('First question is missing')
  await client.answerRequest(first.request.id, { action: 'answer', choice: 'Yes' })
  await expect.poll(() => row('Second question?').getAttribute('aria-current')).toBe('true')
  await thread
    .getByRole('region', { name: 'Question', exact: true })
    .getByText('Second question?')
    .waitFor()

  await thread
    .getByRole('region', { name: 'Question', exact: true })
    .getByRole('button', { name: 'Yes', exact: true })
    .click()
  await inbox.getByText('Nothing waiting on you').waitFor()
  await expect
    .poll(() => window.getByRole('region', { name: 'Nothing open', exact: true }).count(), {
      timeout: 3000,
    })
    .toBe(1)
  expect(await thread.count()).toBe(0)
  expect(await window.getByRole('complementary', { name: 'Task details' }).count()).toBe(0)

  await inbox.getByRole('switch', { name: 'Answered' }).click()
  await row('Second question?').click()
  await thread.getByRole('region', { name: 'Question, answered' }).waitFor()
})
