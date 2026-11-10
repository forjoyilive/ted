import path from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { expect, test } from 'vitest'
import { makeOriginRepo, waitUntil } from '../../daemon/test/helpers.ts'
import {
  addFactory,
  ctx,
  daemonClient,
  launchApp,
  onePixelPng,
  setUpAppTests,
  ted,
} from './app-harness.ts'

setUpAppTests()

async function holdComments(app: ElectronApplication, taskId: string): Promise<void> {
  await app.evaluate(({ ipcMain }, taskId) => {
    const original = Reflect.get(ipcMain, '_invokeHandlers').get('ted:request')
    let holding = true
    Reflect.set(globalThis, 'commentsHeld', false)
    Reflect.set(globalThis, 'allowComments', () => {
      holding = false
    })
    const held = new Promise<void>((resolve) => {
      Reflect.set(globalThis, 'releaseComments', () => {
        ipcMain.removeHandler('ted:request')
        ipcMain.handle('ted:request', original)
        resolve()
      })
    })
    ipcMain.removeHandler('ted:request')
    ipcMain.handle('ted:request', async (event, name, ...args) => {
      const result = await original(event, name, ...args)
      if (name === 'listComments' && args[0] === taskId && holding) {
        Reflect.set(globalThis, 'commentsHeld', true)
        await held
      }
      return result
    })
  }, taskId)
}

async function flushResponses(page: Page): Promise<void> {
  // A round trip and two frames let released IPC responses commit to the renderer.
  await page.evaluate(async () => {
    await window.ted.request('listTasks')
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
  })
}

test('a late Task load cannot put its text and screenshots into another Task’s thread', async () => {
  const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
  await addFactory(origin, 'NB')
  for (const question of ['First Task question?', 'Second Task question?']) {
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
  const app = ctx.app
  if (!app) throw new Error('No app')
  const client = await daemonClient()
  const first = (await client.listTasks()).find((task) => task.displayId === 'NB-1')
  if (!first) throw new Error('No first Task')
  const attachment = await client.uploadAttachment(
    { name: 'first-task.png', mediaType: 'image/png' },
    new Uint8Array(Buffer.from(onePixelPng, 'base64')),
  )
  await client.postComment(first.id, { body: 'Only the first Task', attachments: [attachment] })
  await client.postComment('NB-2', 'Only the second Task')
  await ted('task', 'start', 'NB-1')
  await ted('task', 'start', 'NB-2')
  const inbox = window.getByRole('region', { name: 'Inbox', exact: true })
  const row = (question: string) =>
    inbox.getByRole('button').filter({ has: window.getByText(question, { exact: true }) })
  await row('Second Task question?').waitFor()
  await holdComments(app, first.id)
  await row('First Task question?').click()
  await waitUntil(
    () => app.evaluate(() => Reflect.get(globalThis, 'commentsHeld')),
    'held Comments',
  )
  await row('Second Task question?').click()
  const thread = window.getByRole('region', { name: 'Task thread' })
  await thread.getByText('Only the second Task', { exact: true }).waitFor()
  await app.evaluate(() => Reflect.get(globalThis, 'releaseComments')())
  await flushResponses(window)
  expect(await thread.getByText('Only the first Task', { exact: true }).count()).toBe(0)
  expect(await thread.getByRole('img', { name: 'first-task.png' }).count()).toBe(0)
  expect(await thread.getByText('Only the second Task', { exact: true }).count()).toBe(1)
  await client.postComment('NB-2', 'Second Task live update')
  await thread.getByText('Second Task live update', { exact: true }).waitFor()
  expect(await thread.getByText('Only the first Task', { exact: true }).count()).toBe(0)
  expect(
    (await client.listComments(first.id)).some((comment) => comment.body === 'Only the first Task'),
  ).toBe(true)
  expect(
    (await client.listComments('NB-2')).some((comment) => comment.body === 'Only the first Task'),
  ).toBe(false)
  const second = (await client.listTasks()).find((task) => task.displayId === 'NB-2')
  if (!second) throw new Error('No second Task')
  await holdComments(app, second.id)
  const reconnect = () =>
    app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]?.webContents
      contents?.send('ted:event', { type: 'connection', connection: { state: 'reconnecting' } })
      contents?.send('ted:event', { type: 'connection', connection: { state: 'connected' } })
    })
  await reconnect()
  await waitUntil(() => app.evaluate(() => Reflect.get(globalThis, 'commentsHeld')), 'held reload')
  await app.evaluate(() => Reflect.get(globalThis, 'allowComments')())
  await reconnect()
  await flushResponses(window)
  await client.postComment('NB-2', 'Live update after reconnect')
  await thread.getByText('Live update after reconnect', { exact: true }).waitFor()
  await app.evaluate(() => Reflect.get(globalThis, 'releaseComments')())
  await flushResponses(window)
  expect(await thread.getByText('Live update after reconnect', { exact: true }).count()).toBe(1)
  expect(await thread.getByText('Only the first Task', { exact: true }).count()).toBe(0)
  if (process.env.TED_ISOLATION_SCREENSHOT) {
    await window.screenshot({ path: process.env.TED_ISOLATION_SCREENSHOT })
  }
})
