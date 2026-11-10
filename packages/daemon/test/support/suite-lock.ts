import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

export const suiteLockFile = path.join(homedir(), '.cache', 'ted', 'test-suite.lock')
export const heldLockEnv = 'TED_TEST_SUITE_LOCK_PID'
export const smallRunFiles = 10
export const slotDir = path.join(homedir(), '.cache', 'ted', 'test-slots')
export const testSlots = 2

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

async function tryTake(
  file: string,
  pid: number,
): Promise<'taken' | 'retry' | 'unwritable' | number> {
  const error = await writeFile(file, `${pid}\n`, { flag: 'wx' }).then(
    () => undefined,
    (thrown: NodeJS.ErrnoException) => thrown,
  )
  if (error && error.code !== 'EEXIST') return 'unwritable'
  const current = error ? await holder(file) : pid
  if (current === pid) {
    await sleep(50)
    return (await holder(file)) === pid ? 'taken' : 'retry'
  }
  if (current === undefined) {
    await sleep(100)
    if ((await holder(file)) === undefined) await unlink(file).catch(() => undefined)
    return 'retry'
  }
  if (!pidAlive(current)) {
    if ((await holder(file)) === current) await unlink(file).catch(() => undefined)
    return 'retry'
  }
  return current
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
    const result = await tryTake(file, pid)
    if (result === 'taken') return release
    if (result === 'unwritable') throw new Error(`can’t write the test lock ${file}`)
    if (result === 'retry') continue
    if (result !== reported) {
      reported = result
      options.onWait?.(result)
    }
    await sleep(pollMs)
  }
}

export interface SlotOptions {
  dir?: string
  slots?: number
  suiteLock?: string
  pid?: number
  pollMs?: number
  onWait?: (holder: number) => void
}

const slotFile = (dir: string, index: number) => path.join(dir, `${index}.lock`)

export async function acquireFullRun(options: SlotOptions = {}): Promise<() => Promise<void>> {
  const dir = options.dir ?? slotDir
  const { pid, pollMs, onWait } = options
  const shared = { ...(pid && { pid }), ...(pollMs && { pollMs }), ...(onWait && { onWait }) }
  const releases = [await acquireSuiteLock({ file: options.suiteLock ?? suiteLockFile, ...shared })]
  for (let index = 0; index < (options.slots ?? testSlots); index++) {
    releases.push(await acquireSuiteLock({ file: slotFile(dir, index), ...shared }))
  }
  return async () => {
    for (const release of releases.reverse()) await release()
  }
}

export async function acquireSlot(
  options: SlotOptions = {},
): Promise<(() => Promise<void>) | undefined> {
  const dir = options.dir ?? slotDir
  const slots = options.slots ?? testSlots
  const suiteLock = options.suiteLock ?? suiteLockFile
  const pid = options.pid ?? process.pid
  const made = await mkdir(dir, { recursive: true }).then(
    () => true,
    () => false,
  )
  if (!made) return undefined
  let reported = false
  for (;;) {
    let waitsFor = await holder(suiteLock)
    if (waitsFor === pid || (waitsFor !== undefined && !pidAlive(waitsFor))) waitsFor = undefined
    for (let index = 0; waitsFor === undefined && index < slots; index++) {
      const file = slotFile(dir, index)
      let result = await tryTake(file, pid)
      while (result === 'retry') result = await tryTake(file, pid)
      if (result === 'unwritable') return undefined
      if (result === 'taken') {
        return async () => {
          if ((await holder(file)) === pid) await unlink(file).catch(() => undefined)
        }
      }
      if (index === slots - 1) waitsFor = result
    }
    if (waitsFor !== undefined && !reported) {
      reported = true
      options.onWait?.(waitsFor)
    }
    await sleep(options.pollMs ?? 500)
  }
}

export function waitingMessage(pid: number): string {
  return `Waiting for another TED test run (pid ${pid}) to finish…`
}

export async function lockRun(
  fileCount: number,
  options: SlotOptions = {},
): Promise<(() => Promise<void>) | undefined> {
  const held = Number(process.env[heldLockEnv])
  if (held && (await holder(options.suiteLock ?? suiteLockFile)) === held) return undefined
  const onWait = (pid: number) => console.log(waitingMessage(pid))
  if (fileCount >= smallRunFiles) return acquireFullRun({ onWait, ...options })
  const release = await acquireSlot({ onWait, ...options })
  if (!release)
    console.warn('Running without a TED test slot: can’t write ~/.cache/ted/test-slots.')
  return release
}
