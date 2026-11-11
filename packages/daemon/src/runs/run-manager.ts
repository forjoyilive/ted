import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeSync,
} from 'node:fs'
import { appendFile, mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import type {
  AgentKind,
  PermissionMode,
  PlanWindow,
  Run,
  RunEnding,
  RunProblem,
  RunState,
} from '@ted/protocol'
import { filterTedEnv, runTokenEnv } from '@ted/protocol'
import {
  type AutoModeSignal,
  type CredentialReport,
  hidesText,
  type PermissionPrompt,
  type PermissionReply,
  type UsageSignal,
} from '../agents/agent.ts'
import type { AgentLaunch, Agents } from '../agents/index.ts'
import { RequestError } from '../errors.ts'
import type { IdleTimer } from '../idle.ts'
import { holdsLock, isLockHeld } from '../lock.ts'
import { nodeEntry, shellScript } from '../node-entry.ts'
import { acquireRunPermissions, runPermissions, withRunPermissions } from '../permissions.ts'
import { workCommand } from '../priority.ts'
import { redactSecrets } from '../redact.ts'
import type { RunTokens } from '../run-token.ts'
import { sideFolder } from '../side-chats/context.ts'
import { signalGroup, signalProcess } from '../signal.ts'
import type { RunFlags, TedStore } from '../store/index.ts'
import {
  forGeneration,
  type HostRecord,
  type LaunchFile,
  oldestHostProtocol,
  type QueuedInput,
  readQueuedInput,
  runFiles,
} from './host-files.ts'
import {
  initializeLaunchAuthority,
  launchAuthority,
  revokeLaunchAuthority,
} from './launch-authority.ts'
import { parsedOutput } from './parsed-output.ts'
import { createRunOutput, type RunOutputReader } from './run-output.ts'

const hostMain = fileURLToPath(new URL('./host/main.ts', import.meta.url))
const defaultCli = fileURLToPath(new URL('../../../cli/src/main.ts', import.meta.url))
const pollMs = 150
const lockCheckMs = 1000
const batchBytes = 1024 * 1024

export interface RunManagerOptions {
  home: string
  store: TedStore
  agents: Agents
  tokens: RunTokens
  idle?: IdleTimer
  cliPath?: string
  env?: () => NodeJS.ProcessEnv
  oldestHost?: number
}

export interface RunObserver {
  finished?(run: Run, ending: { stopped: boolean; lastLines: string[] }): void
  authFailed?(run: Run): void
  accepted?(run: Run, texts: string[]): void
  boundary?(run: Run): void
  settled?(run: Run): void
  usage?(run: Run, signal: UsageSignal): void
  credential?(run: Run, report: CredentialReport): void
  planUsage?(run: Run, windows: PlanWindow[]): void
  retrying?(run: Run): void
  autoMode?(run: Run, signal: AutoModeSignal): void
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
  messageIds?: string[]
  permissions?: PermissionMode
}

export interface ReviveRunInput {
  flags?: RunFlags
  prompt: string
  messageIds?: string[]
  env?: Record<string, string>
}

export interface RunManager {
  output: RunOutputReader
  start(input: StartRunInput): Promise<Run>
  revive(runId: string, input: ReviveRunInput): Promise<Run>
  restart(runId: string, flags: RunFlags): Promise<Run>
  send(runId: string, text: string): Promise<void>
  steer(runId: string, texts: readonly string[]): Promise<void>
  dispatch(
    runId: string,
    messages: readonly { id: string; text: string }[],
    steer: boolean,
    canDispatch: (messageId?: string) => boolean,
  ): Promise<boolean>
  inputDispatched(runId: string, messageId: string): boolean
  acceptedInputs(runId: string): string[]
  initialInputIds(runId: string): string[]
  interrupt(runId: string): Promise<void>
  lastHeard(runId: string): number | undefined
  answerPermission(runId: string, generation: number, reply: PermissionReply): Promise<void>
  stop(runId: string): Promise<void>
  observe(observer: RunObserver): void
  environment(): NodeJS.ProcessEnv
  stopAll(): Promise<void>
  close(): Promise<void>
}

function mergeUsage(
  before: UsageSignal | undefined,
  next: UsageSignal | undefined,
): UsageSignal | undefined {
  if (!next) return before
  if (next.limited && next.resetsAt === undefined && before?.limited && before.resetsAt) {
    return before
  }
  return next
}

const stopGraceMs = 10_000
const startRecordBytes = 4096

export async function startRunManager(options: RunManagerOptions): Promise<RunManager> {
  const { home, store, agents, tokens } = options
  const runsDir = path.join(home, 'runs')
  const binDir = path.join(home, 'bin')
  await mkdir(runsDir, { recursive: true, mode: 0o700 })
  await initializeLaunchAuthority(store, home)
  await writeTedShim(binDir, options.cliPath ?? defaultCli)

  const output = createRunOutput({ home, store })
  const following = new Map<string, Promise<void>>()
  const generations = new Map<string, Generation>()
  const stopRequested = new Set<string>()
  const launchStops = new Map<string, AbortController>()
  const heard = new Map<string, number>()
  const observers = new Set<RunObserver>()
  const outdated = new Set<string>()
  const replacing = new Set<string>()
  const oldestHost = options.oldestHost ?? oldestHostProtocol
  let closed = false
  let shuttingDown = false
  const refuseWhileShuttingDown = () => {
    if (shuttingDown) throw new RequestError(503, 'TED is shutting down')
  }

  const billingOf = (kind: AgentKind) => store.settings().billing[kind]

  const environment = (): NodeJS.ProcessEnv => {
    const base = filterTedEnv(options.env?.() ?? process.env)
    return {
      ...base,
      TED_HOME: home,
      PATH: [binDir, base.PATH].filter(Boolean).join(path.delimiter),
    }
  }

  function tell(what: 'finished' | 'authFailed', runId: string): void {
    const run = store.getRun(runId)
    if (!run) return
    const stopped = run.ended?.how === 'stopped'
    const lastLines = run.ended?.errorLines ?? []
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

  function follow(runId: string, { revived = false } = {}): void {
    const release = options.idle?.hold()
    const controller = new AbortController()
    launchStops.set(runId, controller)
    const done = followHostLog(runId, revived, controller.signal)
      .catch((error: unknown) => console.error(`stopped following Run ${runId}:`, error))
      .finally(() => {
        following.delete(runId)
        generations.delete(runId)
        if (launchStops.get(runId) === controller) launchStops.delete(runId)
        replacing.delete(runId)
        outdated.delete(runId)
        stopRequested.delete(runId)
        release?.()
      })
    following.set(runId, done)
  }

  async function followHostLog(
    runId: string,
    revived: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    const files = runFiles(path.join(runsDir, runId))
    let offset = store.runReadOffset(runId)
    const agent = agents.get(store.getRun(runId)?.agent ?? 'claude')
    const generation = await generationBefore(files.log, offset, (line) =>
      agent.sessionContinuedFrom(line),
    )
    generations.set(runId, generation)
    let awaitingStart = revived || offset === 0 ? Date.now() + stopGraceMs : undefined
    let lockCheckedAt = 0
    let reconciled = false
    const last = await lastStartRecord(path.join(runsDir, runId))
    if (last?.permissions !== undefined) store.setRunPermissions(runId, last.permissions)
    if (last !== undefined && !(last.v >= oldestHost)) {
      outdated.add(runId)
      if (store.getRun(runId)?.state === 'idle') void replaceWhenIdle(runId)
    }
    while (!closed) {
      const started = awaitingStart === undefined
      let batch = await readRecords(files.log, offset)
      let hostGone = false
      if (
        started &&
        batch.toOffset === offset &&
        (replacing.has(runId) || Date.now() - lockCheckedAt >= lockCheckMs)
      ) {
        lockCheckedAt = Date.now()
        if (!isLockHeld(files.lock)) {
          hostGone = true
          lockCheckedAt = 0
          batch = await readRecords(files.log, offset)
        }
      }
      if (
        awaitingStart !== undefined &&
        (batch.records.some(({ record }) => record.t === 'start') || Date.now() > awaitingStart)
      ) {
        awaitingStart = undefined
      }
      if (signal.aborted) replacing.delete(runId)
      const swapping = replacing.has(runId)
      if (swapping && (batch.toOffset > offset || hostGone)) {
        const exited = batch.records.some(({ record }) => record.t === 'exit')
        const kept = batch.records.filter(({ record }) => record.t !== 'exit')
        commitBatch(runId, { ...batch, records: kept }, false, generation)
        offset = batch.toOffset
        if (exited || hostGone) {
          for (let waited = 0; isLockHeld(files.lock) && waited < stopGraceMs; waited += pollMs) {
            await sleep(pollMs)
          }
          const run = store.getRun(runId)
          if (!run) return
          let spawned: ReturnType<typeof spawnHost> | undefined
          try {
            await untilCanceled(
              withRunPermissions(store, run, async () => {
                signal.throwIfAborted()
                const before = await startRecordCount(path.join(runsDir, runId))
                signal.throwIfAborted()
                const env = await prepareReplacement(runId, signal)
                signal.throwIfAborted()
                spawned = spawnHost(path.join(runsDir, runId), env)
                const host = spawned
                await waitForStart(runId, before, () => killSpawnedHostGroup(host), signal)
              }),
              signal,
            )
          } catch (error) {
            if (!signal.aborted) throw error
            if (!stopRequested.has(runId)) return
            if (spawned) killSpawnedHostGroup(spawned)
            const latest = await lastStartRecord(path.join(runsDir, runId))
            if (latest?.permissions !== undefined)
              store.setRunPermissions(runId, latest.permissions)
            commitBatch(
              runId,
              {
                ...batch,
                records: batch.records.filter(({ record }) => record.t === 'exit'),
              },
              true,
              generation,
            )
            return
          } finally {
            replacing.delete(runId)
          }
          awaitingStart = Date.now() + stopGraceMs
        }
        continue
      }
      if (batch.toOffset > offset || hostGone) {
        const finished = commitBatch(runId, batch, hostGone && batch.atEnd, generation)
        offset = batch.toOffset
        if (finished) return
      }
      if (
        !reconciled &&
        batch.atEnd &&
        awaitingStart === undefined &&
        !hostGone &&
        isLockHeld(files.lock)
      ) {
        store.reconcileRunState(runId)
        reconciled = true
      }
      if (batch.atEnd) await sleep(pollMs)
    }
  }

  function commitBatch(
    runId: string,
    batch: RecordBatch,
    hostGone: boolean,
    generation: Generation,
  ): boolean {
    const agent = agents.get(store.getRun(runId)?.agent ?? 'claude')
    const lines: string[] = []
    let lastAt: string | undefined
    let state: RunState | undefined
    let sessionId: string | undefined
    let authFailed = false
    let problem: RunProblem | undefined
    let autoMode: AutoModeSignal | undefined
    let boundary = false
    let usage: UsageSignal | undefined
    let retrying: boolean | undefined
    let credential: CredentialReport | undefined
    const windows = new Map<string, PlanWindow>()
    const prompts: (PermissionPrompt & { generation: number })[] = []
    const closedPermissions: string[] = []
    const accepted: string[] = []
    let exit: Extract<HostRecord, { t: 'exit' }> | undefined
    const startedWith = generation.count
    generation.readTo = batch.toOffset
    if (batch.records.some(({ record }) => record.t === 'out' || record.t === 'err')) {
      heard.set(runId, Date.now())
    }
    for (const { record } of batch.records) {
      if (record.t === 'out') {
        lines.push(record.line)
        lastAt = record.at
        const text = agent.acceptedTextFrom(record.line)
        if (text !== undefined) accepted.push(text)
        state = agent.stateFrom(record.line) ?? state
        sessionId = agent.sessionIdFrom(record.line) ?? sessionId
        problem = agent.problemFrom(record.line) ?? problem
        authFailed ||= agent.authErrorFrom(record.line)
        autoMode = agent.autoModeFrom(record.line) ?? autoMode
        boundary ||= agent.boundaryFrom(record.line)
        usage = mergeUsage(usage, agent.usageFrom(record.line))
        retrying = agent.retryingFrom(record.line) ?? retrying
        credential ??= agent.credentialFrom(record.line)
        for (const window of agent.planUsageFrom(record.line) ?? [])
          windows.set(window.window, window)
        const prompt = agent.permissionPromptFrom(record.line, (matches) => {
          for (let i = lines.length - 2; i >= 0; i--) {
            const line = lines[i]
            if (line !== undefined && matches(line)) return line
          }
          return output.findLast(runId, (entry) => matches(entry.line))?.line
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
        generation.sessionSeen ||= agent.sessionContinuedFrom(record.line)
      } else if (record.t === 'err') {
        generation.errors = [...generation.errors, record.line].slice(-errorLinesKept)
      } else if (record.t === 'start') {
        if (record.permissions !== undefined) store.setRunPermissions(runId, record.permissions)
        generation.count += 1
        generation.sessionSeen = false
        generation.errors = []
      } else if (record.t === 'exit') {
        state = 'finished'
        exit = record
      }
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
      ...(autoMode === 'unavailable' && { autoModeUnavailable: true }),
      toOffset: batch.toOffset,
      ...(lines.length > 0 && { output: { ...(lastAt !== undefined && { lastAt }) } }),
      ...(state && { state }),
      ...(sessionId !== undefined && { sessionId }),
      ...(problem !== undefined && { problem }),
      ...(state === 'finished' && { ending: ending(runId, exit, generation) }),
      ...(retrying !== undefined && { retrying }),
    })
    if (credential) {
      const report = credential
      tellObservers(runId, (observer, run) => observer.credential?.(run, report))
    }
    if (windows.size > 0) {
      const shown = [...windows.values()]
      tellObservers(runId, (observer, run) => observer.planUsage?.(run, shown))
    }
    if (usage) {
      const signal = usage
      tellObservers(runId, (observer, run) => observer.usage?.(run, signal))
    }
    if (retrying === true) tellObservers(runId, (observer, run) => observer.retrying?.(run))
    if (autoMode !== undefined) {
      const signal = autoMode
      tellObservers(runId, (observer, run) => observer.autoMode?.(run, signal))
    }
    if (accepted.length > 0) tellAccepted(runId, accepted)
    if (boundary && state !== 'finished') {
      tellObservers(runId, (observer, run) => observer.boundary?.(run))
    }
    if (state === 'idle') {
      tellObservers(runId, (observer, run) => observer.settled?.(run))
      if (outdated.has(runId)) void replaceWhenIdle(runId)
    }
    if (authFailed) tell('authFailed', runId)
    if (state === 'finished') {
      heard.delete(runId)
      tell('finished', runId)
    }
    return state === 'finished'
  }

  function ending(
    runId: string,
    exit: Extract<HostRecord, { t: 'exit' }> | undefined,
    generation: Generation,
  ): RunEnding {
    const requested = stopRequested.delete(runId)
    const stopped = exit?.stopped === true || requested
    return {
      how: stopped ? 'stopped' : exit ? 'exited' : 'lost',
      ...(exit?.code !== undefined && exit.code !== null && { code: exit.code }),
      ...(exit?.signal !== undefined && exit.signal !== null && { signal: exit.signal }),
      ...(exit?.error !== undefined && { error: oneLine(exit.error) }),
      errorLines: generation.errors.map(oneLine),
      ...(generation.count > 1 && !generation.sessionSeen && { resumeFailed: true }),
      at: new Date().toISOString(),
    }
  }

  async function replaceWhenIdle(runId: string): Promise<void> {
    const run = store.getRun(runId)
    const signal = launchStops.get(runId)?.signal
    if (
      !signal ||
      signal.aborted ||
      closed ||
      shuttingDown ||
      run?.state !== 'idle' ||
      run.sessionId === undefined
    )
      return
    if (replacing.has(runId) || !outdated.delete(runId)) return
    try {
      const runDir = path.join(runsDir, runId)
      const start = await startRecord(runDir)
      if (!start) return
      const pid = await hostPid(runDir, start)
      if (!(await holdsLock(runFiles(runDir).lock, pid)) || signal.aborted) return
      replacing.add(runId)
      await signalHost(runDir, pid, 'SIGTERM')
    } catch (error) {
      replacing.delete(runId)
      console.error(`couldn’t replace Run ${runId}’s old host:`, error)
    }
  }

  async function prepareReplacement(
    runId: string,
    signal: AbortSignal,
  ): Promise<NodeJS.ProcessEnv> {
    signal.throwIfAborted()
    const run = store.getRun(runId)
    if (!run || run.sessionId === undefined) throw new Error('No session to replace')
    const runDir = path.join(runsDir, runId)
    const files = runFiles(runDir)
    const permissions = runPermissions(store, run)
    const env = await readRunEnv(files.env)
    signal.throwIfAborted()
    const launch = agents.get(run.agent).launch({
      prompt: '',
      runDir,
      env: runEnv(runId, env),
      resume: run.sessionId,
      ...(run.model !== undefined && !run.usesDefaultModel && { model: run.model }),
      ...(run.effort !== undefined && { effort: run.effort }),
      permissions,
      ...((store.automationDrafts.get(runId) || store.sideChats.forRun(runId)) && {
        tools: 'none' as const,
      }),
      billing: billingOf(run.agent),
    })
    const inputFrom = await stat(files.input).then(
      (info) => info.size,
      () => 0,
    )
    signal.throwIfAborted()
    await writeLaunch(runDir, run.cwd, launch, permissions, inputFrom)
    signal.throwIfAborted()
    return launch.env
  }

  for (const run of store.listRuns()) if (run.state !== 'finished') follow(run.id)

  function spawnHost(runDir: string, env: NodeJS.ProcessEnv) {
    const entry = nodeEntry(hostMain, [runDir])
    const host = workCommand(entry.command, entry.args, store.settings().lowPriorityWork)
    const child = spawn(host.command, host.args, {
      detached: true,
      stdio: 'ignore',
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      cwd: runDir,
    })
    child.unref()
    return child
  }

  function killSpawnedHostGroup(host: ReturnType<typeof spawnHost>): void {
    if (host.exitCode === null && host.signalCode === null) killGroup(host.pid)
  }

  async function waitForStart(
    runId: string,
    before: number,
    kill: () => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    const runDir = path.join(runsDir, runId)
    try {
      for (let waited = 0; (await startRecordCount(runDir)) === before; waited += pollMs) {
        signal?.throwIfAborted()
        if (waited >= stopGraceMs) {
          await kill()
          throw new Error(
            'The agent did not start; TED stopped its host and agent before releasing the permission handoff',
          )
        }
        await sleep(pollMs)
      }
      signal?.throwIfAborted()
      const start = await lastStartRecord(runDir)
      if (start?.permissions !== undefined) {
        store.setRunPermissions(runId, start.permissions)
        await store.persisted()
      }
    } catch (error) {
      if (signal?.aborted && !closed) await kill()
      throw error
    }
  }

  function runEnv(id: string, env: Record<string, string>): NodeJS.ProcessEnv {
    if (store.sideChats.forRun(id))
      return Object.fromEntries(
        Object.entries({ ...environment(), TED_HOME: home }).filter(
          ([name]) => !/^TED_(RUN|TASK|PLAN|RUN_TOKEN|RUN_CAPABILITY)$/.test(name),
        ),
      )
    return {
      ...environment(),
      ...env,
      TED_HOME: home,
      TED_RUN: id,
      [runTokenEnv]: tokens.issue(id),
      PATH: environment().PATH,
    }
  }

  async function writeLaunch(
    runDir: string,
    cwd: string,
    launch: AgentLaunch,
    permissions: PermissionMode,
    inputFrom?: number,
    promptInput?: { ids: string[]; text: string },
  ): Promise<void> {
    const sideId = path.basename(runDir)
    if (store.sideChats.forRun(sideId)) await sideFolder(home, sideId)
    for (const [name, content] of Object.entries(launch.files)) {
      await writeFile(path.join(runDir, name), content, { mode: 0o600 })
    }
    const launchFile: LaunchFile = {
      launchId: randomUUID(),
      permissions,
      authority: launchAuthority(store),
      command: launch.command,
      args: launch.args,
      cwd,
      input: launch.input,
      ...(launch.driver !== undefined && { driver: launch.driver }),
      ...(inputFrom !== undefined && { inputFrom }),
    }
    const file = runFiles(runDir).launch
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(launchFile), { mode: 0o600 })
    await rename(tmp, file)
    if (promptInput?.ids.length) {
      const files = runFiles(runDir)
      writePromptInput(runDir, {
        forGeneration: (await startRecordCount(runDir)) + 1,
        deliveryIds: promptInput.ids,
        text: promptInput.text,
        outputFrom: await stat(files.log).then(
          (info) => info.size,
          () => 0,
        ),
        line: launch.input,
      })
    }
  }

  function readInput(file: string): Buffer {
    try {
      return readFileSync(file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return Buffer.alloc(0)
    }
  }
  function inputRecords(
    runId: string,
    input = readInput(runFiles(path.join(runsDir, runId)).input),
  ): QueuedInput[] {
    const files = runFiles(path.join(runsDir, runId))
    const parse = (bytes: Buffer) =>
      bytes
        .toString('utf8')
        .split('\n')
        .slice(0, -1)
        .flatMap((line) => {
          const record = readQueuedInput(line)
          return record ? [record] : []
        })
    const prompts = new Map<number, QueuedInput>()
    for (const record of parse(readInput(files.promptInputs)))
      prompts.set(record.forGeneration, record)
    return [...prompts.values(), ...parse(input)]
  }
  function inputAccepted(
    runId: string,
    record: QueuedInput,
    records: readonly QueuedInput[],
  ): boolean {
    const run = store.getRun(runId)
    if (!run) return false
    const siblings = records.filter(
      (r) => r.text === record.text && r.outputFrom === record.outputFrom,
    )
    const required = siblings.indexOf(record) + 1
    const { chat } = parsedOutput(output, agents, run)
    return (
      chat
        .entries()
        .filter(
          (entry) =>
            entry.kind === 'user' &&
            (chat.userFrom(entry.key) ?? 0) >= record.outputFrom &&
            entry.text.trim() === record.text.trim(),
        ).length >= required
    )
  }
  function writePromptInput(runDir: string, record: QueuedInput): void {
    const file = runFiles(runDir).promptInputs
    const earlier = readInput(file)
    const fd = openSync(file, 'a', 0o600)
    try {
      if (earlier.length > 0 && earlier.at(-1) !== 10)
        ftruncateSync(fd, earlier.lastIndexOf(10) + 1)
      const buffer = Buffer.from(`${JSON.stringify(record)}\n`)
      for (let offset = 0; offset < buffer.length; )
        offset += writeSync(fd, buffer, offset, buffer.length - offset)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }

  const manager: RunManager = {
    output,
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
      messageIds,
    }) {
      refuseWhileShuttingDown()
      const agent = agents.get(kind)
      const release = await acquireRunPermissions(store, { taskId })
      let handedOff = false
      try {
        const runDir = path.join(runsDir, id)
        await mkdir(runDir, { mode: 0o700, recursive: store.sideChats.forRun(id) !== undefined })
        permissions = runPermissions(store, { taskId })
        const launch = agent.launch({
          prompt,
          runDir,
          env: runEnv(id, env),
          ...(resume !== undefined && { resume }),
          ...(model !== undefined && { model }),
          ...(effort !== undefined && { effort }),
          permissions,
          ...((store.automationDrafts.get(id) || store.sideChats.forRun(id)) && {
            tools: 'none' as const,
          }),
          billing: billingOf(kind),
        })
        await writeLaunch(
          runDir,
          cwd,
          launch,
          permissions,
          undefined,
          messageIds && { ids: messageIds, text: prompt },
        )
        await writeFile(runFiles(runDir).env, JSON.stringify(env), { mode: 0o600 })

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
        const host = spawnHost(runDir, launch.env)
        follow(id)
        handedOff = true
        void waitForStart(id, 0, () => {
          killSpawnedHostGroup(host)
        })
          .catch((error: unknown) => console.error('The Run host did not start:', error))
          .finally(release)
        return run
      } finally {
        if (!handedOff) release()
      }
    },
    async revive(runId, { prompt, env = {}, messageIds, flags }) {
      refuseWhileShuttingDown()
      const run = store.getRun(runId)
      if (run?.state !== 'finished' || following.has(runId)) {
        throw new Error(`Run ${runId} isn't finished`)
      }
      if (run.sessionId === undefined && store.sideChats.forRun(runId)?.contextSent !== false)
        throw new Error(`Run ${runId} has no session to resume`)
      const sessionId = run.sessionId
      const release = await acquireRunPermissions(store, run)
      let handedOff = false
      try {
        const runDir = path.join(runsDir, runId)
        const files = runFiles(runDir)
        for (let waited = 0; isLockHeld(files.lock); waited += pollMs) {
          if (waited >= stopGraceMs) throw new Error(`Run ${runId}'s old host is still running`)
          await sleep(pollMs)
        }
        const permissions = runPermissions(store, run)
        const choice = flags ?? run
        const launch = agents.get(run.agent).launch({
          prompt,
          runDir,
          env: runEnv(runId, env),
          ...(sessionId !== undefined && { resume: sessionId }),
          ...(choice.model !== undefined && !choice.usesDefaultModel && { model: choice.model }),
          ...(choice.effort !== undefined && { effort: choice.effort }),
          permissions,
          ...((store.automationDrafts.get(runId) || store.sideChats.forRun(runId)) && {
            tools: 'none' as const,
          }),
          billing: billingOf(run.agent),
        })
        const inputFrom = await stat(files.input).then(
          (info) => info.size,
          () => 0,
        )
        await writeLaunch(
          runDir,
          run.cwd,
          launch,
          permissions,
          inputFrom,
          messageIds && { ids: messageIds, text: prompt },
        )
        await writeFile(files.env, JSON.stringify(env), { mode: 0o600 })
        refuseWhileShuttingDown()
        stopRequested.delete(runId)
        const revived = store.reviveRun(runId, flags)
        await store.persisted()
        const before = await startRecordCount(runDir)
        const host = spawnHost(runDir, launch.env)
        follow(runId, { revived: true })
        handedOff = true
        void waitForStart(runId, before, () => {
          killSpawnedHostGroup(host)
        })
          .catch((error: unknown) => console.error('The revived Run host did not start:', error))
          .finally(release)
        return revived
      } finally {
        if (!handedOff) release()
      }
    },
    async restart(runId, flags) {
      refuseWhileShuttingDown()
      const run = store.getRun(runId)
      if (!run || run.state === 'finished' || !following.has(runId)) {
        throw new Error(`Run ${runId} isn't live`)
      }
      if (run.sessionId === undefined) throw new Error(`Run ${runId} has no session to resume`)
      const sessionId = run.sessionId
      const signal = launchStops.get(runId)?.signal
      if (!signal) throw new Error(`Run ${runId} has no live launch controller`)
      signal.throwIfAborted()
      const runDir = path.join(runsDir, runId)
      const start = await lastStartRecord(runDir)
      if (!start) throw new Error(`Run ${runId}'s host never started`)
      signal.throwIfAborted()
      if (replacing.has(runId)) throw new Error(`Run ${runId}'s host is being replaced`)
      if (start.v < oldestHost) {
        const pid = await hostPid(runDir, start)
        if (!(await holdsLock(runFiles(runDir).lock, pid))) {
          throw new Error(`Run ${runId}'s host is no longer running`)
        }
        const before = await startRecordCount(runDir)
        signal.throwIfAborted()
        const restarted = store.restartRun(runId, flags)
        outdated.delete(runId)
        replacing.add(runId)
        await signalHost(runDir, pid, 'SIGTERM')
        await waitForStart(runId, before, () => killHostGroup(runDir, pid), signal)
        return store.getRun(runId) ?? restarted
      }
      return untilCanceled(
        withRunPermissions(store, run, async () => {
          signal.throwIfAborted()
          const permissions = runPermissions(store, run)
          const launch = agents.get(run.agent).launch({
            prompt: '',
            runDir,
            env: {},
            resume: sessionId,
            ...(flags.model !== undefined && !flags.usesDefaultModel && { model: flags.model }),
            ...(flags.effort !== undefined && { effort: flags.effort }),
            permissions,
            ...((store.automationDrafts.get(runId) || store.sideChats.forRun(runId)) && {
              tools: 'none' as const,
            }),
            billing: billingOf(run.agent),
          })
          await writeLaunch(runDir, run.cwd, launch, permissions)
          signal.throwIfAborted()
          const before = await startRecordCount(runDir)
          const pid = await hostPid(runDir, start)
          signal.throwIfAborted()
          const restarted = store.restartRun(runId, flags)
          await signalHost(runDir, pid, 'SIGHUP')
          await waitForStart(runId, before, () => killHostGroup(runDir, pid), signal)
          return store.getRun(runId) ?? restarted
        }),
        signal,
      )
    },
    lastHeard: (runId) => heard.get(runId),
    async dispatch(runId, messages, steer, canDispatch) {
      const run = store.getRun(runId)
      if (!run || run.state === 'finished') throw new Error(`no live Run ${runId}`)
      const agent = agents.get(run.agent)
      const files = runFiles(path.join(runsDir, runId))
      let generation = 0
      for (let waited = 0; generation === 0; waited += pollMs) {
        try {
          const read = generations.get(runId)
          generation = (read?.count ?? 0) + startsFrom(files.log, read?.readTo ?? 0)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        if (generation > 0) break
        if (waited >= stopGraceMs || store.getRun(runId)?.state === 'finished')
          throw new Error('The Run host did not start')
        if (!canDispatch()) return false
        await sleep(pollMs)
      }
      if (!canDispatch()) return false
      const inputBytes = readInput(files.input)
      const input = inputBytes.toString('utf8')
      const records = inputRecords(runId, inputBytes)
      const accepted = (record: QueuedInput) => inputAccepted(runId, record, records)
      const usable = records.filter(
        (record) => record.forGeneration === generation || accepted(record),
      )
      const missing = messages.filter(
        (message) =>
          canDispatch(message.id) &&
          !usable.some((record) => record.deliveryIds.includes(message.id)),
      )
      if (missing.length > 0) {
        const outputFrom = statSync(files.log).size
        const additions = missing.map((message) => ({
          forGeneration: generation,
          deliveryIds: [message.id],
          text: message.text,
          outputFrom,
          line: steer ? agent.steer(message.text) : agent.message(message.text),
        }))
        const buffer = Buffer.from(
          `${additions.map((record) => JSON.stringify(record)).join('\n')}\n`,
        )
        const fd = openSync(files.input, 'a', 0o600)
        try {
          if (input !== '' && !input.endsWith('\n'))
            ftruncateSync(fd, inputBytes.lastIndexOf(10) + 1)
          for (let offset = 0; offset < buffer.length; )
            offset += writeSync(fd, buffer, offset, buffer.length - offset)
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
        records.push(...additions)
        usable.push(...additions)
      }
      const relevant = usable.filter((record) =>
        record.deliveryIds.some((id) => messages.some((message) => message.id === id)),
      )
      if (relevant.length === 0) return false
      for (let waited = 0; !relevant.every(accepted); waited += pollMs) {
        if (waited >= 10_000 || store.getRun(runId)?.state === 'finished')
          throw new Error(
            'The agent did not acknowledge its queued input; Retry will check the saved delivery before sending again',
          )
        await sleep(pollMs)
      }
      return true
    },
    inputDispatched(runId, messageId) {
      return inputRecords(runId).some((record) => record.deliveryIds.includes(messageId))
    },
    initialInputIds(runId) {
      const run = store.getRun(runId)
      return inputRecords(runId, Buffer.alloc(0))
        .filter((record) => record.forGeneration === 1 && record.text === run?.prompt)
        .flatMap((record) => record.deliveryIds)
    },
    acceptedInputs(runId) {
      const records = inputRecords(runId)
      return records
        .filter((record) => inputAccepted(runId, record, records))
        .flatMap((record) => record.deliveryIds)
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
      launchStops
        .get(runId)
        ?.abort(new RequestError(409, 'The Run was stopped; its pending launch was canceled'))
      const runDir = path.join(runsDir, runId)
      const timeout = sleep(stopGraceMs).then(() => 'timeout' as const)
      let start = await startRecord(runDir)
      for (let waited = 0; !start && waited < stopGraceMs; waited += pollMs) {
        await sleep(pollMs)
        start = await startRecord(runDir)
      }
      if (!start) {
        // No host holds the Run: it refused a launch from an earlier daemon, or died first.
        if (!isLockHeld(runFiles(runDir).lock)) return void (await done)
        throw new Error(`Run ${runId}'s host never started`)
      }
      let held = isLockHeld(runFiles(runDir).lock)
      for (let waited = 0; !held && waited < stopGraceMs; waited += pollMs) {
        const ended = await Promise.race([done.then(() => true), sleep(pollMs).then(() => false)])
        if (ended) return
        held = isLockHeld(runFiles(runDir).lock)
      }
      if (!held) return void (await done)
      const pid = await hostPid(runDir, start)
      await signalHost(runDir, pid, 'SIGTERM')
      if ((await Promise.race([done, timeout])) === 'timeout') {
        if (await holdsLock(runFiles(runDir).lock, pid)) {
          signal((await lastStartRecord(runDir))?.agentPid ?? null, 'SIGKILL')
          signal(pid, 'SIGKILL')
        }
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
      shuttingDown = true
      await revokeLaunchAuthority(store)
      closed = true
      for (const controller of launchStops.values())
        controller.abort(new RequestError(503, 'TED is shutting down'))
      await Promise.all(following.values())
    },
  }
  return manager
}

async function untilCanceled<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {}
  const canceled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason)
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
  try {
    return await Promise.race([work, canceled])
  } finally {
    signal.removeEventListener('abort', abort)
  }
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

async function generationBefore(
  log: string,
  offset: number,
  sessionContinuedFrom: (line: string) => boolean,
): Promise<Generation> {
  const generation: Generation = { count: 0, sessionSeen: true, errors: [], readTo: offset }
  if (offset === 0) return generation
  const handle = await open(log, 'r').catch(() => undefined)
  if (!handle) return generation
  let text: string
  try {
    const buffer = Buffer.alloc(offset)
    const { bytesRead } = await handle.read(buffer, 0, offset, 0)
    text = buffer.toString('utf8', 0, bytesRead)
  } finally {
    await handle.close()
  }
  for (const line of text.split('\n')) {
    if (line === '') continue
    const record = JSON.parse(line) as HostRecord
    if (record.t === 'start') {
      generation.count += 1
      generation.sessionSeen = false
      generation.errors = []
    } else if (record.t === 'out') {
      generation.sessionSeen ||= sessionContinuedFrom(record.line)
    } else if (record.t === 'err') {
      generation.errors = [...generation.errors, record.line].slice(-errorLinesKept)
    }
  }
  return generation
}

async function hostPid(
  runDir: string,
  first: Extract<HostRecord, { t: 'start' }>,
): Promise<number> {
  const written = Number(await readFile(runFiles(runDir).pid, 'utf8').catch(() => ''))
  return Number.isInteger(written) && written > 0 ? written : first.hostPid
}

interface Generation {
  count: number
  sessionSeen: boolean
  errors: string[]
  readTo: number
}

function startsFrom(log: string, offset: number): number {
  const fd = openSync(log, 'r')
  try {
    const length = fstatSync(fd).size - offset
    if (length <= 0) return 0
    const buffer = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const bytes = readSync(fd, buffer, read, length - read, offset + read)
      if (bytes === 0) break
      read += bytes
    }
    return buffer
      .toString('utf8', 0, read)
      .split('\n')
      .filter((line) => line.startsWith('{"t":"start"')).length
  } finally {
    closeSync(fd)
  }
}

const errorLinesKept = 8

function oneLine(text: string): string {
  const line = redactSecrets(text).replace(/\s+$/, '')
  return line.length > 300 ? `${line.slice(0, 299)}…` : line
}

async function readRunEnv(file: string): Promise<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    )
  } catch {
    return {}
  }
}

const lastStartRecord = async (runDir: string) => (await startRecords(runDir)).at(-1)

const startRecordCount = async (runDir: string) => (await startRecords(runDir)).length

// A saved pid can belong to another process once the host has exited, for example
// after a reboot, so only signal a pid that still holds the Run's host lock.
async function signalHost(runDir: string, pid: number, name: NodeJS.Signals): Promise<void> {
  if (await holdsLock(runFiles(runDir).lock, pid)) signal(pid, name)
}

async function killHostGroup(runDir: string, pid: number): Promise<void> {
  if (await holdsLock(runFiles(runDir).lock, pid)) killGroup(pid)
}

function killGroup(pid: number | undefined): void {
  try {
    signalGroup(pid, 'SIGKILL')
  } catch {}
}

function signal(pid: number | null, name: NodeJS.Signals): void {
  try {
    signalProcess(pid, name)
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
