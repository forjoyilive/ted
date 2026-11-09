import { spawn } from 'node:child_process'
import { closeSync, fstatSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { watchExitWith } from '../exit-with.ts'
import { waitForLock } from '../lock.ts'
import { type AppHostRecord, type AppLaunchFile, appFiles } from './host-files.ts'

const dir = process.argv[2]
if (!dir) throw new Error('usage: apps/host.ts <app-dir>')
delete process.env.ELECTRON_RUN_AS_NODE
const files = appFiles(dir)
const lock = await waitForLock(files.lock, 2_000)
if (!lock) throw new Error(`another host already runs ${dir}`)
const launch = JSON.parse(readFileSync(files.launch, 'utf8')) as AppLaunchFile
const records = openSync(files.records, 'a', 0o600)
const record = (r: AppHostRecord) => writeSync(records, `${JSON.stringify(r)}\n`)
const segmentBytes = Math.max(1024, Math.floor(launch.logBytes / 2))

let log = openSync(files.log, 'a', 0o600)
let logged = fstatSync(log).size
const writeLog = (chunk: Buffer) => {
  let rest = chunk.subarray(Math.max(0, chunk.length - segmentBytes * 2))
  while (rest.length > 0) {
    const piece = rest.subarray(0, Math.max(0, segmentBytes - logged))
    writeSync(log, piece)
    logged += piece.length
    rest = rest.subarray(piece.length)
    if (logged < segmentBytes) continue
    closeSync(log)
    renameSync(files.log, files.previousLog)
    log = openSync(files.log, 'a', 0o600)
    logged = 0
  }
}

const child = spawn('/bin/sh', ['-c', launch.run], {
  cwd: launch.cwd,
  detached: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})
record({ t: 'start', hostPid: process.pid, pid: child.pid ?? null })
child.stdout.on('data', writeLog)
child.stderr.on('data', writeLog)

const killGroup = (signal: NodeJS.Signals) => {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, signal)
  } catch {}
}

let stopped = false
const stop = () => {
  if (stopped) return
  stopped = true
  killGroup('SIGTERM')
  setTimeout(() => killGroup('SIGKILL'), 5_000).unref()
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
process.on('SIGHUP', stop)
watchExitWith(stop)

let spawnError: string | undefined
child.on('error', (error) => {
  spawnError = error.message
})
let finished = false
const finish = (code: number | null, signal: NodeJS.Signals | null) => {
  if (finished) return
  finished = true
  record({
    t: 'exit',
    code,
    signal,
    ...(stopped && { stopped: true }),
    ...(spawnError !== undefined && { error: spawnError }),
  })
  closeSync(log)
  closeSync(records)
  lock.release()
  process.exit(0)
}
child.on('exit', (code, signal) => {
  killGroup('SIGKILL')
  setTimeout(() => finish(code, signal), 2_000).unref()
  child.on('close', () => finish(code, signal))
})
child.on('close', (code, signal) => {
  if (child.exitCode === null && child.signalCode === null) finish(code, signal)
})
