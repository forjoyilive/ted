import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { ProfileResult } from '@ted/protocol'
import { displayPath } from './backups.ts'
import { RequestError } from './errors.ts'

export interface CpuProfiler {
  record(seconds: number): Promise<ProfileResult>
  close(): void
}

export interface StallProfiles {
  stallMs?: number
  windowMs?: number
  tickMs?: number
  log?: (line: string) => void
}

export const profilesKept = 5

const samplingMicros = 1000
const profileName = /^daemon-\d{8}-\d{6}\.cpuprofile$/
const stallName = /^stall-\d{8}-\d{6}\.cpuprofile$/
const stallSamplingMicros = 10_000

export function createCpuProfiler(home: string, stalls?: StallProfiles): CpuProfiler {
  let running: AbortController | undefined
  const watch = stalls && watchStalls(home, stalls)
  return {
    async record(seconds) {
      if (running) throw new RequestError(409, 'TED is already recording a CPU profile')
      const stop = new AbortController()
      running = stop
      try {
        await watch?.pause()
        await profilesDir(home)
        const text = await sample(seconds, stop.signal)
        const name = `daemon-${stamp(new Date())}.cpuprofile`
        await save(path.join(await profilesDir(home), name), text)
        await prune(await profilesDir(home))
        return {
          file: displayPath(path.join(home, 'logs', 'profiles', name)),
          seconds,
          bytes: Buffer.byteLength(text),
        }
      } finally {
        running = undefined
        watch?.resume()
      }
    },
    close() {
      running?.abort()
      watch?.close()
    },
  }
}

type Session = Awaited<ReturnType<typeof connect>>

// ADR 0124: keeps a coarse profile of the last minute and saves it when the event loop was
// blocked for `stallMs` or more, so a freeze names the code that caused it. The sampler runs
// on V8’s own thread, so it keeps sampling while the loop is blocked.
function watchStalls(home: string, options: StallProfiles) {
  const stallMs = options.stallMs ?? 5_000
  const windowMs = options.windowMs ?? 60_000
  const tickMs = options.tickMs ?? 1_000
  const log = options.log ?? ((line: string) => console.warn(line))
  let session: Session | undefined
  let startedAt = 0
  let lastTick = Date.now()
  let closed = false
  let paused = false
  let work: Promise<void> = Promise.resolve()
  const queue = (step: () => Promise<void>) => {
    work = work.then(step).catch((error: unknown) => {
      session?.disconnect()
      session = undefined
      log(`couldn’t keep a profile for stalls: ${error instanceof Error ? error.message : error}`)
    })
    return work
  }
  const start = async () => {
    if (closed || paused || session) return
    const next = await connect()
    await next.post('Profiler.enable')
    await next.post('Profiler.setSamplingInterval', { interval: stallSamplingMicros })
    await next.post('Profiler.start')
    session = next
    startedAt = Date.now()
  }
  const stop = async (keep?: number) => {
    const current = session
    if (!current) return
    session = undefined
    try {
      const { profile } = await current.post('Profiler.stop')
      if (keep === undefined) return
      const dir = await profilesDir(home)
      const name = `stall-${stamp(new Date())}.cpuprofile`
      await save(path.join(dir, name), JSON.stringify(profile))
      await prune(dir, stallName)
      log(
        `event loop blocked for ${keep} ms; a CPU profile of it is in ${displayPath(path.join(home, 'logs', 'profiles', name))}`,
      )
    } finally {
      current.disconnect()
    }
  }
  const timer = setInterval(() => {
    const now = Date.now()
    const late = now - lastTick - tickMs
    lastTick = now
    // A machine that slept looks like one very long stall; that profile is thrown away.
    if (late >= stallMs && late < 10 * 60_000) void queue(() => stop(late)).then(() => queue(start))
    else if (session && now - startedAt >= windowMs)
      void queue(() => stop()).then(() => queue(start))
  }, tickMs)
  timer.unref()
  void queue(start)
  return {
    pause() {
      paused = true
      return queue(() => stop())
    },
    resume() {
      paused = false
      lastTick = Date.now()
      void queue(start)
    },
    close() {
      closed = true
      clearInterval(timer)
      void queue(() => stop())
    },
  }
}

async function sample(seconds: number, signal: AbortSignal): Promise<string> {
  const session = await connect()
  try {
    await session.post('Profiler.enable')
    await session.post('Profiler.setSamplingInterval', { interval: samplingMicros })
    await session.post('Profiler.start')
    await sleep(seconds * 1000, undefined, { signal, ref: false }).catch(() => undefined)
    const { profile } = await session.post('Profiler.stop')
    if (signal.aborted) throw new RequestError(503, 'TED stopped before the profile finished')
    return JSON.stringify(profile)
  } catch (error) {
    if (error instanceof RequestError) throw error
    throw unavailable(error)
  } finally {
    session.disconnect()
  }
}

async function connect() {
  try {
    const { Session } = await import('node:inspector/promises')
    const session = new Session()
    session.connect()
    return session
  } catch (error) {
    throw unavailable(error)
  }
}

function unavailable(error: unknown): RequestError {
  const reason = error instanceof Error ? error.message : String(error)
  return new RequestError(501, `This build of TED can’t record a CPU profile: ${reason}`)
}

async function profilesDir(home: string): Promise<string> {
  let current = await realpath(home)
  for (const name of ['logs', 'profiles']) {
    current = path.join(current, name)
    await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
    const info = await lstat(current)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new RequestError(
        409,
        `${displayPath(current)} isn’t a plain folder, so TED won’t save a profile there`,
      )
    }
  }
  return current
}

async function save(file: string, text: string): Promise<void> {
  const handle = await open(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    await handle.writeFile(text)
  } catch (error) {
    await unlink(file).catch(() => undefined)
    throw error
  } finally {
    await handle.close()
  }
}

async function prune(dir: string, pattern = profileName): Promise<void> {
  const names = (await readdir(dir)).filter((name) => pattern.test(name)).sort()
  for (const name of names.slice(0, -profilesKept)) {
    const file = path.join(dir, name)
    const info = await lstat(file).catch(() => undefined)
    if (info?.isFile()) await unlink(file).catch(() => undefined)
  }
}

function stamp(date: Date): string {
  return date
    .toISOString()
    .replace(/\.\d+Z$/, '')
    .replace(/[-:]/g, '')
    .replace('T', '-')
}
