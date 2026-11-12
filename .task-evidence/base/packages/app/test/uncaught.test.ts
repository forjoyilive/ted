import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import { DaemonUnreachableError } from '@ted/protocol'
import { expect, test } from 'vitest'
import {
  fileLog,
  handleUncaught,
  ignoreBrokenPipes,
  startupLog,
  watchParent,
} from '../src/uncaught.ts'

function errno(code: string, syscall: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${syscall} ${code}`), { code, syscall })
}

function outcome(error: unknown, hidden = false) {
  const logged: unknown[] = []
  const shown: string[] = []
  handleUncaught(error, {
    hidden,
    log: (...args) => logged.push(...args),
    show: (title) => shown.push(title),
  })
  return { logged: logged.includes(error), shown }
}

test('socket errors from a daemon that went away are logged, never shown', () => {
  for (const error of [
    errno('EINVAL', 'setTypeOfService'),
    errno('ECONNRESET', 'read'),
    errno('EPIPE', 'write'),
    errno('ECONNREFUSED', 'connect'),
    new DaemonUnreachableError('gone'),
  ]) {
    expect(outcome(error)).toEqual({ logged: true, shown: [] })
  }
})

test('Node failing to name a dead socket’s errno counts as a lost connection', () => {
  const error = Object.assign(new RangeError('The value of "err" is out of range.'), {
    code: 'ERR_OUT_OF_RANGE',
  })
  error.stack = [
    'RangeError [ERR_OUT_OF_RANGE]: The value of "err" is out of range.',
    '    at Object.getSystemErrorName (node:util:1:1)',
    '    at TCP.onStreamRead (node:internal/stream_base_commons:1:1)',
  ].join('\n')
  expect(outcome(error)).toEqual({ logged: true, shown: [] })
})

test('other uncaught errors are logged and shown', () => {
  expect(outcome(new TypeError('boom'))).toEqual({
    logged: true,
    shown: ['TED hit an unexpected error'],
  })
})

test('a hidden window never shows a dialog', () => {
  expect(outcome(new TypeError('boom'), true)).toEqual({ logged: true, shown: [] })
})

test('errors on stdout and stderr are swallowed and reported', () => {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const broken: string[] = []
  ignoreBrokenPipes([stdout, stderr], (error) => broken.push(String(error.code)))
  stdout.emit('error', errno('EPIPE', 'write'))
  stderr.emit('error', errno('EPIPE', 'write'))
  expect(broken).toEqual(['EPIPE', 'EPIPE'])
})

test('the uncaught log goes to a file and never throws', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ted-uncaught-'))
  try {
    const file = path.join(dir, 'logs', 'app.log')
    fileLog(file)('Lost a connection:', errno('EPIPE', 'write'))
    expect(await readFile(file, 'utf8')).toMatch(/Lost a connection: Error: write EPIPE/)
    expect(() => fileLog(path.join(file, 'not-a-dir', 'x.log'))('boom')).not.toThrow()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('watchParent fires once the parent process changes', async () => {
  let ppid = 4242
  let gone = 0
  const stop = watchParent(() => gone++, { ppid: () => ppid, intervalMs: 10 })
  await sleep(50)
  expect(gone).toBe(0)
  ppid = 1
  await sleep(50)
  stop()
  expect(gone).toBe(1)
})

test('startup milestones are test-only, bounded and ordered even when a log cannot be written', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ted-startup-log-'))
  try {
    const file = path.join(dir, 'startup.log')
    startupLog(file, false)('disabled')
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    const trace = startupLog(file, true)
    trace('main-evaluated')
    trace('daemon-connected')
    for (let i = 0; i < 100; i++) trace('window-created')
    const rows = (await readFile(file, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line.slice(line.indexOf('{'))))
    expect(rows).toHaveLength(48)
    expect(rows.slice(0, 2).map(({ stage }) => stage)).toEqual([
      'main-evaluated',
      'daemon-connected',
    ])
    expect(rows.every(({ pid, ms }) => pid === process.pid && ms >= 0)).toBe(true)
    expect(rows[1].ms).toBeGreaterThanOrEqual(rows[0].ms)
    expect(() => startupLog(path.join(file, 'bad'), true)('app-ready')).not.toThrow()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
