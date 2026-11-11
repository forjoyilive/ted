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
    const window = await launchApp()
    await ted('task', 'start', 'NB-1')

    await expect
      .poll(menuLabels, { timeout: 20_000 })
      .toEqual(
        expect.arrayContaining([
          '1 waiting on you',
          '0 of 1 Run working',
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

    await ctx.app?.evaluate(({ Menu }) => {
      const find = (menu: Electron.Menu): Electron.MenuItem | undefined => {
        for (const item of menu.items) {
          const found = item.label === 'Settings…' ? item : item.submenu && find(item.submenu)
          if (found) return found
        }
        return undefined
      }
      const menu = Menu.getApplicationMenu()
      const settings = menu && find(menu)
      settings?.click()
    })

    await window.getByRole('radiogroup', { name: 'Appearance' }).waitFor()
  })

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
