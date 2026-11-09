import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type { AgentKind, ConversationEntry, Run, RunProblem, RunState } from '@ted/protocol'
import type { AgentLaunch, Agents } from '../agents/index.ts'
import { RequestError } from '../errors.ts'
import type { IdleTimer } from '../idle.ts'
import { isLockHeld } from '../lock.ts'
import { nodeEntry, shellScript } from '../node-entry.ts'
import type { RunTokens } from '../run-token.ts'
import type { RunFlags, TedStore } from '../store/index.ts'
import { type HostRecord, type LaunchFile, runFiles } from './host-files.ts'

const hostMain = fileURLToPath(new URL('./host/main.ts', import.meta.url))
const defaultCli = fileURLToPath(new URL('../../../cli/src/main.ts', import.meta.url))
const pollMs = 150
const batchBytes = 1024 * 1024

export interface RunManagerOptions {
  home: string
  store: TedStore
  agents: Agents
  tokens: RunTokens
  idle?: IdleTimer
  cliPath?: string
  env?: () => NodeJS.ProcessEnv
}

export interface RunObserver {
  finished?(run: Run): void
  authFailed?(run: Run): void
}

export interface StartRunInput extends Omit<RunFlags, 'usesDefaultModel'> {
  agent: AgentKind
  prompt: string
  cwd: string
  taskId?: string
  env?: Record<string, string>
  resume?: string
}

export interface RunManager {
  start(input: StartRunInput): Promise<Run>
  restart(runId: string, flags: RunFlags): Promise<Run>
  send(runId: string, text: string): Promise<void>
  stop(runId: string): Promise<void>
  observe(observer: RunObserver): void
  environment(): NodeJS.ProcessEnv
  stopAll(): Promise<void>
  close(): Promise<void>
}

const stopGraceMs = 10_000
const startRecordBytes = 4096

