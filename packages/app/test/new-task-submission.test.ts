import path from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { readStubKeyring, stubKeyringFile } from '../../daemon/test/fixtures/stub-keyring.ts'
import { type StubLinear, startStubLinear } from '../../daemon/test/fixtures/stub-linear.ts'
import { makeOriginRepo, waitUntil } from '../../daemon/test/helpers.ts'
import { addFactory, ctx, daemonClient, launchApp, setUpAppTests, sidebar } from './app-harness.ts'

const key = 'lin_api_abcdefghijklmnopqrstuvwxyz0123456789ABCD'
const issueUrl = 'https://linear.app/kriyadesign/issue/NOTE-212/search-ignores-accents'
let linear: StubLinear
let releaseViewer: () => void

setUpAppTests()

type HeldCreation = typeof globalThis & { creationHeld: boolean; releaseCreation: () => void }

beforeEach(async () => {
  const viewerReady = new Promise<void>((resolve) => {
    releaseViewer = resolve
  })
  linear = await startStubLinear({
    [key]: {
      name: 'Nabha',
      workspace: { name: 'Kriya Design', urlKey: 'kriyadesign' },
      issues: [{ identifier: 'NOTE-212', title: 'Search ignores accents', priority: 2 }],
      viewerReady,
    },
  })
  ctx.extraEnv.TED_LINEAR_API = linear.url
})

afterEach(async () => {
  releaseViewer()
  await linear.close()
})

test.each(['Create', 'Create more', 'failed creation'])(
  'a pending key save respects the draft lifecycle during %s',
  async (action) => {
    await addFactory(await makeOriginRepo(path.join(ctx.home, 'origin')), 'NB')
    const window = await launchApp()
    const app = ctx.app
    if (!app) throw new Error('No app')
    const daemon = await daemonClient()
    const [factory] = await daemon.listFactories()
    if (!factory) throw new Error('No Factory')
    await sidebar(window).getByRole('button', { name: 'widgets' }).click()
    await window.keyboard.press('Meta+N')
    const form = window.getByRole('dialog', { name: 'New Task' })
    await waitUntil(() => form.getByLabel('Description').isEnabled(), 'the loaded draft')
    await form.getByLabel('Description').fill(issueUrl)
    await form.getByLabel('Linear API key').fill(key)
    await form.getByLabel('Start now').uncheck()
    await form.getByRole('button', { name: 'Save', exact: true }).click()
    await waitUntil(
      () => linear.requests.some((request) => request.query.includes('TedViewer')),
      'the pending key save',
    )
    await app.evaluate(({ ipcMain }, fail) => {
      const handlers = (
        ipcMain as typeof ipcMain & {
          _invokeHandlers: { get(channel: string): Parameters<typeof ipcMain.handle>[1] }
        }
      )._invokeHandlers
      const original = handlers.get('ted:request')
      const held = new Promise<void>((resolve) => {
        Reflect.set(globalThis, 'releaseCreation', resolve)
      })
      ipcMain.removeHandler('ted:request')
      ipcMain.handle('ted:request', async (event, name, ...args) => {
        if (name === 'createTask') {
          Reflect.set(globalThis, 'creationHeld', true)
          await held
          ipcMain.removeHandler('ted:request')
          ipcMain.handle('ted:request', original)
          if (fail) throw new Error('Simulated creation failure')
        }
        return original(event, name, ...args)
      })
    }, action === 'failed creation')
    try {
      await form
        .getByRole('button', { name: action === 'Create more' ? action : 'Create', exact: true })
        .click()
      await waitUntil(
        () => app.evaluate(() => (globalThis as HeldCreation).creationHeld),
        'the held Task creation',
      )
      const submitted = (await daemon.taskDraft(factory.id)).draft
      releaseViewer()
      await waitUntil(
        async () => (await readStubKeyring(stubKeyringFile(ctx.home))).secret === key,
        'the completed key save',
      )
      await window.evaluate(async () => {
        await globalThis.window.ted.request('getLinear')
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
      })
      expect((await daemon.taskDraft(factory.id)).draft?.revision).toBe(submitted?.revision)
      await app.evaluate(() => (globalThis as HeldCreation).releaseCreation())
      if (action === 'failed creation') {
        await form.getByText(/Simulated creation failure/).waitFor()
        await form.getByText('NOTE-212 · Search ignores accents').waitFor()
        expect(await form.getByLabel('Description').inputValue()).toBe(issueUrl)
        await form.getByRole('button', { name: 'Close', exact: true }).click()
        await form.waitFor({ state: 'detached' })
        expect((await daemon.taskDraft(factory.id)).draft?.description).toBe(issueUrl)
        expect(await daemon.listTasks()).toHaveLength(0)
      } else {
        if (action === 'Create') {
          await form.waitFor({ state: 'detached' })
          expect((await daemon.taskDraft(factory.id)).draft).toBeNull()
          await window.keyboard.press('Meta+N')
        } else {
          await expect.poll(() => form.getByLabel('Description').inputValue()).toBe('')
          expect((await daemon.taskDraft(factory.id)).draft).toBeNull()
        }
        await expect.poll(() => form.getByLabel('Description').inputValue()).toBe('')
        expect(await daemon.listTasks()).toHaveLength(1)
      }
    } finally {
      releaseViewer()
      await app.evaluate(() => (globalThis as HeldCreation).releaseCreation())
    }
  },
)
