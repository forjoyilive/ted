import { setTimeout as sleep } from 'node:timers/promises'
import type { ElectronApplication } from 'playwright'

function kill(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {}
}

export async function closeApp(
  app: ElectronApplication | undefined,
  timeoutMs = 10_000,
): Promise<void> {
  if (!app) return
  let child: ReturnType<ElectronApplication['process']> | undefined
  try {
    child = app.process()
  } catch {}
  const closed = await Promise.race([
    app.close().then(
      () => true,
      () => false,
    ),
    sleep(timeoutMs).then(() => false),
  ])
  if (!child || (closed && child.exitCode !== null)) return
  if (child.pid !== undefined) {
    kill(-child.pid)
    kill(child.pid)
  }
}
