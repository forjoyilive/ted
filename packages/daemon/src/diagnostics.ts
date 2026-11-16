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
  type ProcessUsage,
  type Run,
  type RunDiagnostics,
  type TokenUse,
  tedPaths,
} from '@ted/protocol'
import { shortReference } from '@ted/protocol/reference'
import type { Agents } from './agents/index.ts'
import { availableMemory, totalMemory } from './busy.ts'
import { processMemory } from './process-memory.ts'
import { redactSecrets } from './redact.ts'
import { runFiles } from './runs/host-files.ts'
import { parsedOutput } from './runs/parsed-output.ts'
import { currentHostPid, type RunManager } from './runs/run-manager.ts'
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

interface PsRow {
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

const hostPids = (home: string, live: Run[]) =>
  Promise.all(
    live.map((run) => (run.asleep ? undefined : currentHostPid(path.join(home, 'runs', run.id)))),
  )

async function ownedProcesses(home: string, live: Run[]): Promise<ProcessInfo[]> {
  const [pids, rows] = await Promise.all([hostPids(home, live), processes()])
  const hosts = new Map<number, string>()
  pids.forEach((pid, index) => {
    const run = live[index]
    if (pid !== undefined && run) hosts.set(pid, run.id)
  })
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const ownerOf = (pid: number): ProcessInfo['owner'] | undefined => {
    const seen = new Set<number>()
    for (let current = byPid.get(pid); current && !seen.has(current.pid); ) {
      seen.add(current.pid)
      const runId = hosts.get(current.pid)
      if (runId !== undefined) return { runId }
      if (current.pid === process.pid) return 'daemon'
      current = byPid.get(current.ppid)
    }
    return undefined
  }
  const owned = rows.flatMap((row) => {
    if (row.ppid === process.pid && (row.command === 'ps' || row.command === 'footprint')) return []
    const owner = ownerOf(row.pid)
    return owner === undefined ? [] : [{ ...row, owner }]
  })
  const memory = await processMemory(
    owned.map((row) => row.pid),
    { resident: new Map(owned.map((row) => [row.pid, row.memoryBytes])) },
  )
  return owned.map((row) => ({ ...row, memoryBytes: memory.get(row.pid) ?? row.memoryBytes }))
}

export async function processUsage(
  sources: Pick<DiagnosticsSources, 'home' | 'store'>,
): Promise<ProcessUsage> {
  const owned = await ownedProcesses(sources.home, sources.store.liveRuns())
  return {
    cpuPercent: owned.reduce((sum, p) => sum + p.cpuPercent, 0),
    memoryBytes: owned.reduce((sum, p) => sum + p.memoryBytes, 0),
  }
}

export async function memoryUse(
  sources: Pick<DiagnosticsSources, 'home' | 'store'>,
): Promise<MemoryUse> {
  const live = sources.store.liveRuns()
  const [owned, pids, store] = await Promise.all([
    ownedProcesses(sources.home, live),
    hostPids(sources.home, live),
    storeFileSizes(tedPaths(sources.home).store),
  ])
  const hosts = new Set(pids.flatMap((pid) => (pid === undefined ? [] : [pid])))
  const asleep = live.filter((run) => run.asleep).length
  const group = (rows: ProcessInfo[], count = rows.length): MemoryGroup => ({
    count,
    bytes: rows.reduce((sum, row) => sum + row.memoryBytes, 0),
  })
  const agents = owned.filter((row) => row.owner !== 'daemon' && !hosts.has(row.pid))
  const usage = process.memoryUsage()
  const daemonBytes = owned.find((row) => row.pid === process.pid)?.memoryBytes ?? usage.rss
  return {
    daemon: { bytes: daemonBytes, heapBytes: usage.heapUsed, externalBytes: usage.external },
    hosts: group(owned.filter((row) => hosts.has(row.pid))),
    agents: group(
      agents,
      new Set(agents.map((row) => (row.owner === 'daemon' ? '' : row.owner.runId))).size,
    ),
    other: group(owned.filter((row) => row.owner === 'daemon' && row.pid !== process.pid)),
    store,
    ...(asleep > 0 && { asleepRuns: asleep }),
  }
}

export async function collectDiagnostics(sources: DiagnosticsSources): Promise<Diagnostics> {
  const all = sources.store.listRuns()
  const recent = new Set(all.slice(-runsShown))
  const runs = all.filter((run) => run.state !== 'finished' || recent.has(run)).reverse()
  const [owned, availableBytes] = await Promise.all([
    ownedProcesses(
      sources.home,
      runs.filter((run) => run.state !== 'finished'),
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

export async function report(sources: DiagnosticsSources): Promise<string> {
  const diagnostics = await collectDiagnostics(sources)
  const settings = sources.store.settings()
  const log = await tail(tedPaths(sources.home).daemonLog, reportLogBytes)
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
        `${p.pid} (parent ${p.ppid}) ${p.command} · ${p.owner === 'daemon' ? 'daemon' : `Run ${shortReference(p.owner.runId)}`} · CPU ${p.cpuPercent}% · ${megabytes(p.memoryBytes)}`,
    ),
    '',
    `Daemon log${log.truncated ? ' (last 64 KB)' : ''}`,
    log.text,
  ]
  return redactSecrets(hideHome(lines.join('\n'), sources.home))
}

function hideHome(text: string, home: string): string {
  const user = os.homedir()
  return text.replaceAll(home, '<TED home>').replaceAll(user, '~')
}
