import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type { ConversationEntry, Run, RunState } from '@ted/protocol'
import type { Agent } from '../agents/agent.ts'
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
  agent: Agent
  tokens: RunTokens
  idle?: IdleTimer
  cliPath?: string
}

export interface RunManager {
  start(input: { prompt: string; cwd: string }): Promise<Run>
  close(): Promise<void>
}

export async function startRunManager(options: RunManagerOptions): Promise<RunManager> {
  const { home, store, agent, tokens } = options
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
        const finished = commitBatch(runId, batch, hostGone)
        offset = batch.toOffset
        if (finished) return
      }
      await sleep(pollMs)
    }
  }

  function commitBatch(runId: string, batch: RecordBatch, hostGone: boolean): boolean {
    const entries: ConversationEntry[] = []
    let state: RunState | undefined
    for (const { offset, record } of batch.records) {
      if (record.t === 'out') {
        entries.push({ offset, line: record.line })
        state = agent.stateFrom(record.line) ?? state
      } else if (record.t === 'exit') state = 'finished'
    }
    if (hostGone) state = 'finished'
    store.recordRunOutput(runId, { toOffset: batch.toOffset, entries, ...(state && { state }) })
    return state === 'finished'
  }

  for (const run of store.listRuns()) if (run.state !== 'finished') follow(run.id)

  return {
    async start({ prompt, cwd }) {
      const id = randomUUID()
      const runDir = path.join(runsDir, id)
      await mkdir(runDir, { mode: 0o700 })
      const sessionId = randomUUID()
      const launch = agent.launch({
        sessionId,
        prompt,
        runDir,
        env: {
          ...process.env,
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
      }
      await writeFile(runFiles(runDir).launch, JSON.stringify(launchFile), { mode: 0o600 })

      const run = store.startRun({ id, agent: agent.kind, sessionId, prompt, cwd })
      spawn(process.execPath, [hostMain, runDir], {
        detached: true,
        stdio: 'ignore',
        env: launch.env,
        cwd: runDir,
      }).unref()
      follow(id)
      return run
    },
    async close() {
      closed = true
      await Promise.all(following.values())
    },
  }
}

interface RecordBatch {
  records: { offset: number; record: HostRecord }[]
  toOffset: number
}

async function readRecords(file: string, offset: number): Promise<RecordBatch> {
  const none = { records: [], toOffset: offset }
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
      if (end >= 0) return parseRecords(buffer, end, offset)
      if (offset + length >= size) break
      length = Math.min(size - offset, length * 2)
    }
    return none
  } finally {
    await handle.close()
  }
}

function parseRecords(buffer: Buffer, end: number, offset: number): RecordBatch {
  const records: RecordBatch['records'] = []
  for (let pos = 0; pos <= end; ) {
    const newline = buffer.indexOf(10, pos)
    records.push({
      offset: offset + pos,
      record: JSON.parse(buffer.toString('utf8', pos, newline)) as HostRecord,
    })
    pos = newline + 1
  }
  return { records, toOffset: offset + end + 1 }
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
