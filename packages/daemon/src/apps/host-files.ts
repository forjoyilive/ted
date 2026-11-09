import path from 'node:path'

export interface AppLaunchFile {
  run: string
  cwd: string
  logBytes: number
}

export type AppHostRecord =
  | { t: 'start'; hostPid: number; pid: number | null }
  | { t: 'exit'; code: number | null; signal: string | null; stopped?: boolean; error?: string }

export const appLogBytes = 10 * 1024 * 1024

export function appFiles(dir: string) {
  return {
    launch: path.join(dir, 'launch.json'),
    instance: path.join(dir, 'instance.json'),
    records: path.join(dir, 'host.jsonl'),
    lock: path.join(dir, 'host.lock'),
    pid: path.join(dir, 'host.pid'),
    log: path.join(dir, 'app.log'),
    previousLog: path.join(dir, 'app.log.1'),
  }
}

export function parseAppRecords(text: string): AppHostRecord[] {
  return text.split('\n').flatMap((line) => {
    if (line.trim() === '') return []
    try {
      return [JSON.parse(line) as AppHostRecord]
    } catch {
      return []
    }
  })
}
