import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from 'vitest'
import { makeOriginRepo } from '../../daemon/test/helpers.ts'
import {
  addFactory,
  ctx,
  daemonClient,
  launchApp,
  onePixelPng,
  openAllTasks,
  setUpAppTests,
  taskRow,
  ted,
} from './app-harness.ts'

setUpAppTests()

test('chat history uses the local profile and follows picture changes', async () => {
  const config = path.join(ctx.home, 'gitconfig')
  await writeFile(config, '[user]\nname = Alex Example\nemail = alex@example.com\n')
  ctx.extraEnv.GIT_CONFIG_GLOBAL = config
  const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
  await addFactory(origin, 'NB')
  await ted(
    'task',
    'create',
    '--factory',
    'NB',
    '--start',
    JSON.stringify({
      steps: [
        { run: ['ted', 'comment', 'Agent note'] },
        { everyMessage: [{ say: 'Ready.' }, { endTurn: true }] },
        { endTurn: true },
      ],
    }),
  )
  const client = await daemonClient()
  await expect.poll(async () => (await client.listTasks())[0]?.runs[0]?.state).toBe('idle')
  await client.postComment('NB-1', 'did CI finish?')
  const window = await launchApp()
  await openAllTasks(window)
  await taskRow(window, 'NB-1').click()
  const thread = window.getByRole('region', { name: 'Task thread' })
  const comment = thread.getByRole('listitem').filter({ hasText: 'did CI finish?' })
  await comment.getByText('Alex Example', { exact: true }).waitFor()
  await comment.getByRole('img', { name: 'Alex Example' }).waitFor()
  expect(await comment.getByRole('img').textContent()).toBe('AE')
  await thread
    .getByRole('listitem')
    .filter({ hasText: 'Agent note' })
    .getByText('Task Lead', { exact: true })
    .waitFor()

  await client.updateSettings({ profilePicture: `data:image/png;base64,${onePixelPng}` })
  await comment.locator('img').waitFor()
  await expect
    .poll(() => comment.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(1)
  await client.updateSettings({ profilePicture: 'data:image/png;base64,broken' })
  await comment.locator('img').waitFor({ state: 'detached' })
  expect(await comment.getByRole('img').textContent()).toBe('AE')
  await client.updateSettings({ profilePicture: null })
  await expect.poll(() => comment.getByRole('img').textContent()).toBe('AE')

  if (process.env.TED_PROFILE_SCREENSHOTS) {
    await mkdir(process.env.TED_PROFILE_SCREENSHOTS, { recursive: true })
    await thread.screenshot({ path: path.join(process.env.TED_PROFILE_SCREENSHOTS, 'thread.png') })
  }

  await window
    .getByRole('complementary', { name: 'Task details' })
    .getByRole('button', { name: /Task Lead/ })
    .click()
  const chat = window.getByRole('region', { name: 'Run chat' })
  await chat.getByRole('textbox', { name: 'Message the Task Lead' }).fill('Check the result.')
  await chat.getByRole('button', { name: 'Send', exact: true }).click()
  await chat.getByText('Alex Example', { exact: true }).waitFor()
  await chat.getByText('Check the result.', { exact: true }).waitFor()
  if (process.env.TED_PROFILE_SCREENSHOTS) {
    await chat.screenshot({ path: path.join(process.env.TED_PROFILE_SCREENSHOTS, 'run-chat.png') })
  }
})
