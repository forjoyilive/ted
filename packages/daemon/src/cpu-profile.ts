import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Worker } from 'node:worker_threads'
import type { ProfileResult } from '@ted/protocol'
import { displayPath } from './backups.ts'
import { RequestError } from './errors.ts'

export interface CpuProfiler {
  record(seconds: number): Promise<ProfileResult>
  close(): void
}

export interface StallProfiles {
  stallMs?: number
  startAfterMs?: number
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
  let watch: ReturnType<typeof watchStalls> | undefined
  try {
    watch = stalls && watchStalls(home, stalls)
  } catch (error) {
    console.warn('the stall watch couldn’t start:', error)
  }
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

// Plain JavaScript run in a worker thread, so it works from source and from the staged build.
// It hears a beat from the daemon’s thread; when the beats stop it profiles that thread through
// the inspector and, when they come back, posts the profile and how long they were missing.
const watchdog = `
const { parentPort, workerData } = require('node:worker_threads')
const { Session } = require('node:inspector/promises')
const { tickMs, startAfterMs, samplingMicros } = workerData
let beat = Date.now()
let tick = Date.now()
let paused = false
let session
let busy = false
let owesAck = false
parentPort.on('message', (message) => {
  if (message === 'beat') beat = Date.now()
  else if (message === 'pause') {
    paused = true
    owesAck = true
  } else if (message === 'resume') paused = false
})
async function start() {
  const next = new Session()
  next.connectToMainThread()
  try {
    await next.post('Profiler.enable')
    await next.post('Profiler.setSamplingInterval', { interval: samplingMicros })
    await next.post('Profiler.start')
  } catch (error) {
    next.disconnect()
    throw error
  }
  session = next
}
async function stop(ms) {
  const current = session
  session = undefined
  try {
    const { profile } = await current.post('Profiler.stop')
    parentPort.postMessage({ ms, profile: JSON.stringify(profile) })
  } finally {
    current.disconnect()
  }
}
let since = 0
const report = (error) => parentPort.postMessage({ error: String((error && error.message) || error) })
setInterval(() => {
  const now = Date.now()
  const slept = now - tick > tickMs + 2000
  tick = now
  if (slept) beat = now
  if (busy) return
  const quiet = now - beat
  if (!session && !paused && quiet >= startAfterMs) {
    busy = true
    since = beat
    start().catch(report).finally(() => { busy = false })
  } else if (session && (quiet < startAfterMs || paused)) {
    busy = true
    stop(slept || paused ? 0 : beat - since).catch(report).finally(() => { busy = false })
  } else if (paused && owesAck) {
    owesAck = false
    parentPort.postMessage({ paused: true })
  }
}, tickMs)
`

interface Watched {
  ms?: number
  profile?: string
  error?: string
  paused?: boolean
}

// ADR 0124: when the daemon’s thread stops answering, a worker thread profiles it until it
// answers again, and a stall of `stallMs` or more is saved. Nothing runs while the daemon
// is healthy: keeping the profiler on all the time made CPU-bound work several times slower.
function watchStalls(home: string, options: StallProfiles) {
  const stallMs = options.stallMs ?? 5_000
  const tickMs = options.tickMs ?? 250
  const log = options.log ?? ((line: string) => console.warn(line))
  let closed = false
  let saving: Promise<void> = Promise.resolve()
  const worker = new Worker(watchdog, {
    eval: true,
    workerData: {
      tickMs,
      startAfterMs: options.startAfterMs ?? 2_000,
      samplingMicros: stallSamplingMicros,
    },
  })
  let onPaused: (() => void) | undefined
  worker.on('error', (error) => log(`the stall watch stopped: ${error.message}`))
  worker.on('message', (message: Watched) => {
    if (message.paused) {
      onPaused?.()
      return
    }
    if (closed) return
    if (message.error !== undefined) {
      log(`couldn’t profile a stall: ${message.error}`)
      return
    }
    const { ms = 0, profile } = message
    if (profile === undefined || ms < stallMs) return
    saving = saving
      .then(async () => {
        if (closed) return
        const dir = await profilesDir(home)
        const name = `stall-${stamp(new Date())}.cpuprofile`
        // Written under another name first: the daemon may exit in the middle of the write.
        const partial = path.join(dir, 'stall.partial')
        await unlink(partial).catch(() => undefined)
        await save(partial, profile)
        await rename(partial, path.join(dir, name))
        await prune(dir, stallName)
        log(
          `event loop blocked for ${ms} ms; a CPU profile of it is in ${displayPath(path.join(home, 'logs', 'profiles', name))}`,
        )
      })
      .catch((error: unknown) =>
        log(`couldn’t save a stall’s profile: ${error instanceof Error ? error.message : error}`),
      )
  })
  // After the listeners: adding one makes the worker keep the process alive again.
  worker.unref()
  const timer = setInterval(() => worker.postMessage('beat'), tickMs)
  timer.unref()
  return {
    async pause() {
      const stopped = new Promise<void>((resolve) => {
        onPaused = resolve
      })
      worker.postMessage('pause')
      await Promise.race([stopped, sleep(5_000, undefined, { ref: false })])
      onPaused = undefined
    },
    resume() {
      worker.postMessage('resume')
    },
    close() {
      closed = true
      clearInterval(timer)
      void worker.terminate()
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
