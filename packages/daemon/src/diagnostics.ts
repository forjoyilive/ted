import { execFile } from 'node:child_process'
import { open, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  type Diagnostics,
  type LogText,
  type ProcessInfo,
  type Run,
  type RunDiagnostics,
  type TokenUse,
  tedPaths,
} from '@ted/protocol'
import type { Agents } from './agents/index.ts'
import { redactSecrets } from './redact.ts'
import { runFiles } from './runs/host-files.ts'
import { startRecord } from './runs/run-manager.ts'
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

async function availableMemory(): Promise<number> {
  const total = os.totalmem()
  if (process.platform === 'linux') {
    const meminfo = await readFile('/proc/meminfo', 'utf8').catch(() => '')
    const kb = /^MemAvailable:\s+(\d+) kB$/m.exec(meminfo)?.[1]
    if (kb !== undefined) return Math.min(total, Number(kb) * 1024)
  }
  if (process.platform === 'darwin') {
    const level = await execFileAsync('sysctl', ['-n', 'kern.memorystatus_level'], {
      timeout: 5_000,
    }).then(
      ({ stdout }) => Number(stdout.trim()),
      () => Number.NaN,
    )
    if (level > 0 && level <= 100) return Math.round((total * level) / 100)
  }
  return os.freemem()
}

function tokenUse(sources: DiagnosticsSources, run: Run): TokenUse {
  const agent = sources.agents.get(run.agent)
  let added: TokenUse = { input: 0, output: 0 }
  let latestTotal: TokenUse | undefined
  for (const { line } of sources.store.conversation(run.id)) {
    const count = agent.tokensFrom(line)
    if (!count) continue
    if (count.total) latestTotal = { input: count.input, output: count.output }
    else added = { input: added.input + count.input, output: added.output + count.output }
  }
  return latestTotal ?? added
}

export async function collectDiagnostics(sources: DiagnosticsSources): Promise<Diagnostics> {
  const all = sources.store.listRuns()
  const recent = new Set(all.slice(-runsShown))
  const runs = all.filter((run) => run.state !== 'finished' || recent.has(run)).reverse()
  const hosts = new Map<number, string>()
  for (const run of runs) {
    if (run.state === 'finished') continue
    const start = await startRecord(path.join(sources.home, 'runs', run.id))
    if (start) hosts.set(start.hostPid, run.id)
  }

  const rows = await processes()
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
  const owned: ProcessInfo[] = rows.flatMap((row) => {
    if (row.ppid === process.pid && row.command === 'ps') return []
    const owner = ownerOf(row.pid)
    return owner === undefined ? [] : [{ ...row, owner }]
  })

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
      tokens: tokenUse(sources, run),
    }
  })

  return {
    runs: runDiagnostics,
    processes: owned,
    memory: { totalBytes: os.totalmem(), availableBytes: await availableMemory() },
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
        `${p.pid} (parent ${p.ppid}) ${p.command} · ${p.owner === 'daemon' ? 'daemon' : `Run ${p.owner.runId}`} · CPU ${p.cpuPercent}% · ${megabytes(p.memoryBytes)}`,
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
