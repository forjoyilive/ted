import { execFile } from 'node:child_process'
import { open } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  type Diagnostics,
  type LogText,
  type MemoryGroup,
  type MemoryUse,
  type ProcessInfo,
  type ProcessRun,
  type ProcessRunRole,
  type ProcessUsage,
  type Run,
  type RunDiagnostics,
  type TokenUse,
  tedPaths,
} from '@ted/protocol'
import { memoryTotal, processName } from '@ted/protocol/memory'
import type { Agents } from './agents/index.ts'
import { availableMemory, totalMemory } from './busy.ts'
import { processMemory } from './process-memory.ts'
import { type ProcessRoot, processRoot } from './process-roots.ts'
import { redactSecrets } from './redact.ts'
import { runFiles } from './runs/host-files.ts'
import { parsedOutput } from './runs/parsed-output.ts'
import { type RunManager, startRecord } from './runs/run-manager.ts'
import type { RunOutputReader } from './runs/run-output.ts'
import { storeFileSizes } from './store/files.ts'
import type { TedStore } from './store/index.ts'

const execFileAsync = promisify(execFile)
const maxLogBytes = 256 * 1024
const runsShown = 50
const reportLogBytes = 64 * 1024

export interface DiagnosticsSources {
  home: string
  version: string
  store: TedStore
  agents: Agents
  runs: Pick<RunManager, 'output'>
}

export interface PsRow {
  pid: number
  ppid: number
  cpuPercent: number
  memoryBytes: number
  command: string
}

async function processes(): Promise<PsRow[]> {
  const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=,ppid=,pcpu=,rss=,comm='], {
    timeout: 5_000,
    maxBuffer: 8 * 1024 * 1024,
  })
  return stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(line)
    if (!match) return []
    const [, pid = '', ppid = '', cpu = '', rss = '', command = ''] = match
    return [
      {
        pid: Number(pid),
        ppid: Number(ppid),
        cpuPercent: Number(cpu),
        memoryBytes: Number(rss) * 1024,
        command: path.basename(command.trim()),
      },
    ]
  })
}

const finishedTokens = new WeakMap<
  RunOutputReader,
  Map<string, { stamp: string; tokens: TokenUse }>
>()

function tokenUse(sources: DiagnosticsSources, runs: Run[]): Map<string, TokenUse> {
  const { output } = sources.runs
  const read = (run: Run) => parsedOutput(output, sources.agents, run).tokenUse()
  const kept = finishedTokens.get(output) ?? new Map<string, { stamp: string; tokens: TokenUse }>()
  finishedTokens.set(output, kept)
  const shown = new Set(runs.map((run) => run.id))
  for (const id of kept.keys()) if (!shown.has(id)) kept.delete(id)

  const tokens = new Map<string, TokenUse>()
  for (const run of runs) {
    if (run.state !== 'finished') continue
    const stamp = output.stamp(run.id)
    let held = kept.get(run.id)
    if (held?.stamp !== stamp) {
      held = { stamp, tokens: read(run) }
      kept.set(run.id, held)
    }
    tokens.set(run.id, held.tokens)
  }
  for (const run of runs) {
    if (run.state === 'finished') continue
    kept.delete(run.id)
    tokens.set(run.id, read(run))
  }
  return tokens
}

type Describe = (run: Run) => ProcessRun

export function describeRun(store: TedStore): Describe {
  return (run) => {
    const task = run.taskId === undefined ? undefined : store.getTask(run.taskId)?.displayId
    const role: ProcessRunRole =
      store.sideChats.forRun(run.id) !== undefined
        ? 'side-chat'
        : run.parentRunId !== undefined
          ? 'sub-agent'
          : store.coordinators.forRun(run.id) !== undefined ||
              store.coordinators.endedForRun(run.id) !== undefined
            ? 'coordinator'
            : store.plans.get(run.id) !== undefined
              ? 'planning'
              : store.automations.firing(run.id) !== undefined
                ? 'automation'
                : run.taskId !== undefined
                  ? 'task-lead'
                  : 'run'
    return { runId: run.id, agent: run.agent, role, ...(task !== undefined && { task }) }
  }
}

