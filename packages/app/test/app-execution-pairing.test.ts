import { once } from 'node:events'
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { workerRequest } from '@ted/daemon/execution'
import { readDaemonInfo } from '@ted/protocol'
import { _electron as electron } from 'playwright'
import { expect, test } from 'vitest'
import { observe } from '../../daemon/test/support/execution-observations.ts'
import {
  appDir,
  ctx,
  electronPath,
  env,
  launchApp,
  openSettings,
  settingsNav,
  setUpAppTests,
} from './app-harness.ts'

import { loadedWindow } from './first-window.ts'

setUpAppTests()
test('Machines opens an isolated worker window with expandable setup help and no approval interface', async () => {
  ctx.extraEnv.TED_EXECUTION_HOME = path.join(await realpath(ctx.home), 'isolated-worker')
  const window = await launchApp()
  await openSettings(window)
  await settingsNav(window).getByRole('button', { name: 'Machines', exact: true }).click()
  await window.getByText('How connecting Macs works').click()
  expect(await window.getByText(/Connect both Macs to the same local/).isVisible()).toBe(true)
  const app = ctx.app
  if (!app) throw new Error('No app')
  const opened = app.waitForEvent('window')
  await window.getByRole('button', { name: 'Use this Mac as a worker…' }).click()
  const worker = await opened
  await worker.getByRole('heading', { name: 'Use this Mac as a worker' }).waitFor()
  await worker.getByText('Having trouble connecting?').click()
  expect(await worker.getByText(/Guest Wi-Fi or a firewall/).isVisible()).toBe(true)
  expect(await worker.getByRole('button', { name: 'Approve pairing' }).count()).toBe(0)
  const refusal = await worker.evaluate(async () => {
    try {
      await globalThis.window.ted.request('createExecutionEnrollment')
      return false
    } catch {
      return true
    }
  })
  expect(refusal).toBe(true)
  const capture = path.resolve('node_modules/.cache/ted-pairing-ui.png')
  await worker.screenshot({ path: capture, fullPage: true })
  expect(window.isClosed()).toBe(false)
  await observe('pairing-ui', {
    sameNetworkGuidance: 'visible and expandable',
    workerControllerAPI: 'refused',
    screenshot: 'node_modules/.cache/ted-pairing-ui.png',
  })
})

test('worker-only mode starts no Factory daemon, survives window closure and stops its app-owned service on Quit', async () => {
  const home = path.join(await realpath(ctx.home), 'isolated-worker')
  ctx.extraEnv.TED_EXECUTION_HOME = home
  ctx.app = await electron.launch({
    executablePath: electronPath,
    args: [appDir, '--worker'],
    env: env(),
  })
  const app = ctx.app
  const window = await loadedWindow(app)
  await window.getByRole('button', { name: 'Start worker' }).click()
  await expect.poll(async () => (await workerRequest(home, 'status')).state).toBe('unpaired')
  expect(await readDaemonInfo(ctx.home)).toBeUndefined()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
  expect((await workerRequest(home, 'status')).state).toBe('unpaired')
  const exited = once(app.process(), 'exit')
  await window.evaluate(() => globalThis.window.ted.request('quit')).catch(() => undefined)
  await exited
  ctx.app = undefined
  await expect(workerRequest(home, 'status')).rejects.toThrow()
  await observe('worker-only-lifecycle', {
    factoryDaemon: 'not started',
    windowClose: 'service stayed available',
    appQuit: 'service and app exited',
  })
})
