import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const markerNames = ['TED_TEST_RUN', 'TED_TEST_FILE', 'TED_EXIT_WITH_PID'] as const

export interface MarkedProcess {
  pid: number
  pgid: number
  command: string
}

interface ProcessEntry extends MarkedProcess {
  ppid: number
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const name of markerNames) delete env[name]
  return env
}

async function linuxProcesses(): Promise<ProcessEntry[]> {
  const entries: ProcessEntry[] = []
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const [stat, cmdline, environ] = await Promise.all([
        readFile(`/proc/${name}/stat`, 'utf8'),
        readFile(`/proc/${name}/cmdline`, 'utf8'),
        readFile(`/proc/${name}/environ`, 'utf8').catch(() => ''),
      ])
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      entries.push({
        pid: Number(name),
        ppid: Number(fields[1]),
        pgid: Number(fields[2]),
        command: `${cmdline} ${environ}`.replaceAll('\0', ' '),
      })
    } catch {}
  }
  return entries
}

async function psProcesses(): Promise<ProcessEntry[]> {
  const { stdout } = await execFileAsync('ps', ['eww', '-ax', '-o', 'pid=,ppid=,pgid=,command='], {
    env: cleanEnv(),
    maxBuffer: 256 * 1024 * 1024,
  })
  const entries: ProcessEntry[] = []
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s(.*)$/.exec(line)
    if (!match) continue
    entries.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      command: match[4] ?? '',
    })
  }
  return entries
}

function listProcesses(): Promise<ProcessEntry[]> {
  return process.platform === 'linux' ? linuxProcesses() : psProcesses()
}

function ancestors(entries: ProcessEntry[]): Set<number> {
  const parents = new Map(entries.map((entry) => [entry.pid, entry.ppid]))
  const chain = new Set<number>()
  for (let pid: number | undefined = process.pid; pid && !chain.has(pid); pid = parents.get(pid)) {
    chain.add(pid)
  }
  return chain
}

export async function findMarked(name: string, value: string): Promise<MarkedProcess[]> {
  const pattern = new RegExp(`(^|\\s)${name}=${value.replace(/[^\w-]/g, '\\$&')}(\\s|$)`)
  const entries = await listProcesses()
  const own = ancestors(entries)
  return entries
    .filter((entry) => !own.has(entry.pid) && pattern.test(entry.command))
    .map(({ pid, pgid, command }) => ({ pid, pgid, command }))
}

function signal(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {}
}

export async function killMarked(name: string, value: string): Promise<MarkedProcess[]> {
  const killed = new Map<number, MarkedProcess>()
  for (let round = 0; round < 20; round++) {
    const found = await findMarked(name, value)
    if (found.length === 0) break
    for (const proc of found) {
      killed.set(proc.pid, proc)
      if (proc.pgid === proc.pid) signal(-proc.pgid)
      signal(proc.pid)
    }
    await sleep(100)
  }
  return [...killed.values()]
}
