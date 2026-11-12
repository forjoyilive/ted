import { once } from 'node:events'
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { stopExecutionService, workerRequest } from '@ted/daemon/execution'
import { readDaemonInfo } from '@ted/protocol'
import { _electron as electron } from 'playwright'
import { expect, test } from 'vitest'
import { isAlive, waitUntil } from '../../daemon/test/helpers.ts'
import { createExecutionFixture } from '../../daemon/test/support/execution-fixture.ts'
import { observe } from '../../daemon/test/support/execution-observations.ts'
import {
  pendingPairing,
  preparePairingController,
} from '../../daemon/test/support/execution-pairing.ts'
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
import { executionStartupGate } from './support/execution-startup.ts'

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
  const gate = await executionStartupGate(ctx.home)
  ctx.extraEnv.TED_EXECUTION_HOME = home
  Object.assign(ctx.extraEnv, gate.env)
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
  await stopExecutionService(home)
  await gate.hold()
  const starting = window
    .evaluate(() => globalThis.window.ted.request('workerStart'))
    .catch(() => undefined)
  try {
    const pid = await gate.pid()
    const exited = once(app.process(), 'exit')
    await app.evaluate(({ app }) => app.quit()).catch(() => undefined)
    await expect(
      window.evaluate(() => globalThis.window.ted.request('workerStart')),
    ).rejects.toThrow('Worker is stopping')
    await gate.release()
    await exited
    await starting
    await waitUntil(() => !isAlive(pid), 'the delayed app-owned worker to exit')
  } finally {
    await gate.release()
  }
  ctx.app = undefined
  await expect(workerRequest(home, 'status')).rejects.toThrow()
  await observe('worker-only-lifecycle', {
    factoryDaemon: 'not started',
    windowClose: 'service stayed available',
    appQuit: 'service and app exited',
  })
  await observe('worker-startup-quit', {
    startup: 'held before control publication',
    quit: 'waited for startup and confirmed owned worker exit',
  })
})

test('worker Pair after app Quit replaces a still-valid saved controller without resuming it', async () => {
  const fixture = await createExecutionFixture()
  const home = path.join(await realpath(ctx.home), 'replacement-worker')
  ctx.extraEnv.TED_EXECUTION_HOME = home
  async function openWorker() {
    ctx.app = await electron.launch({
      executablePath: electronPath,
      args: [appDir, '--worker'],
      env: env(),
    })
    return loadedWindow(ctx.app)
  }
  try {
    const first = await fixture.machine('controller')
    const second = await fixture.machine('controller')
    const original = await preparePairingController(first)
    const replacement = await preparePairingController(second)
    const originalScope = (await first.client.executionMachines()).repos.find(
      (repo) => repo.factoryId === original.factoryId,
    )
    const replacementScope = (await second.client.executionMachines()).repos.find(
      (repo) => repo.factoryId === replacement.factoryId,
    )
    if (!originalScope || !replacementScope) throw new Error('Missing synthetic repo scope')
    let window = await openWorker()
    await window.getByLabel('Pairing details', { exact: true }).fill(JSON.stringify(original.offer))
    await window.getByRole('button', { name: 'Connect to controller', exact: true }).click()
    const review = await pendingPairing(first)
    const oldGrant = await first.client.approveExecution({ id: review.id, scopes: [originalScope] })
    await expect.poll(async () => (await workerRequest(home, 'status')).state).toBe('connected')
    const app = ctx.app
    if (!app) throw new Error('No app')
    const exited = once(app.process(), 'exit')
    await app.evaluate(({ app }) => app.quit()).catch(() => undefined)
    await exited
    ctx.app = undefined
    await expect(workerRequest(home, 'status')).rejects.toThrow()
    window = await openWorker()
    await window
      .getByLabel('Pairing details', { exact: true })
      .fill(JSON.stringify(replacement.offer))
    await window.getByRole('button', { name: 'Connect to controller', exact: true }).click()
    const pending = await pendingPairing(second)
    expect(await workerRequest(home, 'status')).toMatchObject({
      state: 'pending',
      controllerPin: replacement.offer.controllerPin,
      publicKey: review.publicKey,
      scopes: [],
    })
    expect((await workerRequest(home, 'status')).grantId).toBeUndefined()
    expect(
      (await first.client.executionMachines()).machines.find((m) => m.id === oldGrant.id)
        ?.revokedAt,
    ).toBeUndefined()
    const grant = await second.client.approveExecution({
      id: pending.id,
      scopes: [replacementScope],
    })
    expect(grant.id).not.toBe(oldGrant.id)
    await expect.poll(async () => (await workerRequest(home, 'status')).grantId).toBe(grant.id)
    await expect.poll(async () => (await workerRequest(home, 'status')).state).toBe('connected')
    await observe('pairing-app-replacement', {
      oldController: original.offer.controllerPin,
      newController: replacement.offer.controllerPin,
      oldGrant: oldGrant.id,
      newGrant: grant.id,
      appQuit: 'owned process exited; Pair after reopening required fresh approval',
    })
    const task = await second.client.createTask({ factory: 'PAIR', title: 'Synthetic' })
    await second.rpc({ action: 'assign-remote', taskId: task.id, machineId: grant.id })
    await second.rpc({
      action: 'issue',
      input: {
        operationId: 'op-window',
        taskId: task.id,
        scope: replacementScope,
        input: { wait: true },
      },
    })
    await window.getByText('Connected. 1 operation running.').waitFor({ timeout: 30_000 })
    await second.rpc({ action: 'stop-operation', id: 'op-window' })
    await expect
      .poll(
        async () =>
          (await second.rpc<{ state: string } | null>({ action: 'operation', id: 'op-window' }))
            ?.state,
        { timeout: 30_000 },
      )
      .toBe('stopped')
    await observe('command-worker-window', {
      whileRunning: 'Connected. 1 operation running.',
      afterStop: 'stopped on the controller',
    })
  } finally {
    if (ctx.app) await ctx.app.close()
    ctx.app = undefined
    await fixture.close()
  }
}, 180_000)
