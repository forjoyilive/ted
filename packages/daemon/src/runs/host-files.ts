import path from 'node:path'

export interface LaunchFile {
  command: string
  args: string[]
  cwd: string
  input: string
}

export type HostRecord =
  | { t: 'start'; v: 1; hostPid: number; agentPid: number | null }
  | { t: 'out'; line: string }
  | { t: 'err'; line: string }
  | { t: 'exit'; code: number | null; signal: string | null; error?: string }

export function runFiles(runDir: string) {
  return {
    launch: path.join(runDir, 'launch.json'),
    log: path.join(runDir, 'host.log'),
    lock: path.join(runDir, 'host.lock'),
  }
}
