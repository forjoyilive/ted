import type { ProcessInfo, RunDiagnostics } from './diagnostics.ts'
import { agentDisplayNames } from './health.ts'
import { processName } from './memory.ts'
import { type Fail, reader, type Untyped } from './parse.ts'

export const runSortColumns = [
  'run',
  'provider',
  'state',
  'cpu',
  'memory',
  'tokensIn',
  'tokensOut',
] as const

export type RunSortColumn = (typeof runSortColumns)[number]

export const processSortColumns = ['pid', 'command', 'name', 'cpu', 'memory'] as const

export type ProcessSortColumn = (typeof processSortColumns)[number]

export const sortDirections = ['ascending', 'descending'] as const

export type SortDirection = (typeof sortDirections)[number]

export interface TableSort<Column extends string> {
  column: Column
  direction: SortDirection
}

export interface DiagnosticsSort {
  runs: TableSort<RunSortColumn>
  processes: TableSort<ProcessSortColumn>
}

export const defaultDiagnosticsSort: DiagnosticsSort = {
  runs: { column: 'cpu', direction: 'descending' },
  processes: { column: 'cpu', direction: 'descending' },
}

const numberColumns: ReadonlySet<string> = new Set([
  'pid',
  'cpu',
  'memory',
  'tokensIn',
  'tokensOut',
])

export function isNumberColumn(column: RunSortColumn | ProcessSortColumn): boolean {
  return numberColumns.has(column)
}

export function nextSort<Column extends RunSortColumn | ProcessSortColumn>(
  current: TableSort<Column>,
  column: Column,
): TableSort<Column> {
  if (current.column === column) {
    return {
      column,
      direction: current.direction === 'ascending' ? 'descending' : 'ascending',
    }
  }
  return { column, direction: isNumberColumn(column) ? 'descending' : 'ascending' }
}

export function providerName(run: RunDiagnostics): string {
  return agentDisplayNames[run.agent]
}

type Key = number | string | null

function runKey(run: RunDiagnostics, column: RunSortColumn): Key {
  const live = run.state !== 'finished'
  switch (column) {
    case 'run':
      return run.runId
    case 'provider':
      return providerName(run)
    case 'state':
      return run.state
    case 'cpu':
      return live ? run.cpuPercent : null
    case 'memory':
      return live ? run.memoryBytes : null
    case 'tokensIn':
      return run.tokens.input
    case 'tokensOut':
      return run.tokens.output
  }
}

function processKey(process: ProcessInfo, column: ProcessSortColumn): Key {
  switch (column) {
    case 'pid':
      return process.pid
    case 'command':
      return process.command
    case 'name':
      return processName(process)
    case 'cpu':
      return process.cpuPercent
    case 'memory':
      return process.memoryBytes
  }
}

function compareKeys(a: Key, b: Key, numeric: boolean, direction: SortDirection): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1
  const order = numeric
    ? Number(a) - Number(b)
    : String(a).localeCompare(String(b), 'en', { numeric: true })
  return direction === 'ascending' ? order : -order
}

function sortBy<Row, Column extends RunSortColumn | ProcessSortColumn>(
  rows: readonly Row[],
  sort: TableSort<Column>,
  key: (row: Row, column: Column) => Key,
  tie: (a: Row, b: Row) => number,
): Row[] {
  const numeric = isNumberColumn(sort.column)
  return [...rows].sort(
    (a, b) =>
      compareKeys(key(a, sort.column), key(b, sort.column), numeric, sort.direction) || tie(a, b),
  )
}

export function sortRuns(
  runs: readonly RunDiagnostics[],
  sort: TableSort<RunSortColumn>,
): RunDiagnostics[] {
  return sortBy(runs, sort, runKey, (a, b) => a.runId.localeCompare(b.runId))
}

export function sortProcesses(
  processes: readonly ProcessInfo[],
  sort: TableSort<ProcessSortColumn>,
): ProcessInfo[] {
  return sortBy(processes, sort, processKey, (a, b) => a.pid - b.pid)
}

export function parseDiagnosticsSort(value: Untyped, fail?: Fail): DiagnosticsSort {
  const read = reader(fail)
  const sort = read.object(value, 'diagnosticsSort')
  const runs = read.object(sort.runs, 'runs')
  const processes = read.object(sort.processes, 'processes')
  return {
    runs: {
      column: read.oneOf(runs, 'column', runSortColumns),
      direction: read.oneOf(runs, 'direction', sortDirections),
    },
    processes: {
      column: read.oneOf(processes, 'column', processSortColumns),
      direction: read.oneOf(processes, 'direction', sortDirections),
    },
  }
}
