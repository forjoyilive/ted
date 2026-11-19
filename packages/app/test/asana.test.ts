import { readFile, writeFile } from 'node:fs/promises'
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
  sidebar,
  ted,
} from './app-harness.ts'

setUpAppTests()
let stub: Awaited<ReturnType<typeof startStubAsana>>
beforeEach(async () => {
  stub = await startStubAsana()
  ctx.extraEnv = { TED_ASANA_API: stub.url, TED_ASANA_CALLBACK_PORT: String(await unusedPort()) }
})
afterEach(async () => {
  await stub.close()
})

async function settings() {
  const window = await launchApp()
  await ctx.app?.evaluate(({ clipboard, shell }) => {
    Object.assign(globalThis, { asanaOpened: [], asanaCopied: [] })
    const state = globalThis as typeof globalThis & { asanaOpened: string[]; asanaCopied: string[] }
    shell.openExternal = async (url: string) => {
      state.asanaOpened.push(url)
    }
    clipboard.writeText = async (text: string) => {
      state.asanaCopied.push(text)
    }
  })
  await openSettings(window)
  await window
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Integrations', exact: true })
    .click()
  return { window, group: window.getByRole('group', { name: 'Asana', exact: true }) }
}
async function saveApp(group: Awaited<ReturnType<typeof settings>>['group'], clientId = '123') {
  await group.getByLabel('Client ID').fill(clientId)
  await group.getByLabel('Client secret').fill('app-client-secret-opaque')
  await group.getByRole('button', { name: 'Save', exact: true }).click()
}
async function opened() {
  return await ctx.app?.evaluate(() =>
    (globalThis as typeof globalThis & { asanaOpened: string[] }).asanaOpened.at(-1),
  )
}

test('pasted app credentials reach the daemon; browser authorization, identity, test, disconnect and removal cross IPC', async () => {
  const { window, group } = await settings()
  const rejected = await window.evaluate(async () => {
    const denied: string[] = []
    for (const name of ['connectAsana']) {
      try {
        await globalThis.window.ted.request(name)
      } catch {
        denied.push(name)
      }
    }
    return denied
  })
  expect(rejected).toEqual(['connectAsana'])
  await saveApp(group)
  await expect.poll(() => group.textContent()).toContain('App configured')
  expect(await group.getByLabel('Client secret').count()).toBe(0)
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
  expect(
    await preview.evaluate((card) => {
      const box = card.parentElement
      if (!box) return 'no description box'
      if (card.getBoundingClientRect().bottom <= box.getBoundingClientRect().bottom) return 'fits'
      return getComputedStyle(box).overflowY === 'visible' ? 'spills' : 'scrolls'
    }),
  ).toMatch(/^(fits|scrolls)$/)
  await expect.poll(() => newTask.getByLabel('Title').inputValue()).toBe('Checkout redesign')
  expect(await preview.getByLabel('Sync these Tasks with Asana').isChecked()).toBe(true)
  expect(await preview.textContent()).toContain('Ted comments on each Asana task')
  expect(await preview.textContent()).toContain(
    'Title names the parent Task; the Tasks under it keep their Asana names.',
  )
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
  stub.setTasks([
    { gid: '506', name: 'Gift cards', subtasks: ['507'] },
    { gid: '507', name: 'Card balance' },
  ])
  await window.keyboard.press('Meta+N')
  const declining = window.getByRole('dialog', { name: 'New Task' })
  await declining.getByLabel('Description').fill('https://app.asana.com/0/9/506/f')
  const syncBox = declining
    .getByRole('region', { name: 'Asana import' })
    .getByLabel('Sync these Tasks with Asana')
  await syncBox.waitFor()
  expect(await syncBox.isChecked()).toBe(true)
  await expect.poll(() => declining.getByLabel('Title').inputValue()).toBe('Gift cards')
  await declining.getByLabel('Title').fill('Gift cards, renamed')
  await syncBox.uncheck()
  expect(await declining.getByRole('region', { name: 'Asana import' }).textContent()).toContain(
    'The new Tasks won’t update Asana',
  )
  await declining.getByLabel('Start now').setChecked(false)
  await declining.getByRole('button', { name: 'Create 2 Tasks' }).click()
  await declining.waitFor({ state: 'detached' })
  const declined = (await (await daemonClient()).listTasks()).filter((t) =>
    ['506', '507'].includes(t.source?.asana?.gid ?? ''),
  )
  expect(declined.map((t) => t.asanaSync?.state)).toEqual(['not-allowed', 'not-allowed'])
  expect(declined.map((t) => t.title).sort()).toEqual(['Card balance', 'Gift cards, renamed'])
  stub.setPageSize(1)
  stub.setWorkspaces([
    { gid: '2', name: 'Elsewhere' },
    { gid: '1', name: 'Acme' },
  ])
  stub.setProjects([
    { gid: '9', name: 'Roadmap', workspace: '1', sections: [{ gid: '91', name: 'Now' }] },
    { gid: '8', name: 'Other', workspace: '1' },
  ])
  const factoryRow = sidebar(window).getByRole('article', { name: 'widgets', exact: true })
  if (
    (await factoryRow.getByRole('button', { name: 'Views' }).getAttribute('aria-expanded')) !==
    'true'
  )
    await factoryRow.getByRole('button', { name: 'Views' }).click()
  await factoryRow.locator('..').getByRole('button', { name: 'Settings', exact: true }).click()
  await window
    .getByRole('navigation', { name: 'Factory settings' })
    .getByRole('button', { name: 'Intake', exact: true })
    .click()
  const intake = window
    .getByRole('region', { name: 'Intake', exact: true })
    .getByRole('region', { name: 'Asana', exact: true })
  const saveIntake = intake.getByRole('button', { name: 'Save', exact: true })
  await intake.getByRole('switch', { name: 'Import Asana work into this Factory' }).click()
  await intake.getByRole('button', { name: 'Load more workspaces' }).click()
  await intake.getByLabel('Workspace').selectOption('1')
  await intake.getByRole('button', { name: 'Load more projects' }).click()
  await intake.getByLabel('Project').selectOption('8')
  await intake.getByText('No sections found.').waitFor()
  await intake.getByText('Saved: Off').waitFor()
  await saveIntake.click()
  await saveIntake.waitFor({ state: 'detached' })
  const client = await daemonClient()
  expect((await client.getSettings()).asanaIntakeScopes[root?.factoryId ?? '']).toEqual({
    workspace: { gid: '1', name: 'Acme' },
    project: { gid: '8', name: 'Other' },
  })
  await intake.getByLabel('Project').selectOption('9')
  await intake.getByLabel('Section (optional)').selectOption('91')
  await intake.getByText('Saved: Other · Acme').waitFor()
  await saveIntake.click()
  await saveIntake.waitFor({ state: 'detached' })
  expect((await client.getSettings()).asanaIntakeScopes[root?.factoryId ?? '']).toEqual({
    workspace: { gid: '1', name: 'Acme' },
    project: { gid: '9', name: 'Roadmap' },
    section: { gid: '91', name: 'Now' },
  })
  stub.setPageSize(2)
  expect(root?.asanaSync).toMatchObject({ state: 'waiting-merge' })
  stub.setTasks([{ gid: '505', name: 'Tax line' }])
  await ted(
    'task',
    'create',
    '--factory',
    'NB',
    '--source',
    'https://app.asana.com/0/0/505',
    'Tax line from the terminal',
  )
  expect((await client.listTasks()).find((t) => t.source?.asana?.gid === '505')?.title).toBe(
    'Tax line from the terminal',
  )
  await openAllTasks(window)
  const fromCli = window.locator('tr[data-task="NB-6"]')
  await fromCli.click()
  await expect.poll(() => window.locator('[data-task-sync]').textContent()).toContain('Not syncing')
  await window.getByRole('button', { name: '← All Tasks' }).click()
  await fromCli.click({ button: 'right' })
  await window
    .getByRole('menuitem', { name: 'Sync with Asana Not syncing yet', exact: true })
    .click()
  await fromCli.click()
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
  await group.getByRole('button', { name: 'Remove configuration…' }).click()
  await window.getByRole('dialog').getByRole('button', { name: 'Continue', exact: true }).click()
  await expect
    .poll(() => group.textContent())
    .toContain('Set up an Asana app, then paste its client ID and secret.')
})