export function classifyProcesses(
  rows: readonly PsRow[],
  daemonPid: number,
  hosts: ReadonlyMap<number, ProcessRun>,
  roots: (pid: number) => ProcessRoot | undefined,
): ProcessInfo[] {
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const classify = (pid: number): Omit<ProcessInfo, keyof PsRow> | undefined => {
    const seen = new Set<number>()
    let depth = 0
    for (let current = byPid.get(pid); current && !seen.has(current.pid); depth += 1) {
      seen.add(current.pid)
      const run = hosts.get(current.pid)
      if (run !== undefined) {
        const kind = depth === 0 ? 'run-host' : depth === 1 ? 'agent' : 'agent-tool'
        return { owner: { runId: run.runId }, kind, run }
      }
      const root = roots(current.pid)
      if (root !== undefined) {
        return {
          owner: 'daemon',
          kind: root.kind,
          ...(root.task !== undefined && { task: root.task }),
          ...(root.appName !== undefined && { appName: root.appName }),
        }
      }
      if (current.pid === daemonPid) {
        return { owner: 'daemon', kind: depth === 0 ? 'daemon' : 'other' }
      }
      current = byPid.get(current.ppid)
    }
    return undefined
  }
  return rows.flatMap((row) => {
    if (row.ppid === daemonPid && (row.command === 'ps' || row.command === 'footprint')) return []
    const found = classify(row.pid)
    return found === undefined ? [] : [{ ...row, ...found }]
  })
}

async function ownedProcesses(
  home: string,
  live: Run[],
  describe: Describe,
): Promise<ProcessInfo[]> {
  const [starts, rows] = await Promise.all([
    Promise.all(live.map((run) => startRecord(path.join(home, 'runs', run.id)))),
    processes(),
  ])
  const hosts = new Map<number, ProcessRun>()
  starts.forEach((start, index) => {
    const run = live[index]
    if (start && run) hosts.set(start.hostPid, describe(run))
  })
  const owned = classifyProcesses(rows, process.pid, hosts, processRoot)
  const memory = await processMemory(
    owned.map((row) => row.pid),
    { resident: new Map(owned.map((row) => [row.pid, row.memoryBytes])) },
  )
  return owned.map((row) => ({ ...row, memoryBytes: memory.get(row.pid) ?? row.memoryBytes }))
}

const kindGroups = {
  'run-host': 'hosts',
  agent: 'agents',
  'agent-tool': 'agentTools',
  check: 'checks',
  app: 'apps',
  other: 'other',
} as const

function memoryOf(owned: readonly ProcessInfo[], store: MemoryUse['store']): MemoryUse {
  const usage = process.memoryUsage()
  const group = (kind: keyof typeof kindGroups): MemoryGroup => {
    const rows = owned.filter((row) => row.kind === kind)
    return { count: rows.length, bytes: rows.reduce((sum, row) => sum + row.memoryBytes, 0) }
  }
  return {
    daemon: {
      bytes: owned.find((row) => row.kind === 'daemon')?.memoryBytes ?? usage.rss,
      heapBytes: usage.heapUsed,
      externalBytes: usage.external,
    },
    hosts: group('run-host'),
    agents: group('agent'),
    agentTools: group('agent-tool'),
    checks: group('check'),
    apps: group('app'),
    other: group('other'),
    store,
  }
}

export async function processUsage(
  sources: Pick<DiagnosticsSources, 'home' | 'store'>,
): Promise<ProcessUsage> {
  const [owned, store] = await Promise.all([
    ownedProcesses(sources.home, sources.store.liveRuns(), describeRun(sources.store)),
    storeFileSizes(tedPaths(sources.home).store),
  ])
  const memory = memoryOf(owned, store)
  return {
    cpuPercent: owned.reduce((sum, p) => sum + p.cpuPercent, 0),
    memoryBytes: memoryTotal(memory),
    memory,
  }
}

export async function memoryUse(
  sources: Pick<DiagnosticsSources, 'home' | 'store'>,
): Promise<MemoryUse> {
  return (await processUsage(sources)).memory
}

