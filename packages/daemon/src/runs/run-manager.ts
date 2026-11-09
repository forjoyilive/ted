import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type { AgentKind, ConversationEntry, Run, RunState } from '@ted/protocol'
import type { Agents } from '../agents/index.ts'
import type { IdleTimer } from '../idle.ts'
import { isLockHeld } from '../lock.ts'
import type { RunTokens } from '../run-token.ts'
import type { TedStore } from '../store/index.ts'
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
}

export interface StartRunInput {
  agent: AgentKind
  prompt: string
  cwd: string
  taskId?: string
  env?: Record<string, string>
}

export interface RunManager {
  start(input: StartRunInput): Promise<Run>
  send(runId: string, text: string): Promise<void>
  stop(runId: string): Promise<void>
  close(): Promise<void>
}

const stopGraceMs = 10_000

export async function startRunManager(options: RunManagerOptions): Promise<RunManager> {
  const { home, store, agents, tokens } = options
  const runsDir = path.join(home, 'runs')
  const binDir = path.join(home, 'bin')
  await mkdir(runsDir, { recursive: true, mode: 0o700 })
  await writeTedShim(binDir, options.cliPath ?? defaultCli)

  const following = new Map<string, Promise<void>>()
  let closed = false

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
    for (const { offset, record } of batch.records) {
      if (record.t === 'out') {
        entries.push({ offset, line: record.line })
        state = agent.stateFrom(record.line) ?? state
        sessionId = agent.sessionIdFrom(record.line) ?? sessionId
      } else if (record.t === 'exit') state = 'finished'
    }
    if (hostGone) state = 'finished'
    store.recordRunOutput(runId, {
      toOffset: batch.toOffset,
      entries,
      ...(state && { state }),
      ...(sessionId !== undefined && { sessionId }),
    })
    return state === 'finished'
  }

  for (const run of store.listRuns()) if (run.state !== 'finished') follow(run.id)

  return {
    async start({ agent: kind, prompt, cwd, taskId, env = {} }) {
      const agent = agents.get(kind)
      const id = randomUUID()
      const runDir = path.join(runsDir, id)
      await mkdir(runDir, { mode: 0o700 })
      const launch = agent.launch({
        prompt,
        runDir,
        env: {
          ...process.env,
          ...env,
          TED_HOME: home,
          TED_RUN: id,
          TED_RUN_TOKEN: tokens.issue(id),
          PATH: [binDir, process.env.PATH].filter(Boolean).join(path.delimiter),
        },
      })
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
      await writeFile(runFiles(runDir).launch, JSON.stringify(launchFile), { mode: 0o600 })

      const run = store.startRun({
        id,
        agent: agent.kind,
        ...(launch.sessionId !== undefined && { sessionId: launch.sessionId }),
        prompt,
        cwd,
        ...(taskId !== undefined && { taskId }),
      })
      spawn(process.execPath, [hostMain, runDir], {
        detached: true,
        stdio: 'ignore',
        env: launch.env,
        cwd: runDir,
      }).unref()
      follow(id)
      return run
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
        signal(start.agentPid, 'SIGKILL')
        signal(start.hostPid, 'SIGKILL')
        await done
      }
    },
    async close() {
      closed = true
      await Promise.all(following.values())
    },
  }
}

export async function startRecord(
  runDir: string,
): Promise<Extract<HostRecord, { t: 'start' }> | undefined> {
  const log = await readFile(runFiles(runDir).log, 'utf8').catch(() => '')
  const first = log.slice(0, log.indexOf('\n'))
  if (first === '') return undefined
  const record = JSON.parse(first) as HostRecord
  return record.t === 'start' ? record : undefined
}

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
  const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`
  const shim = path.join(binDir, 'ted')
  const tmp = `${shim}.${process.pid}.tmp`
  await writeFile(tmp, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(cliPath)} "$@"\n`, {
    mode: 0o755,
  })
  await rename(tmp, shim)
}
