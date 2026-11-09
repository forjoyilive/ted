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
  daemonClient,
  daemonPid,
  launchApp,
  openAllTasks,
  runHostPids,
  setUpAppTests,
  sidebar,
  startDaemonAsApp,
  taskRow,
  ted,
} from './app-harness.ts'

setUpAppTests()

describe('daemon crashes', () => {
  const reconnecting = (window: Page) =>
    window.getByRole('status', { name: 'Reconnecting to TED…' })

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
      .getByText('Runs keep going. Actions are off until TED is back.')
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

  test('after reconnecting, the sidebar shows slots that changed while the app was away', async () => {
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    await addFactory(origin, 'NB')
    await ted(
      'task',
      'create',
      '--factory',
      'NB',
      JSON.stringify({ steps: [{ waitFor: path.join(ctx.home, 'never') }] }),
    )
    const window = await launchApp({ TED_RESTART_DELAYS_MS: '6000,0,0' })
    await ted('task', 'start', 'NB-1')
    const footer = sidebar(window).locator('footer')
    await footer.getByRole('button', { name: /^1 of \d+ Runs working$/ }).waitFor()

    await killDaemon()
    await reconnecting(window).waitFor()
    await startDaemonAsApp()
    await (await daemonClient()).updateSettings({ maxWorkingRuns: 7 })

    await reconnecting(window).waitFor({ state: 'detached', timeout: 20_000 })
    await footer.getByRole('button', { name: '1 of 7 Runs working' }).waitFor()
  })

  test('after reconnecting, the Inbox shows a request raised while the app was away', async () => {
    const origin = await makeOriginRepo(path.join(ctx.home, 'origin'))
    const briefFile = path.join(ctx.home, 'brief.md')
    await writeFile(
      briefFile,
      [
        '## Goal\n\nLet notes be edited offline.',
        '## Decisions so far\n\n- Keep both edits on a clash.',
        '## Current state\n\nThe approach is written up.',
        '## Open questions\n\nNone.',
        '## Next step\n\nBuild it.\n',
      ].join('\n\n'),
    )
    const gate = [
      { run: ['ted', 'brief', 'write', '--file', briefFile] },
      { run: ['ted', 'outcome', 'advance'] },
      { endTurn: true },
    ]
    await addFactory(origin, 'NB')
    await ted(
      'task',
      'create',
      '--factory',
      'NB',
      JSON.stringify({ steps: [{ everyMessage: gate }, ...gate] }),
    )
    const window = await launchApp({ TED_RESTART_DELAYS_MS: '8000,0,0' })
    const inbox = window.getByRole('region', { name: 'Inbox' })
    await inbox.waitFor()

    await killDaemon()
    await reconnecting(window).waitFor()
    await ted('task', 'start', 'NB-1')
    await expect
      .poll(async () => (await (await daemonClient()).listInbox()).length, { timeout: 20_000 })
      .toBe(1)

    await reconnecting(window).waitFor({ state: 'detached', timeout: 20_000 })
    await inbox.getByRole('button').filter({ hasText: 'Design review' }).waitFor()
  })

  test('three crashes in ten minutes stop restarts and raise the banner; its menu copies a report and restarts TED', async () => {
    const window = await launchApp({ TED_RESTART_DELAYS_MS: '0,0,0' })
    await ctx.app?.evaluate(({ clipboard }) => {
      const record = globalThis as unknown as { copied: string[] }
      record.copied = []
      clipboard.writeText = async (text: string) => {
        record.copied.push(text)
      }
    })
    const recorded = () => ctx.app?.evaluate(() => globalThis as unknown as { copied: string[] })

    await waitForNewDaemon(await killDaemon())
    await reconnecting(window).waitFor({ state: 'detached', timeout: 20_000 })
    await waitForNewDaemon(await killDaemon())
    await reconnecting(window).waitFor({ state: 'detached', timeout: 20_000 })
    await expect
      .poll(() => readFile(path.join(ctx.home, 'logs', 'daemon.log'), 'utf8').catch(() => ''), {
        timeout: 20_000,
      })
      .toMatch(/TED daemon .* listening on/)
    const last = await killDaemon()

    const banner = window.getByRole('region', { name: 'Problems' }).getByRole('alert')
    await banner.getByText('TED’s background process keeps stopping').waitFor()
    expect(await reconnecting(window).count()).toBe(0)
    expect(await sidebar(window).getByRole('button', { name: 'All Tasks' }).isDisabled()).toBe(true)
    await sleep(500)
    expect(await daemonPid()).toBe(last)

    await banner.getByRole('button', { name: 'Restart' }).click()
    await window.getByRole('menuitem', { name: 'Copy report' }).click()
    await expect.poll(async () => (await recorded())?.copied.length).toBe(1)
    const [report] = (await recorded())?.copied ?? []
    expect(report).toContain('crash report')
    expect(report).toMatch(/TED daemon .* listening on/)
    expect(report).toContain('starting TED’s daemon')

    await banner.getByRole('button', { name: 'Restart' }).click()
    await window.getByRole('menuitem', { name: 'Restart TED in the background' }).click()

    await banner.waitFor({ state: 'detached', timeout: 20_000 })
    await waitForNewDaemon(last)
    await reconnecting(window).waitFor({ state: 'detached', timeout: 20_000 })
    expect(await sidebar(window).getByRole('button', { name: 'All Tasks' }).isDisabled()).toBe(
      false,
    )
  })
})