export async function collectDiagnostics(sources: DiagnosticsSources): Promise<Diagnostics> {
  const all = sources.store.listRuns()
  const recent = new Set(all.slice(-runsShown))
  const runs = all.filter((run) => run.state !== 'finished' || recent.has(run)).reverse()
  const [owned, availableBytes] = await Promise.all([
    ownedProcesses(
      sources.home,
      runs.filter((run) => run.state !== 'finished'),
      describeRun(sources.store),
    ),
    availableMemory(),
  ])
  const tokens = tokenUse(sources, runs)

  const runDiagnostics: RunDiagnostics[] = runs.map((run) => {
    const mine = owned.filter((p) => typeof p.owner === 'object' && p.owner.runId === run.id)
    return {
      runId: run.id,
      agent: run.agent,
      state: run.state,
      ...(run.taskId !== undefined && { taskId: run.taskId }),
      startedAt: run.startedAt,
      cpuPercent: Math.round(mine.reduce((sum, p) => sum + p.cpuPercent, 0) * 10) / 10,
      memoryBytes: mine.reduce((sum, p) => sum + p.memoryBytes, 0),
      tokens: tokens.get(run.id) ?? { input: 0, output: 0 },
    }
  })

  return {
    runs: runDiagnostics,
    processes: owned,
    memory: { totalBytes: totalMemory(), availableBytes },
  }
}

async function tail(file: string, maxBytes: number): Promise<LogText> {
  const handle = await open(file, 'r').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (!handle) return { text: '', truncated: false }
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, maxBytes)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, size - length)
    const text = buffer.toString('utf8', 0, bytesRead)
    if (length === size) return { text, truncated: false }
    return { text: text.slice(text.indexOf('\n') + 1), truncated: true }
  } finally {
    await handle.close()
  }
}

export function readDaemonLog(home: string): Promise<LogText> {
  return tail(tedPaths(home).daemonLog, maxLogBytes)
}

export function readRunOutput(home: string, runId: string): Promise<LogText> {
  return tail(runFiles(path.join(home, 'runs', runId)).log, maxLogBytes)
}

const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`

export async function report(
  sources: DiagnosticsSources,
  { includeLog = true }: { includeLog?: boolean } = {},
): Promise<string> {
  const diagnostics = await collectDiagnostics(sources)
  const settings = sources.store.settings()
  const log = includeLog ? await tail(tedPaths(sources.home).daemonLog, reportLogBytes) : undefined
  const { totalBytes, availableBytes } = diagnostics.memory
  const lines = [
    `TED ${sources.version}`,
    `Created ${new Date().toISOString()}`,
    `${os.type()} ${os.release()} ${os.arch()}, Node ${process.versions.node}`,
    `Memory: ${megabytes(availableBytes)} available of ${megabytes(totalBytes)}`,
    `Settings: appearance ${settings.appearance}, terminal font size ${settings.terminalFontSize}, Developer mode ${settings.developerMode ? 'on' : 'off'}`,
    '',
    'Runs',
    ...diagnostics.runs.map(
      (run) =>
        `${run.runId} ${run.agent} ${run.state} started ${run.startedAt}${run.taskId !== undefined ? ` Task ${run.taskId}` : ''} · CPU ${run.cpuPercent}% · ${megabytes(run.memoryBytes)} · tokens ${run.tokens.input} in, ${run.tokens.output} out`,
    ),
    '',
    'Processes',
    ...diagnostics.processes.map(
      (p) =>
        `${p.pid} (parent ${p.ppid})${includeLog ? ` ${p.command}` : ''} · ${processName(p)} · CPU ${p.cpuPercent}% · ${megabytes(p.memoryBytes)}`,
    ),
    ...(log
      ? ['', `Daemon log${log.truncated ? ' (last 64 KB)' : ''}`, log.text]
      : ['', 'Daemon log and process command lines left out']),
  ]
  return redactSecrets(hideHome(lines.join('\n'), sources.home))
}

function hideHome(text: string, home: string): string {
  const user = os.homedir()
  return text.replaceAll(home, '<TED home>').replaceAll(user, '~')
}
