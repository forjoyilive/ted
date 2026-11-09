import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { appendFile, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type {
  AgentKind,
  ConversationEntry,
  PermissionMode,
  Run,
  RunProblem,
  RunState,
} from '@ted/protocol'
import { hidesText, type PermissionPrompt, type PermissionReply } from '../agents/agent.ts'
import type { AgentLaunch, Agents } from '../agents/index.ts'
import { RequestError } from '../errors.ts'
import type { IdleTimer } from '../idle.ts'
import { isLockHeld } from '../lock.ts'
import { nodeEntry, shellScript } from '../node-entry.ts'
import type { RunTokens } from '../run-token.ts'
import type { RunFlags, TedStore } from '../store/index.ts'
import { forGeneration, type HostRecord, type LaunchFile, runFiles } from './host-files.ts'

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
  finished?(run: Run, ending: { stopped: boolean; lastLines: string[] }): void
  authFailed?(run: Run): void
  accepted?(run: Run, texts: string[]): void
  boundary?(run: Run): void
  settled?(run: Run): void
}

export interface StartRunInput extends Omit<RunFlags, 'usesDefaultModel'> {
  agent: AgentKind
  prompt: string
  cwd: string
  taskId?: string
  id?: string
  parentRunId?: string
  name?: string
  env?: Record<string, string>
  resume?: string
  permissions?: PermissionMode
}

export interface RunManager {
  start(input: StartRunInput): Promise<Run>
  restart(runId: string, flags: RunFlags): Promise<Run>
  send(runId: string, text: string): Promise<void>
  steer(runId: string, texts: readonly string[]): Promise<void>
  interrupt(runId: string): Promise<void>
  answerPermission(runId: string, generation: number, reply: PermissionReply): Promise<void>
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
  const stopRequested = new Set<string>()
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

  function tell(what: 'finished' | 'authFailed', runId: string, lastLines: string[] = []): void {
    const run = store.getRun(runId)
    if (!run) return
    const stopped = stopRequested.delete(runId)
    for (const observer of observers) {
      try {
        if (what === 'finished') observer.finished?.(run, { stopped, lastLines })
        else observer.authFailed?.(run)
      } catch (error) {
        console.error(`a Run observer failed:`, error)
      }
    }
  }

  function tellObservers(runId: string, tell: (observer: RunObserver, run: Run) => void): void {
    const run = store.getRun(runId)
    if (!run) return
    for (const observer of observers) {
      try {
        tell(observer, run)
      } catch (error) {
        console.error(`a Run observer failed:`, error)
      }
    }
  }

