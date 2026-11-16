import { expect, test } from 'vitest'
import { footprintBytes, processMemory, psResidentBytes } from '../src/process-memory.ts'

const footprintJson = (processes: unknown[]) =>
  JSON.stringify({ unit: 'byte', processes, errors: [], warnings: [] })

test('on macOS each process’s memory is its footprint, the figure Activity Monitor shows', async () => {
  const asked: number[][] = []
  const memory = await processMemory([10, 11, 10], {
    platform: 'darwin',
    resident: new Map([
      [10, 999],
      [11, 999],
    ]),
    footprint: async (pids) => {
      asked.push([...pids])
      return footprintJson([
        { name: 'node', pid: 10, footprint: 300 },
        { name: 'TED Helper', pid: 11, footprint: 200 },
      ])
    },
    ps: async () => {
      throw new Error('ps is not needed when footprint answers for every process')
    },
  })
  expect(asked).toEqual([[10, 11]])
  expect(Object.fromEntries(memory)).toEqual({ 10: 300, 11: 200 })
})

test('a process footprint skips, or a failed footprint, falls back to its resident size', async () => {
  const psAsked: number[][] = []
  const ps = async (pids: readonly number[]) => {
    psAsked.push([...pids])
    return ' 12  2048\n'
  }
  const skipped = await processMemory([10, 11, 12, 13], {
    platform: 'darwin',
    resident: new Map([[11, 4096]]),
    footprint: async () => footprintJson([{ pid: 10, footprint: 300 }]),
    ps,
  })
  expect(Object.fromEntries(skipped)).toEqual({ 10: 300, 11: 4096, 12: 2048 * 1024 })
  expect(psAsked).toEqual([[12, 13]])

  const failed = await processMemory([12], {
    platform: 'darwin',
    footprint: async () => {
      throw new Error('footprint is missing')
    },
    ps,
  })
  expect(Object.fromEntries(failed)).toEqual({ 12: 2048 * 1024 })
})

test('on Linux every process’s memory is its resident size', async () => {
  const memory = await processMemory([10, 11], {
    platform: 'linux',
    resident: new Map([[10, 4096]]),
    footprint: async () => {
      throw new Error('footprint is macOS only')
    },
    ps: async () => '11 8\n',
  })
  expect(Object.fromEntries(memory)).toEqual({ 10: 4096, 11: 8 * 1024 })
})

test('footprint output keeps only the asked processes and plain byte counts', () => {
  const json = footprintJson([
    { name: '1Password', pid: 99, footprint: 5 },
    { pid: 10, footprint: 300 },
    { pid: 11, footprint: -1 },
    { pid: 12, footprint: '300' },
    { pid: '13', footprint: 300 },
    null,
  ])
  expect(Object.fromEntries(footprintBytes(json, [10, 11, 12, 13]))).toEqual({ 10: 300 })
  expect(footprintBytes('{"processes":null}', [10]).size).toBe(0)
  expect(Object.fromEntries(psResidentBytes('  10   4\nPID RSS\n\n 11 1\n'))).toEqual({
    10: 4096,
    11: 1024,
  })
})
