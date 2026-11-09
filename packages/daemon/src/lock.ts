import { open, readFile, rm } from 'node:fs/promises'

export class DaemonAlreadyRunningError extends Error {
  readonly pid: number
  constructor(pid: number) {
    super(`TED's daemon is already running (pid ${pid})`)
    this.pid = pid
  }
}

export async function acquireLock(lockPath: string): Promise<{ release(): Promise<void> }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(lockPath, 'wx', 0o600)
      await file.writeFile(String(process.pid))
      await file.close()
      return { release: () => rm(lockPath, { force: true }) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const pid = Number(await readFile(lockPath, 'utf8').catch(() => ''))
    if (isAlive(pid)) throw new DaemonAlreadyRunningError(pid)
    await rm(lockPath, { force: true })
  }
  throw new Error(`could not take ${lockPath}`)
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
