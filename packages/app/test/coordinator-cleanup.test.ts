import type { ChildProcess } from 'node:child_process'
import type { ElectronApplication } from 'playwright'
import { afterEach, expect, test, vi } from 'vitest'
import { killRunHosts, removeHome, stopDaemonIn } from '../../daemon/test/helpers.ts'
import { cleanupCoordinator } from './support/coordinator-cleanup.ts'

vi.mock('./failure-capture.ts', () => ({ captureFailure: vi.fn(async () => {}) }))
vi.mock('../../daemon/test/helpers.ts', () => ({
  stopDaemonIn: vi.fn(async () => {}),
  killRunHosts: vi.fn(async () => {}),
  removeHome: vi.fn(async () => {}),
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
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
  let home = 'first-attempt'
  const cleanup = cleanupCoordinator(home, app, report)
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
  vi.mocked(stopDaemonIn).mockRejectedValueOnce(error)
  const report = vi.fn()
  await expect(cleanupCoordinator('failed-attempt', app, report)).rejects.toBe(error)
  expect(kill).not.toHaveBeenCalled()
  expect(killRunHosts).not.toHaveBeenCalled()
  expect(removeHome).not.toHaveBeenCalled()
  expect(report.mock.lastCall?.[0].outcome).toBe('failed')
})
