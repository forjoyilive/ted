import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test } from 'vitest'
import {
  DaemonClient,
  parseRegisterTestInvocation,
  parseTestInvocationReport,
} from '../src/index.ts'

const id = '12345678-1234-4234-8234-123456789abc'

test('registration and reports keep all fields and reject unknown or unbounded payloads', () => {
  const registration = { id, supported: true, label: 'Tests', checkRunId: id, position: 255 }
  expect(parseRegisterTestInvocation(registration)).toEqual(registration)
  for (const change of [
    { id: 'bad' },
    { id: id.toUpperCase() },
    { supported: 1 },
    { label: 'x'.repeat(121) },
    { position: -1 },
    { position: 0.1 },
    { position: 256 },
    { checkRunId: undefined },
    { checkRunId: 'bad' },
    { runId: id },
    { command: 'execute me' },
  ])
    expect(() => parseRegisterTestInvocation({ ...registration, ...change })).toThrow()
  expect(parseRegisterTestInvocation({ id, supported: false })).toEqual({ id, supported: false })
  for (const kind of ['wait-start', 'wait-end', 'finished', 'canceled', 'interrupted'] as const) {
    const report = { sequence: 0, at: Date.now(), kind }
    expect(parseTestInvocationReport(report)).toEqual(report)
    for (const change of [
      { sequence: -1 },
      { sequence: 64 },
      { sequence: 1.5 },
      { at: NaN },
      { at: Infinity },
      { at: 'now' },
      { at: -1 },
      { at: 8_640_000_000_000_001 },
      { kind: 'stdout' },
      { kind: ['finished'] },
      { kind: ['wait-start'] },
      { kind: {} },
      { kind: true },
      { kind: null },
      { text: 'secret' },
    ])
      expect(() => parseTestInvocationReport({ ...report, ...change })).toThrow()
  }
})

test('reporting fails softly with an absolute deadline even when a server trickles output', async () => {
  const timers = new Set<ReturnType<typeof setInterval>>()
  const server = createServer((_req, res) => {
    res.writeHead(200)
    const timer = setInterval(() => res.write(' '), 20)
    timers.add(timer)
    res.on('close', () => {
      clearInterval(timer)
      timers.delete(timer)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const info = {
    port: (server.address() as AddressInfo).port,
    pid: process.pid,
    token: 'report-only',
    version: 'test',
  }
  try {
    const client = new DaemonClient(info)
    expect(await client.tryRegisterTestInvocation('task', { id, supported: true })).toBeUndefined()
    const start = performance.now()
    expect(
      await client.reportTestInvocation(id, { sequence: 0, kind: 'finished', at: Date.now() }),
    ).toBe(false)
    expect(performance.now() - start).toBeLessThan(3_000)
  } finally {
    for (const timer of timers) clearInterval(timer)
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  const client = new DaemonClient(info)
  expect(
    await client.reportTestInvocation(id, { sequence: 0, kind: 'finished', at: Date.now() }),
  ).toBe(false)
})