export async function startRunManager(options: RunManagerOptions): Promise<RunManager> {
  const { home, store, agents, tokens } = options
  const runsDir = path.join(home, 'runs')
  const binDir = path.join(home, 'bin')
  await mkdir(runsDir, { recursive: true, mode: 0o700 })
  await writeTedShim(binDir, options.cliPath ?? defaultCli)

  const following = new Map<string, Promise<void>>()
  const observers = new Set<RunObserver>()
  let closed = false
  let shuttingDown = false
  const refuseWhileShuttingDown = () => {
    if (shuttingDown) throw new RequestError(503, 'TED is shutting down')
  }

  const environment = (): NodeJS.ProcessEnv => {
    const base = options.env?.() ?? process.env
    return {
      ...base,
      TED_HOME: home,
      PATH: [binDir, base.PATH].filter(Boolean).join(path.delimiter),
    }
  }

  function tell(what: keyof RunObserver, runId: string): void {
    const run = store.getRun(runId)
    if (!run) return
    for (const observer of observers) {
      try {
        observer[what]?.(run)
      } catch (error) {
        console.error(`a Run observer failed:`, error)
      }
    }
  }

  function follow(runId: string): void {
    const release = options.idle?.hold()
    const done = followHostLog(runId)
      .catch((error: unknown) => console.error(`stopped following Run ${runId}:`, error))
      .finally(() => {
        following.delete(runId)
        release?.()
      })
    following.set(runId, done)
  }

  async function followHostLog(runId: string): Promise<void> {
    const files = runFiles(path.join(runsDir, runId))
    let offset = store.runReadOffset(runId)
    while (!closed) {
      const hostGone = offset > 0 && !isLockHeld(files.lock)
      const batch = await readRecords(files.log, offset)
      if (batch.toOffset > offset || hostGone) {
        const finished = commitBatch(runId, batch, hostGone && batch.atEnd)
        offset = batch.toOffset
        if (finished) return
      }
      if (batch.atEnd) await sleep(pollMs)
    }
  }

  function commitBatch(runId: string, batch: RecordBatch, hostGone: boolean): boolean {
    const agent = agents.get(store.getRun(runId)?.agent ?? 'claude')
    const entries: ConversationEntry[] = []
    let state: RunState | undefined
    let sessionId: string | undefined
    let authFailed = false
    let problem: RunProblem | undefined
    for (const { offset, record } of batch.records) {
      if (record.t === 'out') {
        entries.push({ offset, line: record.line })
        state = agent.stateFrom(record.line) ?? state
        sessionId = agent.sessionIdFrom(record.line) ?? sessionId
        problem = agent.problemFrom(record.line) ?? problem
        authFailed ||= agent.authErrorFrom(record.line)
      } else if (record.t === 'exit') state = 'finished'
    }
    if (hostGone) state = 'finished'
    store.recordRunOutput(runId, {
      toOffset: batch.toOffset,
      entries,
      ...(state && { state }),
      ...(sessionId !== undefined && { sessionId }),
      ...(problem !== undefined && { problem }),
    })
    if (authFailed) tell('authFailed', runId)
    if (state === 'finished') tell('finished', runId)
    return state === 'finished'
  }

  for (const run of store.listRuns()) if (run.state !== 'finished') follow(run.id)

  async function writeLaunch(runDir: string, cwd: string, launch: AgentLaunch): Promise<void> {
    for (const [name, content] of Object.entries(launch.files)) {
      await writeFile(path.join(runDir, name), content, { mode: 0o600 })
    }
    const launchFile: LaunchFile = {
      command: launch.command,
      args: launch.args,
      cwd,
      input: launch.input,
      ...(launch.driver !== undefined && { driver: launch.driver }),
    }
    const file = runFiles(runDir).launch
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(launchFile), { mode: 0o600 })
    await rename(tmp, file)
  }

  const manager: RunManager = {
    async start({ agent: kind, prompt, cwd, taskId, env = {}, model, effort, resume }) {
      refuseWhileShuttingDown()
      const agent = agents.get(kind)
      const id = randomUUID()
      const runDir = path.join(runsDir, id)
      await mkdir(runDir, { mode: 0o700 })
      const launch = agent.launch({
        prompt,
        runDir,
        env: {
          ...environment(),
          ...env,
          TED_HOME: home,
          TED_RUN: id,
          TED_RUN_TOKEN: tokens.issue(id),
          PATH: environment().PATH,
        },
        ...(resume !== undefined && { resume }),
        ...(model !== undefined && { model }),
        ...(effort !== undefined && { effort }),
      })
      await writeLaunch(runDir, cwd, launch)

      refuseWhileShuttingDown()
      const run = store.startRun({
        id,
        agent: agent.kind,
        ...(launch.sessionId !== undefined && { sessionId: launch.sessionId }),
        prompt,
        cwd,
        ...(taskId !== undefined && { taskId }),
        ...(model !== undefined && { model }),
        ...(effort !== undefined && { effort }),
      })
      const host = nodeEntry(hostMain, [runDir])
      spawn(host.command, host.args, {
        detached: true,
        stdio: 'ignore',
        env: { ...launch.env, ELECTRON_RUN_AS_NODE: '1' },
        cwd: runDir,
      }).unref()
      follow(id)
      return run
    },
    async restart(runId, flags) {
      refuseWhileShuttingDown()
      const run = store.getRun(runId)
      if (!run || run.state === 'finished' || !following.has(runId)) {
        throw new Error(`Run ${runId} isn't live`)
      }
      if (run.sessionId === undefined) throw new Error(`Run ${runId} has no session to resume`)
      const runDir = path.join(runsDir, runId)
      const start = await startRecord(runDir)
      if (!start) throw new Error(`Run ${runId}'s host never started`)
      const launch = agents.get(run.agent).launch({
        prompt: '',
        runDir,
        env: {},
        resume: run.sessionId,
        ...(flags.model !== undefined && !flags.usesDefaultModel && { model: flags.model }),
        ...(flags.effort !== undefined && { effort: flags.effort }),
      })
      await writeLaunch(runDir, run.cwd, launch)
      const before = await startRecordCount(runDir)
      const restarted = store.restartRun(runId, flags)
      signal(start.hostPid, 'SIGHUP')
      for (let waited = 0; (await startRecordCount(runDir)) === before; waited += pollMs) {
        if (waited >= stopGraceMs) throw new Error(`Run ${runId}'s agent didn't restart`)
        await sleep(pollMs)
      }
      return restarted
    },
    async send(runId, text) {
      const input = runFiles(path.join(runsDir, runId)).input
      const run = store.getRun(runId)
      if (!run) throw new Error(`no Run ${runId}`)
      await appendFile(input, `${agents.get(run.agent).message(text)}\n`, { mode: 0o600 })
    },
    async stop(runId) {
      const done = following.get(runId)
      if (!done) return
      const runDir = path.join(runsDir, runId)
      const timeout = sleep(stopGraceMs).then(() => 'timeout' as const)
      let start = await startRecord(runDir)
      for (let waited = 0; !start && waited < stopGraceMs; waited += pollMs) {
        await sleep(pollMs)
        start = await startRecord(runDir)
      }
      if (!start) throw new Error(`Run ${runId}'s host never started`)
      if (!isLockHeld(runFiles(runDir).lock)) return void (await done)
      signal(start.hostPid, 'SIGTERM')
      if ((await Promise.race([done, timeout])) === 'timeout') {
        signal((await lastStartRecord(runDir))?.agentPid ?? null, 'SIGKILL')
        signal(start.hostPid, 'SIGKILL')
        await done
      }
    },
    observe(observer) {
      observers.add(observer)
    },
    environment,
    async stopAll() {
      shuttingDown = true
      await Promise.all([...following.keys()].map((runId) => manager.stop(runId)))
    },
    async close() {
      closed = true
      await Promise.all(following.values())
    },
  }
  return manager
}

