import { execFile } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const markerNames = ['TED_TEST_RUN', 'TED_TEST_FILE', 'TED_EXIT_WITH_PID'] as const

export interface MarkedProcess {
  pid: number
  pgid: number
  command: string
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const name of markerNames) delete env[name]
  return env
}

async function ancestors(): Promise<Set<number>> {
  const { stdout } = await execFileAsync('ps', ['-ax', '-o', 'pid=,ppid='], { env: cleanEnv() })
  const parents = new Map<number, number>()
  for (const line of stdout.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (pid !== undefined && ppid !== undefined) parents.set(pid, ppid)
  }
  const chain = new Set<number>()
  for (let pid: number | undefined = process.pid; pid && !chain.has(pid); pid = parents.get(pid)) {
    chain.add(pid)
  }
  return chain
}

export async function findMarked(name: string, value: string): Promise<MarkedProcess[]> {
  const pattern = new RegExp(`(^|\\s)${name}=${value.replace(/[^\w-]/g, '\\$&')}(\\s|$)`)
  const [{ stdout }, own] = await Promise.all([
    execFileAsync('ps', ['eww', '-ax', '-o', 'pid=,pgid=,command='], {
      env: cleanEnv(),
      maxBuffer: 256 * 1024 * 1024,
    }),
    ancestors(),
  ])
  const found: MarkedProcess[] = []
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const command = match[3] ?? ''
    if (own.has(pid) || !pattern.test(command)) continue
    found.push({ pid, pgid: Number(match[2]), command })
  }
  return found
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
