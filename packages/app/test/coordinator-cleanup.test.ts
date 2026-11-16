import type { ChildProcess } from 'node:child_process'
import type { ElectronApplication } from 'playwright'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanupCoordinator } from './support/coordinator-cleanup.ts'

function fakeHelpers() {
  return {
    stopDaemonIn: vi.fn(async (_home: string) => {}),
    killRunHosts: vi.fn(async (_home: string) => {}),
    removeHome: vi.fn(async (_home: string) => {}),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

test('a stalled app close is forced before the hook deadline and the captured home is cleaned', async () => {
  const held = Promise.withResolvers<void>()
  const child = { pid: 987654, exitCode: null } as ChildProcess
  const app = {
    process: () => child,
    close: vi.fn(() => held.promise),
  } as unknown as ElectronApplication
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
  const report = vi.fn()
  const { stopDaemonIn, killRunHosts, removeHome } = fakeHelpers()
  let home = 'first-attempt'
  const cleanup = cleanupCoordinator(home, app, report, { stopDaemonIn, killRunHosts, removeHome })
  home = 'next-attempt'
  await cleanup
  expect(app.close).toHaveBeenCalledOnce()
  expect(kill.mock.calls).toEqual([
    [-987654, 'SIGKILL'],
    [987654, 'SIGKILL'],
  ])
  expect(stopDaemonIn).toHaveBeenCalledExactlyOnceWith('first-attempt')
  expect(killRunHosts).toHaveBeenCalledExactlyOnceWith('first-attempt')
  expect(removeHome).toHaveBeenCalledExactlyOnceWith('first-attempt')
  expect(home).toBe('next-attempt')
  expect(report.mock.lastCall?.[0]).toMatchObject({
    outcome: 'passed',
    steps: [
      { name: 'closeApp', state: 'passed' },
      { name: 'stopDaemonIn', state: 'passed' },
      { name: 'killRunHosts', state: 'passed' },
      { name: 'removeHome', state: 'passed' },
    ],
  })
}, 5000)

test('an already exited app is not killed and a daemon cleanup error remains visible', async () => {
  const child = { pid: 987654, exitCode: 0 } as ChildProcess
  const app = {
    process: () => child,
    close: async () => {},
  } as unknown as ElectronApplication
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
  const error = new Error('daemon stop failed')
  const { stopDaemonIn, killRunHosts, removeHome } = fakeHelpers()
  stopDaemonIn.mockRejectedValueOnce(error)
  const report = vi.fn()
  await expect(
    cleanupCoordinator('failed-attempt', app, report, { stopDaemonIn, killRunHosts, removeHome }),
  ).rejects.toBe(error)
  expect(kill).not.toHaveBeenCalled()
  expect(killRunHosts).not.toHaveBeenCalled()
  expect(removeHome).not.toHaveBeenCalled()
  expect(report.mock.lastCall?.[0].outcome).toBe('failed')
})
