import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const footprintBin = '/usr/bin/footprint'
const timeoutMs = 10_000

export interface ProcessMemoryOptions {
  platform?: NodeJS.Platform
  resident?: ReadonlyMap<number, number>
  footprint?: (pids: readonly number[]) => Promise<string>
  ps?: (pids: readonly number[]) => Promise<string>
}

export async function processMemory(
  pids: readonly number[],
  options: ProcessMemoryOptions = {},
): Promise<Map<number, number>> {
  const wanted = [...new Set(pids)]
  const bytes = new Map<number, number>()
  if (wanted.length === 0) return bytes
  if ((options.platform ?? process.platform) === 'darwin') {
    const read = options.footprint ?? readFootprint
    try {
      for (const [pid, size] of footprintBytes(await read(wanted), wanted)) bytes.set(pid, size)
    } catch {}
  }
  const missing = wanted.filter((pid) => !bytes.has(pid))
  const resident = options.resident
  const unknown = missing.filter((pid) => !resident?.has(pid))
  const read = unknown.length > 0 ? await residentBytes(unknown, options.ps) : new Map()
  for (const pid of missing) {
    const size = resident?.get(pid) ?? read.get(pid)
    if (size !== undefined) bytes.set(pid, size)
  }
  return bytes
}

export function footprintBytes(json: string, pids: readonly number[]): Map<number, number> {
  const wanted = new Set(pids)
  const bytes = new Map<number, number>()
  const parsed: unknown = JSON.parse(json)
  const processes =
    parsed && typeof parsed === 'object' && 'processes' in parsed ? parsed.processes : undefined
  if (!Array.isArray(processes)) return bytes
  for (const entry of processes) {
    if (!entry || typeof entry !== 'object') continue
    const { pid, footprint } = entry as { pid?: unknown; footprint?: unknown }
    if (typeof pid !== 'number' || !wanted.has(pid)) continue
    if (typeof footprint !== 'number' || !Number.isFinite(footprint) || footprint < 0) continue
    bytes.set(pid, footprint)
  }
  return bytes
}

export function psResidentBytes(stdout: string): Map<number, number> {
  const bytes = new Map<number, number>()
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (match) bytes.set(Number(match[1]), Number(match[2]) * 1024)
  }
  return bytes
}

async function residentBytes(
  pids: readonly number[],
  ps: ProcessMemoryOptions['ps'],
): Promise<Map<number, number>> {
  try {
    return psResidentBytes(await (ps ?? readPs)(pids))
  } catch {
    return new Map()
  }
}

async function readPs(pids: readonly number[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'pid=,rss=', '-p', pids.join(',')], {
      timeout: timeoutMs,
    })
    return stdout
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout
    if (typeof stdout === 'string') return stdout
    throw error
  }
}

async function readFootprint(pids: readonly number[]): Promise<string> {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'ted-footprint-'))
  try {
    const file = path.join(folder, 'footprint.json')
    await execFileAsync(
      footprintBin,
      ['--noCategories', '-f', 'bytes', '-j', file, ...pids.flatMap((pid) => ['-p', String(pid)])],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
    )
    return await readFile(file, 'utf8')
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}