test('setup steps link the console and copy the redirect URL; a bad client ID is refused; file storage without a keyring, also when replacing; Replace app cancels; cancel closes the callback', async () => {
  const { window, group } = await settings()
  await expect.poll(() => group.locator('details').getAttribute('open')).not.toBeNull()
  expect(await group.locator('ol code').allTextContents()).toEqual([
    `http://127.0.0.1:${ctx.extraEnv?.TED_ASANA_CALLBACK_PORT}/asana/callback`,
    'attachments:read',
    'projects:read',
    'stories:read',
    'stories:write',
    'tasks:read',
    'tasks:write',
    'users:read',
    'workspaces:read',
  ])
  await group.getByRole('button', { name: 'Open Asana developer console ↗' }).click()
  await expect.poll(opened).toBe('https://app.asana.com/0/my-apps')
  await group.getByRole('button', { name: 'Copy', exact: true }).click()
  await expect
    .poll(() =>
      ctx.app?.evaluate(
        () => (globalThis as typeof globalThis & { asanaCopied: string[] }).asanaCopied,
      ),
    )
    .toEqual([`http://127.0.0.1:${ctx.extraEnv?.TED_ASANA_CALLBACK_PORT}/asana/callback`])
  await saveApp(group, 'not-a-number')
  await expect.poll(() => group.textContent()).toContain('Asana client ID must contain digits')
  await writeFile(
    path.join(ctx.home, 'stub-keyring.json.asana-oauth'),
    JSON.stringify({ state: 'no-keyring' }),
  )
  const inFile = group.getByRole('button', { name: 'Save in a file only you can read' })
  await inFile.waitFor()
  await group.getByLabel('Client ID').fill('123')
  await group.getByLabel('Client secret').fill('app-client-secret-opaque')
  await inFile.click()
  await expect.poll(() => group.textContent()).toContain('App configured')
  expect(await group.locator('details').getAttribute('open')).toBeNull()
  await group.getByRole('button', { name: 'Replace app', exact: true }).click()
  await window.getByRole('dialog').getByRole('button', { name: 'Continue', exact: true }).click()
  await inFile.waitFor()
  await group.getByLabel('Client ID').fill('456')
  await group.getByLabel('Client secret').fill('canceled-secret')
  await group.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect.poll(() => group.textContent()).toContain('App configured')
  await group.getByRole('button', { name: 'Replace app', exact: true }).click()
  await window.getByRole('dialog').getByRole('button', { name: 'Continue', exact: true }).click()
  expect(await group.getByLabel('Client ID').inputValue()).toBe('')
  expect(await group.getByLabel('Client secret').inputValue()).toBe('')
  await group.getByRole('button', { name: 'Cancel', exact: true }).click()
  await group.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect.poll(opened).toContain('https://app.asana.com/-/oauth_authorize')
  const url = await opened()
  if (!url) throw new Error('No authorization URL')
  await group.getByRole('button', { name: 'Cancel authorization' }).click()
  await expect.poll(() => group.textContent()).toContain('Authorization canceled')
  await expect(fetch(stub.callback(url))).rejects.toThrow()
})
