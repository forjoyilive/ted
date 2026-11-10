import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from 'vitest'
import { commitToOrigin, makeOriginRepo } from '../../daemon/test/helpers.ts'
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

test('chat timestamps keep advancing while idle and after a tool finishes', async () => {
  const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
  await commitToOrigin(path.join(ctx.home, 'origin'), {
    '.ted/workflow.yaml': 'version: 1\norder: [intake, work, merge]\n',
  })
  await startDaemonAsApp()
  await addFactory(origin, 'NB')
  await ted(
    'task',
    'create',
    '--factory',
    'NB',
    JSON.stringify({
      steps: [
        {
          everyMessage: [
            {
              emit: {
                type: 'assistant',
                message: {
                  role: 'assistant',
                  content: [
                    { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo ready' } },
                  ],
                },
              },
            },
            { waitFor: path.join(ctx.home, 'tool-done') },
            {
              emit: {
                type: 'user',
                message: {
                  role: 'user',
                  content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ready' }],
                },
              },
            },
            { endTurn: true },
          ],
        },
        { say: 'Ready for the next step.' },
        { endTurn: true },
      ],
    }),
  )
  await ted('task', 'start', 'NB-1')
  const client = await daemonClient()
  await expect.poll(async () => (await client.listTasks())[0]?.runs[0]?.state).toBe('idle')

  const window = await launchApp()
  await window.clock.install()
  await window.clock.pauseAt(new Date())
  await openAllTasks(window)
  await taskRow(window, 'NB-1').click()
  await window
    .getByRole('complementary', { name: 'Task details' })
    .getByRole('button', { name: /Task Lead/ })
    .click()
  const chat = window.getByRole('region', { name: 'Run chat' })
  const message = chat.getByText('Ready for the next step.', { exact: true }).locator('..')
  await message.getByText('just now', { exact: true }).waitFor()
  await window.clock.runFor(60_000)
  await message.getByText('1m ago', { exact: true }).waitFor({ timeout: 2000 })
  await window.clock.runFor(120_000)
  await message.getByText('3m ago', { exact: true }).waitFor({ timeout: 2000 })

  await chat.getByRole('textbox', { name: 'Message to this Run' }).fill('Run the tool.')
  await chat.getByRole('button', { name: 'Send', exact: true }).click()
  const tool = chat.getByRole('button', { name: /^Bash/ })
  await tool.getByText(/running/).waitFor()
  await window.clock.runFor(1000)
  const elapsed = await tool.textContent()
  await window.clock.runFor(1000)
  expect(await tool.textContent()).not.toBe(elapsed)
  await writeFile(path.join(ctx.home, 'tool-done'), '')
  await tool.getByText(/running/).waitFor({ state: 'detached' })
  await window.clock.runFor(60_000)
  await message.getByText('4m ago', { exact: true }).waitFor({ timeout: 2000 })
})
