import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { readDaemonInfo } from '@ted/protocol'
import { type ElectronApplication, _electron as electron } from 'playwright'
import { describe, expect, test } from 'vitest'
import { hostRecords, isAlive, makeOriginRepo, waitForExit } from '../../daemon/test/helpers.ts'
import {
  addFactory,
  appDir,
  ctx,
  daemonClient,
  daemonPid,
  electronPath,
  env,
  launchApp,
  openAllTasks,
  openSettings,
  run,
  setUpAppTests,
  taskRow,
  ted,
} from './app-harness.ts'
import { observeStartup } from './startup-evidence.ts'

setUpAppTests()

describe('running in the background', () => {
  async function startRun(steps: unknown[]): Promise<string> {
    const client = await daemonClient()
    const { id } = await client.startDevRun({ prompt: JSON.stringify({ steps }), cwd: ctx.home })
    await expect.poll(async () => (await client.getActivity()).runs.active).toBe(1)
    return id
  }

  const never = () => ({ waitFor: path.join(ctx.home, 'never') })

  const menuLabels = () =>
    (ctx.app as ElectronApplication).evaluate(({ Menu }) => {
      const walk = (menu: Electron.Menu): string[] =>
        menu.items.flatMap((item) => [item.label, ...(item.submenu ? walk(item.submenu) : [])])
      const menu = Menu.getApplicationMenu()
      return menu ? walk(menu) : []
    })

  const clickMenuItem = (label: string) =>
    (ctx.app as ElectronApplication).evaluate(({ Menu }, wanted) => {
      const find = (menu: Electron.Menu): Electron.MenuItem | undefined => {
        for (const item of menu.items) {
          const found = item.label === wanted ? item : item.submenu && find(item.submenu)
          if (found) return found
        }
        return undefined
      }
      const menu = Menu.getApplicationMenu()
      const item = menu && find(menu)
      if (!item) throw new Error(`no menu item ${wanted}`)
      item.click()
    }, label)

  test('closing the window keeps TED running, and the window still gets updates', async () => {
    const window = await launchApp()
    await openAllTasks(window)

    await ctx.app?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
    await ted('task', 'create', 'Fix login')

    expect(
      await ctx.app?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
    ).toBe(1)
    await taskRow(window, 'DEV-1').waitFor()
  })

  test('with Keep running remembered, Quit leaves the Run going; with Stop it, Quit ends it all', async () => {
    await launchApp()
    const client = await daemonClient()
    const pid = await daemonPid()
    const electronPid = ctx.app?.process().pid ?? 0
    await client.updateSettings({ quitWithWorkRunning: 'keep-running' })
    const runId = await startRun([never()])
    await sleep(300)

    await ctx.app?.evaluate(({ app }) => app.quit())
    await sleep(1_000)

    expect(isAlive(electronPid)).toBe(true)
    expect((await client.getRun(runId)).run.state).not.toBe('finished')

    await client.updateSettings({ quitWithWorkRunning: 'stop' })
    await sleep(300)
    await ctx.app?.close()
    ctx.app = undefined

    await waitForExit(pid)
    expect(isAlive(electronPid)).toBe(false)
    expect((await hostRecords(ctx.home, runId)).some((r) => r.t === 'exit')).toBe(true)
  })

  test('the app menu shows what’s waiting and running, and its items open the right place', async () => {
    await addFactory(await makeOriginRepo(path.join(ctx.home, 'origin')), 'NB')
    await ted(
      'task',
      'create',
      '--factory',
      'NB',
      JSON.stringify({
        steps: [{ permission: { tool: 'Bash', input: { command: 'ls' } } }, never()],
      }),
    )
    const sentry = await sentryStub()
    const window = await launchApp({ TED_SENTRY_DSN: sentry.dsn })
    await ted('task', 'start', 'NB-1')

    await expect
      .poll(menuLabels, { timeout: 20_000 })
      .toEqual(
        expect.arrayContaining([
          '1 waiting on you',
          '0 working · 1 unfinished Run',
          'Open TED',
          'New Task…',
          'Settings…',
          'Quit TED completely',
        ]),
      )
    if (process.platform === 'linux') {
      expect(
        await ctx.app?.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.getTitle(),
        ),
      ).toBe('TED Dev (1)')
    }

    await clickMenuItem('Settings…')
    await window.getByRole('radiogroup', { name: 'Appearance' }).waitFor()

    await clickMenuItem('Keyboard shortcuts')
    await window.getByRole('dialog', { name: 'Keyboard shortcuts' }).waitFor()
    await window.keyboard.press('Escape')

    try {
      await clickMenuItem('Report a problem')
      const report = window.getByRole('dialog', { name: 'Report a problem' })
      await expect.poll(() => report.locator('pre').textContent()).toContain('Daemon log')
      const send = report.getByRole('button', { name: 'Send' })
      expect(await send.isDisabled()).toBe(true)
      await report.getByLabel('What happened').fill('The Board froze.')
      await report.getByLabel('Email (optional)').fill('me@example.com')
      await report.getByLabel(/^Include the log/).uncheck()
      expect(sentry.envelopes).toEqual([])
      await send.click()
      const sent = window.getByRole('dialog', { name: 'Report sent. Thank you.' })
      const eventId = await sent.locator('[data-event-id]').textContent()
      expect(sentry.envelopes).toHaveLength(1)
      const [header, item, event, attachment, text] = (sentry.envelopes[0] ?? '').split('\n')
      expect(JSON.parse(header ?? '')).toMatchObject({ event_id: eventId })
      expect(JSON.parse(item ?? '')).toEqual({ type: 'feedback' })
      expect(JSON.parse(event ?? '')).toMatchObject({
        event_id: eventId,
        environment: 'dev',
        contexts: { feedback: { message: 'The Board froze.', contact_email: 'me@example.com' } },
      })
      expect(JSON.parse(attachment ?? '')).toMatchObject({
        type: 'attachment',
        filename: 'report.txt',
      })
      expect(text).toMatch(/^TED /)
      expect(sentry.envelopes[0]).toContain('Daemon log and process command lines left out')
      const client = await daemonClient()
      await expect.poll(async () => (await client.getSettings()).reportEmail).toBe('me@example.com')
      await sent.getByRole('button', { name: 'Done' }).click()

      sentry.status = 500
      await clickMenuItem('Report a problem')
      const again = window.getByRole('dialog', { name: 'Report a problem' })
      await expect
        .poll(() => again.getByLabel('Email (optional)').inputValue())
        .toBe('me@example.com')
      await again.getByLabel('What happened').fill('It froze again.')
      await again.getByRole('button', { name: 'Send' }).click()
      await again.getByRole('alert').getByText('The report wasn’t sent.').waitFor()
      await again.getByRole('button', { name: 'Copy report' }).waitFor()
      expect(sentry.envelopes).toHaveLength(2)
    } finally {
      sentry.server.close()
    }
  })

  async function sentryStub() {
    const stub = { envelopes: [] as string[], status: 200 }
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        if (req.method === 'POST' && req.url === '/api/7/envelope/') {
          stub.envelopes.push(Buffer.concat(chunks).toString('utf8'))
        }
        res.writeHead(stub.status, { 'Content-Type': 'application/json' }).end('{}')
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    return Object.assign(stub, { server, dsn: `http://public@127.0.0.1:${port}/7` })
  }

  const loginLog = () => path.join(ctx.home, 'login-item.log')
  test.skipIf(process.platform !== 'darwin')(
    'when macOS asks for approval, the row says so and opens Login Items',
    async () => {
      const window = await launchApp({
        TED_LOGIN_ITEM_LOG: loginLog(),
        TED_LOGIN_ITEM_STATUS: 'requires-approval',
      })
      await ctx.app?.evaluate(({ shell }) => {
        const opened: string[] = []
        Object.assign(globalThis, { opened })
        shell.openExternal = async (url: string) => {
          opened.push(url)
        }
      })
      await openSettings(window)

      await window.getByText('Allow TED in System Settings → Login Items').waitFor()
      await window.getByRole('button', { name: 'Open System Settings' }).click()

      await expect
        .poll(() => ctx.app?.evaluate(() => (globalThis as unknown as { opened: string[] }).opened))
        .toEqual(['x-apple.systempreferences:com.apple.LoginItems-Settings.extension'])
    },
  )

  test('started with --background, TED runs with no window', async () => {
    ctx.app = await electron.launch({
      executablePath: electronPath,
      args: [appDir, '--background'],
      env: env(),
    })
    observeStartup(ctx.app, ctx.home)
    await expect.poll(() => readDaemonInfo(ctx.home), { timeout: 20_000 }).toBeDefined()
    await expect.poll(menuLabels).toEqual(expect.arrayContaining(['Quit TED completely']))

    expect(
      await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
    ).toBe(0)
  })

  test('opening TED again while it runs hands over to the running app', async () => {
    await launchApp()
    const electronPid = ctx.app?.process().pid ?? 0

    await run(electronPath, [appDir], { env: env(), timeout: 20_000 })

    expect(isAlive(electronPid)).toBe(true)
  })
})
