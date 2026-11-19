import { readFile } from 'node:fs/promises'
import { isInteger, isObject, isString, parseJson } from './parse.ts'
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

export type PublicDaemonInfo = Omit<DaemonInfo, 'token'>

export async function readPublicDaemonInfo(home: string): Promise<PublicDaemonInfo | undefined> {
  const text = await readFile(tedPaths(home).publicDaemonInfo, 'utf8').catch(() => undefined)
  const found = text === undefined ? undefined : parseJson(text)
  if (!isObject(found)) return undefined
  const { port, pid, version } = found
  return isInteger(port) && isInteger(pid) && isString(version) ? { port, pid, version } : undefined
}

export async function readDaemonInfoFor(
  home: string,
  runToken: string | undefined,
): Promise<DaemonInfo | undefined> {
  if (runToken !== undefined) {
    const found = await readPublicDaemonInfo(home)
    if (found) return { ...found, token: runToken }
  }
  return readDaemonInfo(home)
}

export interface CallerInfo {
  kind: 'app' | 'file' | 'run'
  proof?: string
}
