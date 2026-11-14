import { appendFile, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

export function testCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const cache = env.XDG_CACHE_HOME
  const sandboxed = env.TED_SANDBOX === '1' && cache?.startsWith('/') === true
  return path.join(sandboxed && cache ? cache : path.join(homedir(), '.cache'), 'ted')
}

export const suiteLockFile = path.join(testCacheDir(), 'test-suite.lock')
export const heldLockEnv = 'TED_TEST_SUITE_LOCK_PID'
export const smallRunFiles = 10
export const runTestFiles = 3
export const slotDir = path.join(testCacheDir(), 'test-slots')
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
  onContention?: (waiting: boolean, at: number) => void
  signal?: AbortSignal
}

function contention(options: Pick<SuiteLockOptions, 'onContention'>) {
  let waiting = false
  return (next: boolean) => {
    if (waiting === next) return
    waiting = next
    try {
      options.onContention?.(next, Date.now())
    } catch {}
  }
}

async function tryTake(
  file: string,
  pid: number,
  onFree?: () => void,
): Promise<'taken' | 'retry' | 'unwritable' | number> {
  const error = await writeFile(file, `${pid}\n`, { flag: 'wx' }).then(
    () => undefined,
    (thrown: NodeJS.ErrnoException) => thrown,
  )
  if (error && error.code !== 'EEXIST') return 'unwritable'
  const current = error ? await holder(file) : pid
  if (current === pid) {
    onFree?.()
    await sleep(50)
    return (await holder(file)) === pid ? 'taken' : 'retry'
  }
  if (current === undefined) {
    onFree?.()
    await sleep(100)
    if ((await holder(file)) === undefined) await unlink(file).catch(() => undefined)
    return 'retry'
  }
  if (!pidAlive(current)) {
    onFree?.()
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
  const observe = contention(options)
  for (;;) {
    options.signal?.throwIfAborted()
    const result = await tryTake(file, pid, () => observe(false))
    if (result === 'taken') {
      if (options.signal?.aborted) {
        await release()
        options.signal.throwIfAborted()
      }
      observe(false)
      return release
    }
    if (result === 'unwritable') throw new Error(`can’t write the test lock ${file}`)
    if (result === 'retry') {
      observe(false)
      continue
    }
    observe(true)
    if (result !== reported) {
      reported = result
      options.onWait?.(result)
    }
    await sleep(pollMs, undefined, { signal: options.signal })
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
  onContention?: (waiting: boolean, at: number) => void
  signal?: AbortSignal
}

const slotFile = (dir: string, index: number) => path.join(dir, `${index}.lock`)

// Each waiting run holds a ticket in <slot folder>/queue, named <time asked>-<pid>-<kind>.
// A run waits behind the earlier tickets of its own kind. A ticket without a kind comes
// from a checkout with the older lock code, and every run waits behind an earlier one.
// A full run letting small runs go first adds the time its turn came as a fourth part,
// and small runs that asked at or after that time wait for it.
interface Queue {
  ahead(): Promise<number | undefined>
  smallBefore(time: number): Promise<number | undefined>
  turn(time: number | undefined): Promise<void>
  leave(): Promise<void>
}

async function joinQueue(dir: string, pid: number, kind: RunKind): Promise<Queue | undefined> {
  const queue = path.join(dir, 'queue')
  const asked = Date.now()
  const first = `${String(asked).padStart(15, '0')}-${pid}-${kind}`
  let ticket = first
  const written = await mkdir(queue, { recursive: true })
    .then(() => writeFile(path.join(queue, ticket), ''))
    .then(
      () => true,
      () => false,
    )
  if (!written) return undefined
  const others = async () => {
    const live: {
      name: string
      asked: number
      pid: number
      kind: string | undefined
      turn: number | undefined
    }[] = []
    for (const name of (await readdir(queue).catch(() => [])).sort()) {
      const [itsAsked, holder, itsKind, itsTurn] = name.split('-')
      const other = Number(holder)
      if (other === pid) continue
      if (Number.isInteger(other) && other > 0 && pidAlive(other))
        live.push({
          name,
          asked: Number(itsAsked),
          pid: other,
          kind: itsKind,
          turn: itsTurn === undefined ? undefined : Number(itsTurn),
        })
      else await unlink(path.join(queue, name)).catch(() => undefined)
    }
    return live
  }
  const passes = kind === 'full' ? 'small' : 'full'
  return {
    async ahead() {
      return (await others()).find(
        (other) =>
          (other.name < first && other.kind !== passes) ||
          (kind === 'small' &&
            other.kind === 'full' &&
            other.turn !== undefined &&
            other.turn <= asked),
      )?.pid
    },
    async smallBefore(time) {
      const live = await others()
      if (live.some((other) => other.kind !== 'full' && other.kind !== 'small')) return undefined
      return live.find((other) => other.kind === 'small' && other.asked < time)?.pid
    },
    async turn(time) {
      const next = time === undefined ? first : `${first}-${time}`
      if (next === ticket) return
      const made = await writeFile(path.join(queue, next), '').then(
        () => true,
        () => false,
      )
      if (!made) return
      await unlink(path.join(queue, ticket)).catch(() => undefined)
      ticket = next
    },
    leave: () => unlink(path.join(queue, ticket)).catch(() => undefined),
  }
}

async function untilFirst(
  queue: Queue | undefined,
  pollMs: number,
  onWait?: (holder: number) => void,
  options: SuiteLockOptions = {},
): Promise<void> {
  const observe = contention(options)
  let reported: number | undefined
  for (;;) {
    options.signal?.throwIfAborted()
    const ahead = await queue?.ahead()
    if (ahead === undefined) {
      observe(false)
      return
    }
    observe(true)
    if (ahead !== reported) {
      reported = ahead
      onWait?.(ahead)
    }
    await sleep(pollMs, undefined, { signal: options.signal })
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
    onContention?: (waiting: boolean, at: number) => void
    signal?: AbortSignal
  },
): Promise<void> {
  if (!queue) return
  const observe = contention(options)
  let turn: number | undefined
  let reported: number | undefined
  for (;;) {
    options.signal?.throwIfAborted()
    const running = await holder(options.suiteLock)
    let waitsFor: number | undefined
    if (running !== undefined && running !== options.pid && pidAlive(running)) {
      turn = undefined
      await queue.turn(undefined)
      waitsFor = running
    } else {
      turn ??= Date.now()
      await queue.turn(turn)
      if (Date.now() - turn >= options.yieldMs) {
        observe(false)
        return
      }
      waitsFor = await queue.smallBefore(turn)
      if (waitsFor === undefined) {
        observe(false)
        return
      }
    }
    observe(true)
    if (waitsFor !== reported) {
      reported = waitsFor
      options.onWait?.(waitsFor)
    }
    await sleep(options.pollMs, undefined, { signal: options.signal })
  }
}

export async function acquireFullRun(options: SlotOptions = {}): Promise<() => Promise<void>> {
  const dir = options.dir ?? slotDir
  const { pid, pollMs, onWait } = options
  const shared = {
    ...(pid && { pid }),
    ...(pollMs && { pollMs }),
    ...(onWait && { onWait }),
    ...(options.onContention && { onContention: options.onContention }),
    ...(options.signal && { signal: options.signal }),
  }
  const suiteLock = options.suiteLock ?? suiteLockFile
  const me = pid ?? process.pid
  const asked = Date.now()
  const again = (await holder(suiteLock)) === me
  const queue = again ? undefined : await joinQueue(dir, me, 'full')
  const releases: (() => Promise<void>)[] = []
  try {
    await untilFirst(queue, pollMs ?? 2_000, onWait, shared)
    await letSmallRunsGo(queue, {
      suiteLock,
      pid: me,
      pollMs: pollMs ?? 2_000,
      yieldMs: options.yieldMs ?? fullRunYieldMs,
      onWait,
      ...(options.onContention && { onContention: options.onContention }),
      ...(options.signal && { signal: options.signal }),
    })
    releases.push(await acquireSuiteLock({ file: suiteLock, ...shared }))
    for (let index = 0; index < (options.slots ?? testSlots); index++) {
      releases.push(await acquireSuiteLock({ file: slotFile(dir, index), ...shared }))
    }
  } catch (error) {
    for (const held of releases.reverse()) await held()
    throw error
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
  const observe = contention(options)
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
      options.signal?.throwIfAborted()
      let waitsFor = await queue?.ahead()
      if (waitsFor === undefined) {
        waitsFor = await holder(suiteLock)
        if (waitsFor === pid || (waitsFor !== undefined && !pidAlive(waitsFor)))
          waitsFor = undefined
      }
      for (let index = 0; waitsFor === undefined && index < slots; index++) {
        const file = slotFile(dir, index)
        let result = await tryTake(file, pid, () => observe(false))
        while (result === 'retry') result = await tryTake(file, pid, () => observe(false))
        if (result === 'unwritable') return undefined
        if (result === 'taken') {
          if (options.signal?.aborted) {
            await releaseOf(file)()
            options.signal.throwIfAborted()
          }
          observe(false)
          return taken(file)
        }
        if (index === slots - 1) waitsFor = result
      }
      observe(waitsFor !== undefined)
      if (waitsFor !== undefined && !reported) {
        reported = true
        options.onWait?.(waitsFor)
      }
      await sleep(options.pollMs ?? 500, undefined, { signal: options.signal })
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
  if (await inheritedLock(fileCount, options)) return undefined
  const onWait = (pid: number) => console.log(waitingMessage(pid))
  if (fileCount >= smallRunFiles) return acquireFullRun({ onWait, files: fileCount, ...options })
  const release = await acquireSlot({ onWait, files: fileCount, ...options })
  if (!release)
    console.warn(
      `Running without a TED test slot: can’t write ${(options.dir ?? slotDir).replace(homedir(), '~')}.`,
    )
  return release
}

export async function inheritedLock(
  fileCount: number,
  options: SlotOptions = {},
): Promise<boolean> {
  const held = Number(process.env[heldLockEnv])
  if (held) {
    if ((await holder(options.suiteLock ?? suiteLockFile)) === held) return true
    if (fileCount < smallRunFiles) {
      for (let index = 0; index < (options.slots ?? testSlots); index++) {
        if ((await holder(slotFile(options.dir ?? slotDir, index))) === held) return true
      }
    }
  }
  return false
}
