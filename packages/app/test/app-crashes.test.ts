import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { readDaemonInfo } from '@ted/protocol'
import type { Page } from 'playwright'
import { describe, expect, test } from 'vitest'
import { commitToOrigin, isAlive, makeOriginRepo, waitForExit } from '../../daemon/test/helpers.ts'
import {
  addFactory,
  ctx,
  daemonPid,
  launchApp,
  openAllTasks,
  runHostPids,
  setUpAppTests,
  sidebar,
  taskRow,
  ted,
} from './app-harness.ts'

setUpAppTests()

describe('daemon crashes', () => {
  const reconnecting = (window: Page) =>
    window.getByRole('status', { name: 'Reconnecting to Ted…' })

  async function killDaemon(): Promise<number> {
    const pid = await daemonPid()
    process.kill(pid, 'SIGKILL')
    await waitForExit(pid)
    return pid
  }

  async function waitForNewDaemon(old: number): Promise<number> {
    await expect
      .poll(
        async () => {
          const info = await readDaemonInfo(ctx.home)
          return info !== undefined && info.pid !== old && isAlive(info.pid)
        },
        { timeout: 20_000 },
      )
      .toBe(true)
    return daemonPid()
  }

  test('killing the daemon shows the Reconnecting bar and turns actions off while the Run keeps going; the restarted daemon picks the Run back up', async () => {
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    await commitToOrigin(path.join(ctx.home, 'origin'), {
      '.ted/workflow.yaml': 'version: 1\norder: [intake, work, merge]\n',
    })
    const steps = JSON.stringify({
      steps: [
        { waitFor: path.join(ctx.home, 'go') },
        { everyMessage: [{ run: ['ted', 'outcome', 'advance'] }] },
        { run: ['ted', 'outcome', 'advance'] },
      ],
    })
    await addFactory(origin, 'NB')
    await ted('task', 'create', '--factory', 'NB', steps)
    const window = await launchApp({ TED_RESTART_DELAYS_MS: '1500,0,0' })
    await openAllTasks(window)
    await taskRow(window, 'NB-1').click()
    const details = window.getByRole('complementary', { name: 'Task details' })
    await ted('task', 'start', 'NB-1')
    await details.getByText('Intake', { exact: true }).waitFor()
    await expect.poll(async () => (await runHostPids()).length).toBe(2)
    const hosts = await runHostPids()

    const old = await killDaemon()

    await reconnecting(window).waitFor()
    await reconnecting(window)
      .getByText('Runs keep going. Actions are off until Ted is back.')
      .waitFor()
    expect(await sidebar(window).getByRole('button', { name: 'All Tasks' }).isDisabled()).toBe(true)
    expect(hosts.every(isAlive)).toBe(true)

    await waitForNewDaemon(old)
    await reconnecting(window).waitFor({ state: 'detached', timeout: 20_000 })
    expect(await sidebar(window).getByRole('button', { name: 'All Tasks' }).isDisabled()).toBe(
      false,
    )
    await writeFile(path.join(ctx.home, 'go'), '')
    await details.getByText('Done', { exact: true }).waitFor({ timeout: 20_000 })
  })

  test('three crashes in ten minutes stop restarts and raise the banner; its menu copies a report and restarts Ted', async () => {
    const window = await launchApp({ TED_RESTART_DELAYS_MS: '0,0,0' })
    await ctx.app?.evaluate(({ clipboard }) => {
      const record = globalThis as typeof globalThis & { copied: string[] }
      record.copied = []
      clipboard.writeText = async (text: string) => {
        record.copied.push(text)
      }
    })
    const recorded = () =>
      ctx.app?.evaluate(() => ({
        copied: (globalThis as typeof globalThis & { copied: string[] }).copied,
      }))

    await waitForNewDaemon(await killDaemon())
    await reconnecting(window).waitFor({ state: 'detached', timeout: 20_000 })
    await waitForNewDaemon(await killDaemon())
    await reconnecting(window).waitFor({ state: 'detached', timeout: 20_000 })
    await expect
      .poll(() => readFile(path.join(ctx.home, 'logs', 'daemon.log'), 'utf8').catch(() => ''), {
        timeout: 20_000,
      })
      .toMatch(/Ted daemon .* listening on/)
    const last = await killDaemon()

    const banner = window.getByRole('region', { name: 'Problems' }).getByRole('alert')
    await banner.getByText('Ted’s background process keeps stopping').waitFor()
    expect(await reconnecting(window).count()).toBe(0)
    expect(await sidebar(window).getByRole('button', { name: 'All Tasks' }).isDisabled()).toBe(true)
    await sleep(500)
    expect(await daemonPid()).toBe(last)

    await banner.getByRole('button', { name: 'Restart' }).click()
    await window.getByRole('menuitem', { name: 'Copy report' }).click()
    await expect.poll(async () => (await recorded())?.copied.length).toBe(1)
    const [report] = (await recorded())?.copied ?? []
    expect(report).toContain('crash report')
    expect(report).toMatch(/Ted daemon .* listening on/)
    expect(report).toContain('starting Ted’s daemon')

    await banner.getByRole('button', { name: 'Restart' }).click()
    await window.getByRole('menuitem', { name: 'Restart Ted in the background' }).click()

    await banner.waitFor({ state: 'detached', timeout: 20_000 })
    await waitForNewDaemon(last)
    await reconnecting(window).waitFor({ state: 'detached', timeout: 20_000 })
    expect(await sidebar(window).getByRole('button', { name: 'All Tasks' }).isDisabled()).toBe(
      false,
    )
  })
})
