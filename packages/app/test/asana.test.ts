import { chmod, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { startStubAsana, unusedPort } from '../../daemon/test/fixtures/stub-asana.ts'
import { ctx, launchApp, openSettings, setUpAppTests } from './app-harness.ts'

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