  const tellAccepted = (runId: string, texts: string[]) =>
    tellObservers(runId, (observer, run) => observer.accepted?.(run, texts))

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
    const generation = { count: await startsBefore(files.log, offset) }
    while (!closed) {
      const hostGone = offset > 0 && !isLockHeld(files.lock)
      const batch = await readRecords(files.log, offset)
      if (batch.toOffset > offset || hostGone) {
        const finished = commitBatch(runId, batch, hostGone && batch.atEnd, generation)
        offset = batch.toOffset
        if (finished) return
      }
      if (batch.atEnd) await sleep(pollMs)
    }
  }

  function commitBatch(
    runId: string,
    batch: RecordBatch,
    hostGone: boolean,
    generation: { count: number },
  ): boolean {
    const agent = agents.get(store.getRun(runId)?.agent ?? 'claude')
    const entries: ConversationEntry[] = []
    let state: RunState | undefined
    let sessionId: string | undefined
    let authFailed = false
    let problem: RunProblem | undefined
    let autoModeUnavailable = false
    let boundary = false
    const prompts: (PermissionPrompt & { generation: number })[] = []
    const closedPermissions: string[] = []
    const accepted: string[] = []
    const errors: string[] = []
    const startedWith = generation.count
    for (const { offset, record } of batch.records) {
      if (record.t === 'out') {
        entries.push({
          offset,
          line: record.line,
          ...(record.at !== undefined && { at: record.at }),
        })
        const text = agent.acceptedTextFrom(record.line)
        if (text !== undefined) accepted.push(text)
        state = agent.stateFrom(record.line) ?? state
        sessionId = agent.sessionIdFrom(record.line) ?? sessionId
        problem = agent.problemFrom(record.line) ?? problem
        authFailed ||= agent.authErrorFrom(record.line)
        autoModeUnavailable ||= agent.autoModeUnavailableFrom(record.line)
        boundary ||= agent.boundaryFrom(record.line)
        const prompt = agent.permissionPromptFrom(record.line, (matches) => {
          for (let i = entries.length - 2; i >= 0; i--) {
            const line = entries[i]?.line
            if (line !== undefined && matches(line)) return line
          }
          return store.conversation(runId).findLast((entry) => matches(entry.line))?.line
        })
        if (prompt) {
          prompts.push({
            ...prompt,
            generation: generation.count,
            ...(hidesText(prompt) && { refuse: true }),
          })
        }
        const closed = agent.permissionClosedFrom(record.line)
        if (closed !== undefined) closedPermissions.push(closed)
      } else if (record.t === 'start') generation.count += 1
      else if (record.t === 'exit') state = 'finished'
      else if (record.t === 'err') errors.push(record.line)
    }
    if (hostGone) state = 'finished'
    const run = store.getRun(runId)
    const askable = run?.taskId !== undefined
    const refused =
      state === 'finished' ? [] : prompts.filter((prompt) => !askable || prompt.refuse === true)
    if (refused.length > 0) {
      const lines = refused.flatMap((prompt) =>
        agent
          .permissionReply({ requestId: prompt.requestId, approved: false })
          .map((line) => forGeneration(prompt.generation, line)),
      )
      appendFileSync(
        runFiles(path.join(runsDir, runId)).input,
        lines.map((line) => `${line}\n`).join(''),
        { mode: 0o600 },
      )
    }
    const agentRestarted = startedWith > 0 && generation.count > startedWith
    const asked = askable
      ? prompts.filter((prompt) => prompt.refuse !== true && prompt.generation === generation.count)
      : []
    store.recordRunOutput(runId, {
      ...(asked.length > 0 && { permissionPrompts: asked }),
      ...(closedPermissions.length > 0 && { closedPermissions }),
      ...(agentRestarted && { agentRestarted }),
      ...(autoModeUnavailable && { autoModeUnavailable }),
      toOffset: batch.toOffset,
      entries,
      ...(state && { state }),
      ...(sessionId !== undefined && { sessionId }),
      ...(problem !== undefined && { problem }),
    })
    if (accepted.length > 0) tellAccepted(runId, accepted)
    if (boundary && state !== 'finished') {
      tellObservers(runId, (observer, run) => observer.boundary?.(run))
    }
    if (state === 'idle') tellObservers(runId, (observer, run) => observer.settled?.(run))
    if (authFailed) tell('authFailed', runId)
    if (state === 'finished') tell('finished', runId, errors.slice(-20))
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
    async start({
      agent: kind,
      prompt,
      cwd,
      taskId,
      env = {},
      model,
      effort,
      resume,
      id = randomUUID(),
      parentRunId,
      name,
      permissions = 'auto',
    }) {
      refuseWhileShuttingDown()
      const agent = agents.get(kind)
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
        permissions,
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
        ...(parentRunId !== undefined && { parentRunId }),
        ...(name !== undefined && { name }),
        permissions,
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
        permissions: run.permissions,
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
    async steer(runId, texts) {
      const run = store.getRun(runId)
      if (!run) throw new Error(`no Run ${runId}`)
      const agent = agents.get(run.agent)
      await appendFile(
        runFiles(path.join(runsDir, runId)).input,
        texts.map((text) => `${agent.steer(text)}\n`).join(''),
        { mode: 0o600 },
      )
    },
    async interrupt(runId) {
      const run = store.getRun(runId)
      if (!run) throw new Error(`no Run ${runId}`)
      await appendFile(
        runFiles(path.join(runsDir, runId)).input,
        agents
          .get(run.agent)
          .interrupt()
          .map((line) => `${line}\n`)
          .join(''),
        { mode: 0o600 },
      )
    },
    async answerPermission(runId, generation, reply) {
      const run = store.getRun(runId)
      if (!run) throw new Error(`no Run ${runId}`)
      const lines = agents
        .get(run.agent)
        .permissionReply(reply)
        .map((line) => forGeneration(generation, line))
      await appendFile(
        runFiles(path.join(runsDir, runId)).input,
        lines.map((line) => `${line}\n`).join(''),
        { mode: 0o600 },
      )
    },
    async stop(runId) {
      const done = following.get(runId)
      if (!done) return
      stopRequested.add(runId)
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

async function startsBefore(log: string, offset: number): Promise<number> {
  if (offset === 0) return 0
  const handle = await open(log, 'r').catch(() => undefined)
  if (!handle) return 0
  try {
    const buffer = Buffer.alloc(offset)
    const { bytesRead } = await handle.read(buffer, 0, offset, 0)
    return buffer
      .toString('utf8', 0, bytesRead)
      .split('\n')
      .filter((line) => line.startsWith('{"t":"start"')).length
  } finally {
    await handle.close()
  }
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
