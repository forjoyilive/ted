import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDaemonInfo } from '@ted/protocol'
import { _electron as electron } from 'playwright'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { appDir, ctx, electronPath, env, launchApp, setUpAppTests, sidebar } from './app-harness.ts'
import { captureStartup, observeStartup } from './startup-evidence.ts'

setUpAppTests()

const workerCount = 6
const loadedTest = test.skipIf(process.env.ELECTRON_STARTUP_LOAD !== String(workerCount))
let workload: ReturnType<typeof spawn>
let workloadFailed = false
let stopping = false

beforeAll(async () => {
  if (process.env.ELECTRON_STARTUP_LOAD !== String(workerCount)) return
  workload = spawn(
    process.execPath,
    [
      fileURLToPath(new URL('../../../scripts/check-load.ts', import.meta.url)),
      String(workerCount),
    ],
    {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  workload.once('error', () => {
    workloadFailed = true
  })
  workload.once('exit', () => {
    if (!stopping) workloadFailed = true
  })
  workload.stderr?.resume()
  await new Promise<void>((resolve, reject) => {
    let output = ''
    const finish = (error?: Error) => {
      clearTimeout(timer)
      workload.stdout?.off('data', onData)
      workload.off('error', onError)
      workload.off('exit', onExit)
      if (error) reject(error)
      else resolve()
    }
    const onData = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-1024)
      if (output.includes('READY\n')) {
        finish(workloadFailed ? new Error('CPU workload failed before readiness') : undefined)
      }
    }
    const onError = (error: Error) => finish(error)
    const onExit = () => finish(new Error('CPU workload exited before readiness'))
    const timer = setTimeout(
      () => finish(new Error('CPU workload was not ready within 20 seconds')),
      20_000,
    )
    workload.stdout?.on('data', onData)
    workload.once('error', onError)
    workload.once('exit', onExit)
  })
})

afterAll(async () => {
  const failed = workloadFailed
  stopping = true
  if (workload && workload.exitCode === null && workload.signalCode === null) {
    const ended = once(workload, 'exit')
    workload.kill('SIGTERM')
    const force = setTimeout(() => workload.kill('SIGKILL'), 3000)
    try {
      await ended
    } finally {
      clearTimeout(force)
    }
  }
  expect(failed).toBe(false)
})

async function evidence() {
  if (!ctx.app) throw new Error('No launched app')
  const file = await captureStartup(ctx.app)
  if (!file) throw new Error('Startup diagnostics were not saved')
  const report = JSON.parse(await readFile(file, 'utf8'))
  console.log(JSON.stringify({ workerCount, workloadFailed, report }))
  expect(workloadFailed).toBe(false)
  expect(workload.exitCode).toBeNull()
  expect(workload.signalCode).toBeNull()
  expect(report.electron.exitCode).toBeNull()
  expect(report.daemon).toMatchObject({ infoPresent: true, data: 'ready' })
  expect(report.native).not.toBe('unavailable')
  expect(report.milestones).not.toBe('unavailable')
  const info = await readDaemonInfo(ctx.home)
  expect(info).toBeDefined()
  expect(JSON.stringify(report)).not.toContain(info?.token)
  return report
}

loadedTest('normal startup reaches a loaded window under six ready CPU workers', async () => {
  const window = await launchApp()
  await sidebar(window).waitFor()
  const report = await evidence()
  expect(report.playwrightWindows).toBe(1)
  expect(report.native).toHaveLength(1)
  expect(report.rendererLoaded).toBe('true')
  expect(report.milestones).toContain('daemon-connected')
  expect(report.milestones).toContain('renderer-load-start')
})

loadedTest(
  'startup evidence survives an exited Electron process without evaluating its home',
  async () => {
    await launchApp()
    if (!ctx.app) throw new Error('No launched app')
    const child = ctx.app.process()
    const ended = once(child, 'exit')
    child.kill('SIGKILL')
    await ended
    const file = await captureStartup(ctx.app)
    if (!file) throw new Error('Exit diagnostics were not saved')
    const report = JSON.parse(await readFile(file, 'utf8'))
    expect(report.electron.signalCode).toBe('SIGKILL')
    expect(report.native).toBe('unavailable')
    expect(report.events.map(({ event }: { event: string }) => event)).toContain('process-exit')
    expect(report.milestones).toContain('window-created')
    expect(workloadFailed).toBe(false)
  },
)

loadedTest(
  'explicit --background startup reaches the daemon and menu without a window under six ready CPU workers',
  async () => {
    ctx.app = await electron.launch({
      executablePath: electronPath,
      args: [appDir, '--background'],
      env: env(),
    })
    observeStartup(ctx.app, ctx.home)
    await expect.poll(() => readDaemonInfo(ctx.home), { timeout: 20_000 }).toBeDefined()
    await expect
      .poll(() =>
        ctx.app?.evaluate(({ Menu }) => {
          const walk = (menu: Electron.Menu): string[] =>
            menu.items.flatMap((item) => [item.label, ...(item.submenu ? walk(item.submenu) : [])])
          const menu = Menu.getApplicationMenu()
          return menu ? walk(menu) : []
        }),
      )
      .toContain('Quit Ted completely')
    await expect
      .poll(() => readFile(path.join(ctx.home, 'logs', 'app-startup.log'), 'utf8'))
      .toContain('background-ready')
    const report = await evidence()
    expect(report.native).toEqual([])
    expect(report.playwrightWindows).toBe(0)
    expect(report.milestones).toContain('background-mode')
    expect(report.milestones).toContain('background-ready')
  },
)
