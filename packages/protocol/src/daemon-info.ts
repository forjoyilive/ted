import { readFile } from 'node:fs/promises'
import { tedPaths } from './paths.ts'

export interface DaemonInfo {
  port: number
  token: string
  pid: number
  version: string
}

export async function readDaemonInfo(home: string): Promise<DaemonInfo | undefined> {
  try {
    return JSON.parse(await readFile(tedPaths(home).daemonInfo, 'utf8')) as DaemonInfo
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
