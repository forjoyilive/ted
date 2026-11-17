import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { scriptLiteral } from '@ted/protocol'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { codexPlanWindows, readCodexPlanUsage } from '../src/agents/codex-usage.ts'
import { stubCodexPath, waitUntil } from './helpers.ts'

let home: string
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'ted-codex-usage-'))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
afterEach(async () => {
  vi.useRealTimers()
  await rm(home, { recursive: true, force: true })
})
const state = (value: unknown) =>
  writeFile(path.join(home, 'stub-codex.json'), JSON.stringify(value))
const read = (signal = new AbortController().signal, timeoutMs = 1000) =>
  readCodexPlanUsage({
    binary: stubCodexPath,
    env: { ...process.env, TED_HOME: home },
    cwd: home,
    signal,
    timeoutMs,
  })
const record = async () =>
  JSON.parse(await readFile(path.join(home, 'stub-record.json'), 'utf8')) as { pid: number }
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('the account probe returns zero and independent windows without starting a thread', async () => {
  await state({
    rateLimits: {
      primary: { usedPercent: 0, windowDurationMins: 300 },
      secondary: { usedPercent: 78, windowDurationMins: 10080 },
    },
  })
  expect(await read()).toEqual([
    { window: 'five-hour', percent: 0 },
    { window: 'weekly', percent: 78 },
  ])
  expect(alive((await record()).pid)).toBe(false)
  const requests = await readFile(path.join(home, 'stub-usage-methods.jsonl'), 'utf8')
  expect(
    requests
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
  ).toEqual(['initialize', 'initialized', 'account/rateLimits/read'])
})

test('timeout kills the child and returns no reading', async () => {
  await state({ rateLimitsHang: true })
  const reading = read(undefined, 500)
  const { pid } = await waitUntil(() => record().catch(() => undefined), 'probe process')
  vi.advanceTimersByTime(500)
  expect(await reading).toBeUndefined()
  expect(alive(pid)).toBe(false)
})

test('cancellation kills an active child and an already cancelled probe starts nothing', async () => {
  await state({ rateLimitsHang: true })
  const controller = new AbortController()
  const reading = read(controller.signal)
  await waitUntil(async () => record().catch(() => undefined), 'probe process')
  controller.abort()
  expect(await reading).toBeUndefined()
  expect(alive((await record()).pid)).toBe(false)
  await rm(path.join(home, 'stub-record.json'))
  expect(await read(controller.signal)).toBeUndefined()
  await expect(record()).rejects.toThrow()
})

test('errors and a missing binary return no reading', async () => {
  await state({ rateLimitsError: true })
  expect(await read()).toBeUndefined()
  expect(
    await readCodexPlanUsage({
      binary: path.join(home, 'missing'),
      cwd: home,
      env: process.env,
      signal: new AbortController().signal,
    }),
  ).toBeUndefined()
})

test('empty successful snapshots differ from missing or malformed snapshots', () => {
  expect(codexPlanWindows({ primary: null, secondary: null })).toEqual([])
  expect(codexPlanWindows(undefined)).toBeUndefined()
  expect(codexPlanWindows({})).toBeUndefined()
  expect(
    codexPlanWindows({ primary: { usedPercent: 22, windowDurationMins: 15 }, secondary: null }),
  ).toEqual([])
})

test.each(['response', 'timeout', 'abort'] as const)(
  'a launcher wrapper cleans up descendants on %s',
  async (mode) => {
    await state(
      mode === 'response'
        ? { rateLimits: { primary: { usedPercent: 0 } } }
        : { rateLimitsHang: true },
    )
    const wrapper = path.join(home, 'codex-wrapper.mjs')
    await writeFile(
      wrapper,
      `#!/usr/bin/env node
import { spawn } from 'node:child_process'
const child = spawn(process.execPath, ['--input-type=module', '-e', ${scriptLiteral(`setInterval(() => {}, 1000); await import(${scriptLiteral(stubCodexPath)})`)}], {stdio:'inherit'})
child.on('exit', code => process.exit(code ?? 0))
`,
      { mode: 0o755 },
    )
    const controller = new AbortController()
    const reading = readCodexPlanUsage({
      binary: wrapper,
      cwd: home,
      env: { ...process.env, TED_HOME: home },
      signal: controller.signal,
      timeoutMs: 500,
    })
    let childPid: number | undefined
    try {
      childPid = (await waitUntil(() => record().catch(() => undefined), 'native child')).pid
      if (mode === 'abort') controller.abort()
      if (mode === 'timeout') vi.advanceTimersByTime(500)
      expect(await reading).toEqual(
        mode === 'response' ? [{ window: 'five-hour', percent: 0 }] : undefined,
      )
      const pid = childPid
      await waitUntil(() => !alive(pid), 'native child exit')
    } finally {
      controller.abort()
      if (childPid && alive(childPid)) process.kill(childPid, 'SIGKILL')
      await reading
    }
  },
)
