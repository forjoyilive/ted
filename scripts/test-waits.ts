import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import {
  slotDir,
  type WaitRecord,
  waitLogName,
} from '../packages/daemon/test/support/suite-lock.ts'

export interface WaitRow {
  name: string
  runs: number
  waitedMs: number
  medianWaitMs: number
  longestWaitMs: number
  heldMs: number
}

export function parseWaits(text: string): WaitRecord[] {
  const records: WaitRecord[] = []
  for (const line of text.split('\n')) {
    try {
      const value = JSON.parse(line)
      if (
        (value?.event === 'start' || value?.event === 'end') &&
        typeof value.waitedMs === 'number' &&
        typeof value.at === 'string'
      )
        records.push(value)
    } catch {}
  }
  return records
}

function row(name: string, records: WaitRecord[]): WaitRow {
  const waits = records
    .filter((record) => record.event === 'start')
    .map((record) => record.waitedMs)
    .sort((a, b) => a - b)
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)
  return {
    name,
    runs: waits.length,
    waitedMs: sum(waits),
    medianWaitMs: waits[Math.floor(waits.length / 2)] ?? 0,
    longestWaitMs: waits.at(-1) ?? 0,
    heldMs: sum(records.map((record) => record.heldMs ?? 0)),
  }
}

export function summarize(records: WaitRecord[], group: (record: WaitRecord) => string): WaitRow[] {
  const groups = new Map<string, WaitRecord[]>()
  for (const record of records) {
    const name = group(record)
    groups.set(name, [...(groups.get(name) ?? []), record])
  }
  return [...groups]
    .map(([name, group]) => row(name, group))
    .sort((a, b) => b.waitedMs - a.waitedMs)
}

const minutes = (ms: number) => `${(ms / 60_000).toFixed(1)} min`

function print(title: string, rows: WaitRow[]): void {
  console.log(`\n== ${title}`)
  const width = Math.max(4, ...rows.map((entry) => entry.name.length))
  console.log(
    `${'name'.padEnd(width)}  ${'runs'.padStart(5)}  ${'waited'.padStart(10)}  ${'median'.padStart(10)}  ${'longest'.padStart(10)}  ${'running'.padStart(10)}`,
  )
  for (const entry of rows) {
    console.log(
      `${entry.name.padEnd(width)}  ${String(entry.runs).padStart(5)}  ${minutes(entry.waitedMs).padStart(10)}  ${minutes(entry.medianWaitMs).padStart(10)}  ${minutes(entry.longestWaitMs).padStart(10)}  ${minutes(entry.heldMs).padStart(10)}`,
    )
  }
}

if (import.meta.main) {
  const days = Number(process.argv[2]) || 7
  const file = path.join(path.dirname(slotDir), waitLogName)
  let text = ''
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    console.log(`No test runs recorded yet in ${file}.`)
    process.exit(0)
  }
  const since = Date.now() - days * 24 * 60 * 60_000
  const records = parseWaits(text).filter((record) => Date.parse(record.at) >= since)
  console.log(`Test runs of the last ${days} days, from ${file}`)
  print(
    'Small runs (under 10 files) and full runs',
    summarize(records, (record) => record.kind),
  )
  print(
    'By day',
    summarize(records, (record) => record.at.slice(0, 10)).sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
  )
  print(
    'By folder',
    summarize(records, (record) => record.cwd.replace(homedir(), '~')),
  )
}
