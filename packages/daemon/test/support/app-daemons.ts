import type { ChildProcess } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { type DaemonInfo, readDaemonInfo } from '@ted/protocol'

interface OwnedDaemon {
  child: ChildProcess
  ended: Promise<void>
  error?: Error
  stopping?: Promise<void>
}

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null

async function within(ended: Promise<void>, ms: number): Promise<boolean> {
  const abort = new AbortController()
  try {
    return await Promise.race([ended.then(() => true), sleep(ms, false, { signal: abort.signal })])
  } finally {
    abort.abort()
  }
}

export class AppDaemons {
  private readonly children = new Map<string, OwnedDaemon>()

  async start(home: string, child: ChildProcess, timeoutMs = 20_000): Promise<DaemonInfo> {
    const owned: OwnedDaemon = {
      child,
      ended: new Promise<void>((resolve) => {
        child.once('exit', () => resolve())
        child.once('error', (error) => {
          owned.error = error
          if (child.pid === undefined) resolve()
        })
      }),
    }
    this.children.set(home, owned)
    const deadline = Date.now() + timeoutMs
    try {
      for (;;) {
        const info = await readDaemonInfo(home)
        if (owned.error) throw owned.error
        if (owned.stopping) throw new Error('daemon stopped before daemon.json')
        if (exited(child)) {
          throw new Error(
            `daemon exited before daemon.json (code ${child.exitCode}, signal ${child.signalCode})`,
          )
        }
        if (info && info.pid === child.pid) return info
        if (Date.now() >= deadline)
          throw new Error('timed out waiting for daemon.json (child alive)')
        await within(owned.ended, Math.min(25, Math.max(0, deadline - Date.now())))
      }
    } catch (error) {
      try {
        await this.stop(home, true)
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'test daemon readiness and cleanup failed')
      }
      throw error
    }
  }

  async stop(home: string, force = false): Promise<boolean> {
    const owned = this.children.get(home)
    if (!owned) return false
    owned.stopping ??= (async () => {
      if (owned.child.pid === undefined || exited(owned.child)) return
      owned.child.kill(force ? 'SIGKILL' : 'SIGTERM')
      if (await within(owned.ended, 1000)) return
      owned.child.kill('SIGKILL')
      if (!(await within(owned.ended, 1000)))
        throw new Error('test daemon did not exit after SIGKILL')
    })()
    await owned.stopping
    if (this.children.get(home) === owned) this.children.delete(home)
    return true
  }
}
