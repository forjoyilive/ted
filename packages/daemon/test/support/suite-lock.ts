import { appendFile, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

export const suiteLockFile = path.join(homedir(), '.cache', 'ted', 'test-suite.lock')
export const heldLockEnv = 'TED_TEST_SUITE_LOCK_PID'
export const smallRunFiles = 10
export const runTestFiles = 3
export const slotDir = path.join(homedir(), '.cache', 'ted', 'test-slots')
export const testSlots = 2
export const fullRunYieldMs = 5 * 60_000
export const waitLogName = 'test-waits.jsonl'

export type RunKind = 'full' | 'small'

export interface WaitRecord {
  event: 'start' | 'end'
  at: string
  pid: number
  kind: RunKind
  files?: number
  cwd: string
  task?: string
  waitedMs: number
  heldMs?: number
}

const logFor = (dir: string) => path.join(path.dirname(dir), waitLogName)

async function record(log: string, entry: WaitRecord): Promise<void> {
  await appendFile(log, `${JSON.stringify(entry)}\n`).catch(() => undefined)
}

function logged(
  log: string,
  run: { pid: number; kind: RunKind; files: number | undefined; asked: number },
  release: () => Promise<void>,
): () => Promise<void> {
  const started = Date.now()
  const entry = {
    pid: run.pid,
    kind: run.kind,
    ...(run.files !== undefined && { files: run.files }),
    cwd: process.cwd(),
    ...(process.env.TED_TASK && { task: process.env.TED_TASK }),
    waitedMs: started - run.asked,
  }
  const start = record(log, { event: 'start', at: new Date(started).toISOString(), ...entry })
  return async () => {
    await release()
    await start
    const ended = Date.now()
    await record(log, {
      event: 'end',
      at: new Date(ended).toISOString(),
      ...entry,
      heldMs: ended - started,
    })
  }
}

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
  yieldMs?: number
  files?: number
  log?: string
  onWait?: (holder: number) => void
}

const slotFile = (dir: string, index: number) => path.join(dir, `${index}.lock`)

// Each waiting run holds a ticket in <slot folder>/queue, named <time asked>-<pid>-<kind>.
// A run waits behind the earlier tickets of its own kind. A ticket without a kind comes
// from a checkout with the older lock code, and every run waits behind an earlier one.
interface Queue {
  ahead(): Promise<number | undefined>
  smallBefore(time: number): Promise<number | undefined>
  leave(): Promise<void>
}

async function joinQueue(dir: string, pid: number, kind: RunKind): Promise<Queue | undefined> {
  const queue = path.join(dir, 'queue')
  const ticket = `${String(Date.now()).padStart(15, '0')}-${pid}-${kind}`
  const written = await mkdir(queue, { recursive: true })
    .then(() => writeFile(path.join(queue, ticket), ''))
    .then(
      () => true,
      () => false,
    )
  if (!written) return undefined
  const others = async () => {
    const live: { name: string; asked: number; pid: number; kind: string | undefined }[] = []
    for (const name of (await readdir(queue).catch(() => [])).sort()) {
      const [asked, holder, itsKind] = name.split('-')
      const other = Number(holder)
      if (other === pid) continue
      if (Number.isInteger(other) && other > 0 && pidAlive(other))
        live.push({ name, asked: Number(asked), pid: other, kind: itsKind })
      else await unlink(path.join(queue, name)).catch(() => undefined)
    }
    return live
  }
  const passes = kind === 'full' ? 'small' : 'full'
  return {
    async ahead() {
      return (await others()).find((other) => other.name < ticket && other.kind !== passes)?.pid
    },
    async smallBefore(time) {
      const live = await others()
      if (live.some((other) => other.kind !== 'full' && other.kind !== 'small')) return undefined
      return live.find((other) => other.kind === 'small' && other.asked < time)?.pid
    },
    leave: () => unlink(path.join(queue, ticket)).catch(() => undefined),
  }
}

async function untilFirst(
  queue: Queue | undefined,
  pollMs: number,
  onWait?: (holder: number) => void,
): Promise<void> {
  let reported: number | undefined
  for (;;) {
    const ahead = await queue?.ahead()
    if (ahead === undefined) return
    if (ahead !== reported) {
      reported = ahead
      onWait?.(ahead)
    }
    await sleep(pollMs)
  }
}

// A full run whose turn has come lets the small runs that were already waiting go first,
// for at most yieldMs. Small runs that ask later wait for it, so it can't be starved.
async function letSmallRunsGo(
  queue: Queue | undefined,
  options: {
    suiteLock: string
    pid: number
    pollMs: number
    yieldMs: number
    onWait: ((holder: number) => void) | undefined
  },
): Promise<void> {
  if (!queue) return
  let turn: number | undefined
  let reported: number | undefined
  for (;;) {
    const running = await holder(options.suiteLock)
    let waitsFor: number | undefined
    if (running !== undefined && running !== options.pid && pidAlive(running)) {
      turn = undefined
      waitsFor = running
    } else {
      turn ??= Date.now()
      if (Date.now() - turn >= options.yieldMs) return
      waitsFor = await queue.smallBefore(turn)
      if (waitsFor === undefined) return
    }
    if (waitsFor !== reported) {
      reported = waitsFor
      options.onWait?.(waitsFor)
    }
    await sleep(options.pollMs)
  }
}

