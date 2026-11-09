import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

export const suiteLockFile = path.join(homedir(), '.cache', 'ted', 'test-suite.lock')
export const heldLockEnv = 'TED_TEST_SUITE_LOCK_PID'
export const smallRunFiles = 10

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function holder(file: string): Promise<number | undefined> {
  const text = await readFile(file, 'utf8').catch(() => undefined)
  const pid = Number(text?.trim())
  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

export interface SuiteLockOptions {
  file?: string
  pid?: number
  pollMs?: number
  onWait?: (holder: number) => void
}

export async function acquireSuiteLock(
  options: SuiteLockOptions = {},
): Promise<() => Promise<void>> {
  const file = options.file ?? suiteLockFile
  const pid = options.pid ?? process.pid
  const pollMs = options.pollMs ?? 2_000
  const release = async () => {
    if ((await holder(file)) === pid) await unlink(file).catch(() => undefined)
  }
  await mkdir(path.dirname(file), { recursive: true })
  let reported: number | undefined
  for (;;) {
    const created = await writeFile(file, `${pid}\n`, { flag: 'wx' }).then(
      () => true,
      () => false,
    )
    const current = created ? pid : await holder(file)
    if (current === pid) {
      await sleep(50)
      if ((await holder(file)) === pid) return release
      continue
    }
    if (current === undefined) {
      await sleep(100)
      if ((await holder(file)) === undefined) await unlink(file).catch(() => undefined)
      continue
    }
    if (!pidAlive(current)) {
      if ((await holder(file)) === current) await unlink(file).catch(() => undefined)
      continue
    }
    if (current !== reported) {
      reported = current
      options.onWait?.(current)
    }
    await sleep(pollMs)
  }
}

export function waitingMessage(pid: number): string {
  return `Waiting for another TED test run (pid ${pid}) to finish…`
}

export async function lockFullRun(fileCount: number): Promise<(() => Promise<void>) | undefined> {
  if (fileCount < smallRunFiles) return undefined
  const held = Number(process.env[heldLockEnv])
  if (held && (await holder(suiteLockFile)) === held) return undefined
  return acquireSuiteLock({ onWait: (pid) => console.log(waitingMessage(pid)) })
}