export async function startRecord(
  runDir: string,
): Promise<Extract<HostRecord, { t: 'start' }> | undefined> {
  const handle = await open(runFiles(runDir).log, 'r').catch(() => undefined)
  if (!handle) return undefined
  let head: string
  try {
    const buffer = Buffer.alloc(startRecordBytes)
    const { bytesRead } = await handle.read(buffer, 0, startRecordBytes, 0)
    head = buffer.toString('utf8', 0, bytesRead)
  } finally {
    await handle.close()
  }
  const end = head.indexOf('\n')
  if (end <= 0) return undefined
  const record = JSON.parse(head.slice(0, end)) as HostRecord
  return record.t === 'start' ? record : undefined
}

async function startRecords(runDir: string): Promise<Extract<HostRecord, { t: 'start' }>[]> {
  const log = await readFile(runFiles(runDir).log, 'utf8').catch(() => '')
  return log
    .split('\n')
    .filter((line) => line.startsWith('{"t":"start"'))
    .map((line) => JSON.parse(line) as Extract<HostRecord, { t: 'start' }>)
}

const lastStartRecord = async (runDir: string) => (await startRecords(runDir)).at(-1)

const startRecordCount = async (runDir: string) => (await startRecords(runDir)).length

function signal(pid: number | null, name: NodeJS.Signals): void {
  try {
    if (pid !== null) process.kill(pid, name)
  } catch {}
}

interface RecordBatch {
  records: { offset: number; record: HostRecord }[]
  toOffset: number
  atEnd: boolean
}

async function readRecords(file: string, offset: number): Promise<RecordBatch> {
  const none = { records: [], toOffset: offset, atEnd: true }
  const handle = await open(file, 'r').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (!handle) return none
  try {
    const { size } = await handle.stat()
    let length = Math.min(size - offset, batchBytes)
    while (length > 0) {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, offset)
      const end = buffer.lastIndexOf(10, bytesRead - 1)
      if (end >= 0) return parseRecords(buffer, end, offset, offset + length >= size)
      if (offset + length >= size) break
      length = Math.min(size - offset, length * 2)
    }
    return none
  } finally {
    await handle.close()
  }
}

function parseRecords(buffer: Buffer, end: number, offset: number, atEnd: boolean): RecordBatch {
  const records: RecordBatch['records'] = []
  for (let pos = 0; pos <= end; ) {
    const newline = buffer.indexOf(10, pos)
    records.push({
      offset: offset + pos,
      record: JSON.parse(buffer.toString('utf8', pos, newline)) as HostRecord,
    })
    pos = newline + 1
  }
  return { records, toOffset: offset + end + 1, atEnd }
}

async function writeTedShim(binDir: string, cliPath: string): Promise<void> {
  await mkdir(binDir, { recursive: true })
  const shim = path.join(binDir, 'ted')
  const tmp = `${shim}.${process.pid}.tmp`
  await writeFile(tmp, shellScript(nodeEntry(cliPath), { ELECTRON_RUN_AS_NODE: '1' }), {
    mode: 0o755,
  })
  await rename(tmp, shim)
}