export async function acquireFullRun(options: SlotOptions = {}): Promise<() => Promise<void>> {
  const dir = options.dir ?? slotDir
  const { pid, pollMs, onWait } = options
  const shared = { ...(pid && { pid }), ...(pollMs && { pollMs }), ...(onWait && { onWait }) }
  const suiteLock = options.suiteLock ?? suiteLockFile
  const me = pid ?? process.pid
  const asked = Date.now()
  const again = (await holder(suiteLock)) === me
  const queue = again ? undefined : await joinQueue(dir, me, 'full')
  const releases: (() => Promise<void>)[] = []
  try {
    await untilFirst(queue, pollMs ?? 2_000, onWait)
    await letSmallRunsGo(queue, {
      suiteLock,
      pid: me,
      pollMs: pollMs ?? 2_000,
      yieldMs: options.yieldMs ?? fullRunYieldMs,
      onWait,
    })
    releases.push(await acquireSuiteLock({ file: suiteLock, ...shared }))
    for (let index = 0; index < (options.slots ?? testSlots); index++) {
      releases.push(await acquireSuiteLock({ file: slotFile(dir, index), ...shared }))
    }
  } finally {
    await queue?.leave()
  }
  const release = async () => {
    for (const held of releases.reverse()) await held()
  }
  if (again) return release
  const run = { pid: me, kind: 'full' as const, files: options.files, asked }
  return logged(options.log ?? logFor(dir), run, release)
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
  const releaseOf = (file: string) => async () => {
    if ((await holder(file)) === pid) await unlink(file).catch(() => undefined)
  }
  for (let index = 0; index < slots; index++) {
    if ((await holder(slotFile(dir, index))) === pid) return releaseOf(slotFile(dir, index))
  }
  let reported = false
  const asked = Date.now()
  const taken = (file: string) =>
    logged(
      options.log ?? logFor(dir),
      { pid, kind: 'small', files: options.files, asked },
      releaseOf(file),
    )
  const queue = await joinQueue(dir, pid, 'small')
  try {
    for (;;) {
      let waitsFor = await queue?.ahead()
      if (waitsFor === undefined) {
        waitsFor = await holder(suiteLock)
        if (waitsFor === pid || (waitsFor !== undefined && !pidAlive(waitsFor)))
          waitsFor = undefined
      }
      for (let index = 0; waitsFor === undefined && index < slots; index++) {
        const file = slotFile(dir, index)
        let result = await tryTake(file, pid)
        while (result === 'retry') result = await tryTake(file, pid)
        if (result === 'unwritable') return undefined
        if (result === 'taken') return taken(file)
        if (index === slots - 1) waitsFor = result
      }
      if (waitsFor !== undefined && !reported) {
        reported = true
        options.onWait?.(waitsFor)
      }
      await sleep(options.pollMs ?? 500)
    }
  } finally {
    await queue?.leave()
  }
}

export function waitingMessage(pid: number): string {
  return `Waiting for another TED test run (pid ${pid}) to finish…`
}

export function runRefusal(
  fileCount: number,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (fileCount <= runTestFiles || !env.TED_RUN) return undefined
  return `A Run can’t start a test run of ${fileCount} files: its limit is ${runTestFiles}, because every test run makes other Runs wait. Run only the test files your change touches, in Validate: pnpm vitest run <files>. The human or a merge runs the rest.`
}

export async function lockRun(
  fileCount: number,
  options: SlotOptions = {},
): Promise<(() => Promise<void>) | undefined> {
  const refusal = runRefusal(fileCount)
  if (refusal) throw new Error(refusal)
  const held = Number(process.env[heldLockEnv])
  if (held) {
    if ((await holder(options.suiteLock ?? suiteLockFile)) === held) return undefined
    if (fileCount < smallRunFiles) {
      for (let index = 0; index < (options.slots ?? testSlots); index++) {
        if ((await holder(slotFile(options.dir ?? slotDir, index))) === held) return undefined
      }
    }
  }
  const onWait = (pid: number) => console.log(waitingMessage(pid))
  if (fileCount >= smallRunFiles) return acquireFullRun({ onWait, files: fileCount, ...options })
  const release = await acquireSlot({ onWait, files: fileCount, ...options })
  if (!release)
    console.warn('Running without a TED test slot: can’t write ~/.cache/ted/test-slots.')
  return release
}
