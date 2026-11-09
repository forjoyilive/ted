import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { openSync, readFileSync, writeSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { tryLock } from '../../lock.ts'
import { type HostRecord, type LaunchFile, runFiles } from '../host-files.ts'

const runDir = process.argv[2]
if (!runDir) throw new Error('usage: host/main.ts <run-dir>')
const files = runFiles(runDir)

const lock = tryLock(files.lock)
if (!lock) throw new Error(`another host already runs ${runDir}`)

const launch = JSON.parse(readFileSync(files.launch, 'utf8')) as LaunchFile
const log = openSync(files.log, 'a')
const write = (record: HostRecord) => writeSync(log, `${JSON.stringify(record)}\n`)

const agent = spawn(launch.command, launch.args, {
  cwd: launch.cwd,
  stdio: ['pipe', 'pipe', 'pipe'],
})
write({ t: 'start', v: 1, hostPid: process.pid, agentPid: agent.pid ?? null })

let spawnError: string | undefined
agent.on('error', (error) => {
  spawnError = error.message
})
agent.stdin.on('error', () => {})
agent.stdin.write(`${launch.input}\n`)

const stdout = createInterface({ input: agent.stdout, crlfDelay: Number.POSITIVE_INFINITY })
const stderr = createInterface({ input: agent.stderr, crlfDelay: Number.POSITIVE_INFINITY })
stdout.on('line', (line) => write({ t: 'out', line }))
stderr.on('line', (line) => write({ t: 'err', line }))

process.on('SIGTERM', () => agent.kill('SIGTERM'))

const [code, signal] = (await Promise.all([
  once(agent, 'close'),
  once(stdout, 'close'),
  once(stderr, 'close'),
]).then(([closed]) => closed)) as [number | null, NodeJS.Signals | null]

write({ t: 'exit', code, signal, ...(spawnError !== undefined && { error: spawnError }) })
lock.release()
process.exit(0)
