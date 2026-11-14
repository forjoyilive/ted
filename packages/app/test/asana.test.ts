import { chmod, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { startStubAsana, unusedPort } from '../../daemon/test/fixtures/stub-asana.ts'
import { makeOriginRepo } from '../../daemon/test/helpers.ts'
import {
  addFactory,
  ctx,
  daemonClient,
  launchApp,
  openAllTasks,
  openSettings,
  setUpAppTests,
  ted,
} from './app-harness.ts'

setUpAppTests()
let stub: Awaited<ReturnType<typeof startStubAsana>>
let configurationFile: string
beforeEach(async () => {
  stub = await startStubAsana()
  ctx.extraEnv = { TED_ASANA_API: stub.url, TED_ASANA_CALLBACK_PORT: String(await unusedPort()) }
  configurationFile = path.join(ctx.home, 'private-app.json')
  await writeFile(
    configurationFile,
    JSON.stringify({ client_id: '123', client_secret: 'app-client-secret-opaque' }),
    { mode: 0o600 },
  )
})
afterEach(async () => {
  await stub.close()
})

async function settings() {
  const window = await launchApp()
  await ctx.app?.evaluate(({ dialog, shell }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    Object.assign(globalThis, { asanaOpened: [] })
    shell.openExternal = async (url: string) => {
      const state = globalThis as unknown as { asanaOpened: string[] }
      state.asanaOpened.push(url)
    }
  }, configurationFile)
  await openSettings(window)
  await window
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Integrations', exact: true })
    .click()
  return { window, group: window.getByRole('group', { name: 'Asana', exact: true }) }
}
async function opened() {
  return await ctx.app?.evaluate(() =>
    (globalThis as unknown as { asanaOpened: string[] }).asanaOpened.at(-1),
  )
}

test('private configuration stays in main; browser authorization, identity, test, disconnect and removal cross IPC', async () => {
  const { window, group } = await settings()
  const rejected = await window.evaluate(async () => {
    const denied: string[] = []
    for (const name of ['configureAsana', 'connectAsana']) {
      try {
        await globalThis.window.ted.request(name)
      } catch {
        denied.push(name)
      }
    }
    return denied
  })
  expect(rejected).toEqual(['configureAsana', 'connectAsana'])
  await group.getByRole('button', { name: 'Import app configuration', exact: true }).click()
  await expect.poll(() => group.textContent()).toContain('App configured')
  await group.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect.poll(opened).toContain('https://app.asana.com/-/oauth_authorize')
  const url = await opened()
  if (!url) throw new Error('No authorization URL')
  expect(url).not.toContain('app-client-secret-opaque')
  await fetch(stub.callback(url))
  await expect.poll(() => group.textContent()).toContain('Connected as Avery')
  await group.getByRole('button', { name: 'Test connection' }).click()
  await expect
    .poll(() => stub.requests.filter((r) => r.path === '/api/1.0/users/me').length)
    .toBeGreaterThan(1)
  await addFactory(await makeOriginRepo(path.join(ctx.home, 'origin')), 'NB')
  stub.setTasks([
    { gid: '501', name: 'Checkout redesign', notes: 'Ship it', subtasks: ['502', '503', '504'] },
    { gid: '502', name: 'Payment form', assignee: { gid: '100', name: 'Avery' } },
    { gid: '503', name: 'Order summary', assignee: { gid: '200', name: 'Sam' } },
    { gid: '504', name: 'Pick provider', completed: true },
  ])
  await window
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: '← Back' })
    .click()
  await window.keyboard.press('Meta+N')
  const newTask = window.getByRole('dialog', { name: 'New Task' })
  await newTask.getByLabel('Description').fill('https://app.asana.com/0/9/501/f')
  const preview = newTask.getByRole('region', { name: 'Asana import' })
  await expect
    .poll(() => preview.textContent())
    .toContain('3 Tasks: 1 assigned to you, 1 to others, 1 unassigned')
  expect(await preview.getByRole('listitem').count()).toBe(4)
  expect(await preview.textContent()).toContain('Task Sync is on for these Tasks')
  await newTask.getByLabel('Start now').uncheck()
  await newTask.getByRole('button', { name: 'Create 3 Tasks' }).click()
  await newTask.waitFor({ state: 'detached' })
  const imported = (await (await daemonClient()).listTasks()).filter((t) => !t.setup)
  const root = imported.find((t) => t.title === 'Checkout redesign')
  expect(imported.map((t) => t.title).sort()).toEqual([
    'Checkout redesign',
    'Order summary',
    'Payment form',
  ])
  expect(imported.filter((t) => t.parentId === root?.id)).toHaveLength(2)
  expect(root?.source?.asana).toMatchObject({ gid: '501', completed: false })
  expect(root?.asanaSync).toMatchObject({ state: 'waiting-merge' })
  stub.setTasks([{ gid: '505', name: 'Tax line' }])
  await ted('task', 'create', '--factory', 'NB', '--source', 'https://app.asana.com/0/0/505')
  await openAllTasks(window)
  const fromCli = window.locator('tr[data-task="NB-5"]')
  await fromCli.click()
  await expect.poll(() => window.locator('[data-task-sync]').textContent()).toContain('Not syncing')
  await fromCli.click({ button: 'right' })
  await window.getByRole('menuitem', { name: 'Sync with Asana', exact: true }).click()
  await expect
    .poll(() => window.locator('[data-task-sync]').getAttribute('data-task-sync'))
    .toBe('waiting-merge')
  const stateOf = async (id: string | undefined) =>
    (await (await daemonClient()).listTasks()).find((t) => t.id === id)?.asanaSync?.state
  await openSettings(window)
  await window
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Integrations', exact: true })
    .click()
  const taskSync = group.getByRole('switch', { name: 'Task Sync' })
  expect(await taskSync.getAttribute('aria-checked')).toBe('true')
  await taskSync.click()
  await expect.poll(() => stateOf(root?.id)).toBe('off')
  await taskSync.click()
  await expect.poll(() => stateOf(root?.id)).toBe('waiting-merge')
  const renderer = await window.evaluate(() => ({
    text: document.body.innerHTML,
    local: { ...localStorage },
    session: { ...sessionStorage },
  }))
  for (const secret of [
    'app-client-secret-opaque',
    'access-secret-opaque',
    'refresh-secret-opaque',
  ])
    expect(JSON.stringify(renderer)).not.toContain(secret)
  await group.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await expect.poll(() => group.textContent()).toContain('App configured')
  await expect.poll(() => stateOf(root?.id)).toBe('disconnected')
  expect(
    await readFile(path.join(ctx.home, 'stub-keyring.json.asana-oauth'), 'utf8'),
  ).not.toContain('refresh-secret-opaque')
  await group.getByRole('button', { name: 'Remove configuration' }).click()
  await window.getByRole('dialog').getByRole('button', { name: 'Continue', exact: true }).click()
  await expect.poll(() => group.textContent()).toContain('Import your app configuration')
})

test('reject public configuration files; cancel closes the callback and leaves no connected account', async () => {
  const { group } = await settings()
  await chmod(configurationFile, 0o644)
  await group.getByRole('button', { name: 'Import app configuration', exact: true }).click()
  await expect.poll(() => group.textContent()).toContain('permissions 0600')
  await chmod(configurationFile, 0o600)
  await group.getByRole('button', { name: 'Import app configuration', exact: true }).click()
  await expect.poll(() => group.textContent()).toContain('App configured')
  await group.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect.poll(opened).toContain('https://app.asana.com/-/oauth_authorize')
  const url = await opened()
  if (!url) throw new Error('No authorization URL')
  await group.getByRole('button', { name: 'Cancel authorization' }).click()
  await expect.poll(() => group.textContent()).toContain('Authorization canceled')
  await expect(fetch(stub.callback(url))).rejects.toThrow()
})
