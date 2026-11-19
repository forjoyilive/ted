import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { pathToFileURL } from 'node:url'
import { watchExitWith } from '../../exit-with.ts'
import { waitForLock } from '../../lock.ts'
import { homeOfRunDir, quitMarkedSync } from '../../quit-mark.ts'
import {
  type DriveAgent,
  type HostDriver,
  type HostRecord,
  hostProtocol,
  type LaunchFile,
  readGenerationLine,
  runFiles,
} from '../host-files.ts'
import { consumeInput } from '../input-permits.ts'
import { checkLaunchAuthority } from '../launch-authority.ts'

const runDir = process.argv[2]
if (!runDir) throw new Error('usage: host/main.ts <run-dir>')
delete process.env.ELECTRON_RUN_AS_NODE
const files = runFiles(runDir)

const lock = await waitForLock(files.lock, 2_000)
if (!lock) throw new Error(`another host already runs ${runDir}`)
if (quitMarkedSync(homeOfRunDir(runDir))) {
  lock.release()
  throw new Error('Ted was quit; this Run doesn’t start until the app opens again')
}

const earlierStarts = (() => {
  try {
    return readFileSync(files.log, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('{"t":"start"')).length
  } catch {
    return 0
  }
})()
writeFileSync(files.pid, String(process.pid), { mode: 0o600 })
const log = openSync(files.log, 'a')
const write = (record: HostRecord) => writeSync(log, `${JSON.stringify(record)}\n`)

interface Started {
  agent: ChildProcessWithoutNullStreams
  driver: HostDriver | undefined
  send: (line: string) => void
  closed: Promise<[number | null, NodeJS.Signals | null]>
  spawnError: () => string | undefined
}

let current: Started | undefined
let generation = earlierStarts
let restarting = false
let restartWanted = false
let lastLaunchId: string | undefined
const asked = { stop: false }

async function startAgent(): Promise<Started> {
  const launch = JSON.parse(readFileSync(files.launch, 'utf8')) as LaunchFile
  lastLaunchId = launch.launchId
  const drive =
    launch.driver === undefined
      ? undefined
      : ((await import(pathToFileURL(launch.driver).href)) as { drive: DriveAgent }).drive
  if (asked.stop) throw new Error('The Run was stopped before its agent started')
  checkLaunchAuthority(launch.authority)
  const agent = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  write({
    t: 'start',
    v: hostProtocol,
    hostPid: process.pid,
    agentPid: agent.pid ?? null,
    ...(launch.permissions !== undefined && { permissions: launch.permissions }),
  })
  generation += 1

  let spawnError: string | undefined
  agent.on('error', (error) => {
    spawnError = error.message
  })
  agent.stdin.on('error', () => {})
  const send = (line: string) => {
    if (agent.stdin.writable) agent.stdin.write(`${line}\n`)
  }
  const driver = drive?.({
    input: launch.input,
    cwd: launch.cwd,
    send,
    emit: (line) => write({ t: 'out', line, at: new Date().toISOString() }),
    stop: () => agent.kill('SIGTERM'),
    fail: (message) => {
      write({ t: 'err', line: message })
      agent.kill('SIGTERM')
    },
  })
  if (!driver && launch.input !== '') send(launch.input)

  const onOut = (line: string) => {
    write({ t: 'out', line, at: new Date().toISOString() })
    driver?.onLine(line)
  }
  const stdout =
    launch.lines === 'lf'
      ? lfLines(agent.stdout, onOut)
      : createInterface({ input: agent.stdout, crlfDelay: Number.POSITIVE_INFINITY }).on(
          'line',
          onOut,
        )
  const stderr = createInterface({ input: agent.stderr, crlfDelay: Number.POSITIVE_INFINITY })
  stderr.on('line', (line) => write({ t: 'err', line }))

  const closed = Promise.all([
    once(agent, 'close'),
    once(stdout, 'close'),
    once(stderr, 'close'),
  ]).then(([result]) => result as [number | null, NodeJS.Signals | null])
  return { agent, driver, send, closed, spawnError: () => spawnError }
}

// Node’s readline also ends lines at U+2028 and U+2029, which are valid inside JSON strings.
function lfLines(stream: Readable, onLine: (line: string) => void): Readable {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  const emitLines = (text: string) => {
    pending += text
    for (let end = pending.indexOf('\n'); end !== -1; end = pending.indexOf('\n')) {
      const line = pending.slice(0, end)
      pending = pending.slice(end + 1)
      onLine(line.endsWith('\r') ? line.slice(0, -1) : line)
    }
  }
  stream.on('data', (chunk: Buffer) => emitLines(decoder.write(chunk)))
  stream.on('end', () => {
    emitLines(decoder.end())
    if (pending !== '') onLine(pending.endsWith('\r') ? pending.slice(0, -1) : pending)
    pending = ''
  })
  return stream
}

let inputOffset = (() => {
  const launch = JSON.parse(readFileSync(files.launch, 'utf8')) as LaunchFile
  return launch.inputFrom ?? 0
})()
const forwardInput = () => {
  if (restarting || !current) return
  const { driver, send } = current
  let fd: number
  try {
    fd = openSync(files.input, 'r')
  } catch {
    if (!existsSync(runDir)) stop()
    return
  }
  try {
    let buffer = Buffer.alloc(64 * 1024)
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, inputOffset)
      if (bytesRead === 0) return
      const end = buffer.lastIndexOf(10, bytesRead - 1)
      if (end === -1) {
        if (bytesRead < buffer.length) return
        buffer = Buffer.alloc(buffer.length * 2)
        continue
      }
      const lines = buffer.toString('utf8', 0, end).split('\n')
      inputOffset += end + 1
      for (const raw of lines) {
        const tagged = readGenerationLine(raw)
        if (tagged && tagged.forGeneration !== generation) continue
        if (tagged?.permit && !consumeInput(runDir, tagged.permit)) continue
        const line = tagged ? tagged.line : raw
        if (driver?.onInput) driver.onInput(line)
        else send(line)
      }
    }
  } finally {
    closeSync(fd)
  }
}
const inputTimer = setInterval(forwardInput, 150)

const stop = () => {
  asked.stop = true
  restartWanted = false
  current?.agent.kill('SIGTERM')
}
process.on('SIGTERM', stop)
watchExitWith(stop)
process.on('SIGHUP', () => {
  if (asked.stop) return
  restartWanted = true
  restarting = true
  current?.agent.kill('SIGTERM')
})

let code: number | null
let signal: NodeJS.Signals | null
let spawnError: string | undefined
for (;;) {
  current = await startAgent()
  restartWanted = false
  restarting = false
  ;[code, signal] = await current.closed
  spawnError = current.spawnError()
  if (asked.stop || !restartWanted) break
  // Only the daemon prepares a new launch after checking this computer’s permission mode.
  const next = JSON.parse(readFileSync(files.launch, 'utf8')) as LaunchFile
  if (next.launchId === undefined || next.launchId === lastLaunchId) break
}

clearInterval(inputTimer)
write({
  t: 'exit',
  code,
  signal,
  ...(spawnError !== undefined && { error: spawnError }),
  ...(asked.stop && { stopped: true }),
  at: new Date().toISOString(),
})
lock.release()
process.exit(0)
