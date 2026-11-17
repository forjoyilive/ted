import { expect, test } from 'vitest'
import type { ProcessInfo, RunDiagnostics } from '../src/diagnostics.ts'
import {
  defaultDiagnosticsSort,
  nextSort,
  parseDiagnosticsSort,
  sortProcesses,
  sortRuns,
} from '../src/diagnostics-sort.ts'

const run = (runId: string, fields: Partial<RunDiagnostics>): RunDiagnostics => ({
  runId,
  agent: 'claude',
  state: 'working',
  startedAt: '2026-11-16T00:00:00.000Z',
  cpuPercent: 0,
  memoryBytes: 0,
  tokens: { input: 0, output: 0 },
  ...fields,
})

const process = (pid: number, fields: Partial<ProcessInfo>): ProcessInfo => ({
  pid,
  ppid: 1,
  cpuPercent: 0,
  memoryBytes: 0,
  command: 'node',
  owner: 'daemon',
  kind: 'daemon',
  ...fields,
})

const ids = (runs: RunDiagnostics[]) => runs.map((r) => r.runId)
const pids = (processes: ProcessInfo[]) => processes.map((p) => p.pid)

test('Runs sort by CPU, busiest first, with finished Runs last in either direction', () => {
  const runs = [
    run('a', { state: 'finished', cpuPercent: 99 }),
    run('b', { cpuPercent: 5 }),
    run('c', { cpuPercent: 40 }),
    run('d', { state: 'idle', cpuPercent: 5 }),
  ]
  expect(ids(sortRuns(runs, defaultDiagnosticsSort.runs))).toEqual(['c', 'b', 'd', 'a'])
  expect(ids(sortRuns(runs, { column: 'cpu', direction: 'ascending' }))).toEqual([
    'b',
    'd',
    'c',
    'a',
  ])
  expect(ids(sortRuns(runs, { column: 'memory', direction: 'descending' })).at(-1)).toBe('a')
})

test('Runs sort by Provider name and token counts', () => {
  const runs = [
    run('a', { agent: 'codex', tokens: { input: 900, output: 1 } }),
    run('b', { agent: 'antigravity', tokens: { input: 10, output: 2 } }),
    run('c', { agent: 'claude', tokens: { input: 100, output: 3 } }),
  ]
  expect(ids(sortRuns(runs, { column: 'provider', direction: 'ascending' }))).toEqual([
    'b',
    'c',
    'a',
  ])
  expect(ids(sortRuns(runs, { column: 'tokensIn', direction: 'descending' }))).toEqual([
    'a',
    'c',
    'b',
  ])
  expect(ids(sortRuns(runs, { column: 'tokensOut', direction: 'ascending' }))).toEqual([
    'a',
    'b',
    'c',
  ])
})

test('Processes sort by each column, and equal values keep PID order', () => {
  const processes = [
    process(30, { command: 'codex app-server', cpuPercent: 2, memoryBytes: 300 }),
    process(10, { command: 'node main.ts', cpuPercent: 2, memoryBytes: 100 }),
    process(20, { command: 'claude --print', cpuPercent: 9, memoryBytes: 200 }),
  ]
  expect(pids(sortProcesses(processes, defaultDiagnosticsSort.processes))).toEqual([20, 10, 30])
  expect(pids(sortProcesses(processes, { column: 'pid', direction: 'descending' }))).toEqual([
    30, 20, 10,
  ])
  expect(pids(sortProcesses(processes, { column: 'command', direction: 'ascending' }))).toEqual([
    20, 30, 10,
  ])
  expect(pids(sortProcesses(processes, { column: 'memory', direction: 'ascending' }))).toEqual([
    10, 20, 30,
  ])
})

test('a header click sorts numbers highest first, text A to Z, and a second click reverses', () => {
  const start = defaultDiagnosticsSort.processes
  expect(nextSort(start, 'memory')).toEqual({ column: 'memory', direction: 'descending' })
  expect(nextSort(start, 'command')).toEqual({ column: 'command', direction: 'ascending' })
  expect(nextSort(start, 'cpu')).toEqual({ column: 'cpu', direction: 'ascending' })
  expect(nextSort(nextSort(start, 'cpu'), 'cpu')).toEqual(start)
})

test('parseDiagnosticsSort reads both tables and refuses unknown columns', () => {
  const sort = {
    runs: { column: 'state', direction: 'ascending' },
    processes: { column: 'name', direction: 'descending' },
  }
  expect(parseDiagnosticsSort(sort)).toEqual(sort)
  expect(() =>
    parseDiagnosticsSort({ ...sort, runs: { column: 'pid', direction: 'ascending' } }),
  ).toThrow('column')
  expect(() =>
    parseDiagnosticsSort({ ...sort, processes: { column: 'cpu', direction: 'sideways' } }),
  ).toThrow('direction')
  expect(() => parseDiagnosticsSort({ runs: sort.runs })).toThrow('processes')
})
