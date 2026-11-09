import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { crashReport, logConsoleTo, openRollingLog, rollLog } from '../src/logs.ts'
import { makeTempHome } from './helpers.ts'

let dir: string
let cleanup: () => Promise<void>

beforeEach(async () => {
  ;({ home: dir, cleanup } = await makeTempHome())
})

afterEach(() => cleanup())

const read = (name: string) => readFile(path.join(dir, name), 'utf8')

test('a rolling log starts a new file once the current one would pass the size limit', async () => {
  const log = openRollingLog(path.join(dir, 'daemon.log'), { maxBytes: 10, keep: 7 })

  log.write('aaaaaa\n')
  log.write('bbbbbb\n')
  log.write('cccccc\n')
  log.close()

  expect(await read('daemon.log')).toBe('cccccc\n')
  expect(await read('daemon.log.1')).toBe('bbbbbb\n')
  expect(await read('daemon.log.2')).toBe('aaaaaa\n')
})

test('a rolling log keeps only the given number of files', async () => {
  const log = openRollingLog(path.join(dir, 'daemon.log'), { maxBytes: 4, keep: 3 })

  for (const line of ['1\n', '22\n', '33\n', '44\n', '55\n']) log.write(line)
  log.close()

  expect((await readdir(dir)).sort()).toEqual(['daemon.log', 'daemon.log.1', 'daemon.log.2'])
  expect(await read('daemon.log')).toBe('55\n')
  expect(await read('daemon.log.2')).toBe('33\n')
})

test('a rolling log appends to the file a previous process left', async () => {
  await writeFile(path.join(dir, 'daemon.log'), 'before\n')
  const log = openRollingLog(path.join(dir, 'daemon.log'), { maxBytes: 100, keep: 7 })

  log.write('after\n')
  log.close()

  expect(await read('daemon.log')).toBe('before\nafter\n')
})

test('rolling a file only moves it aside once it has reached the size limit', async () => {
  const file = path.join(dir, 'daemon-output.log')
  await writeFile(file, '12345')

  await rollLog(file, { maxBytes: 10, keep: 7 })
  expect(await read('daemon-output.log')).toBe('12345')

  await writeFile(file, '1234567890')
  await rollLog(file, { maxBytes: 10, keep: 7 })
  expect((await readdir(dir)).sort()).toEqual(['daemon-output.log.1'])
})

test('a crash report holds the end of the daemon log and its crash output', async () => {
  const logs = path.join(dir, 'logs')
  await mkdir(logs)
  await writeFile(path.join(logs, 'daemon.log.1'), 'older line\n')
  await writeFile(path.join(logs, 'daemon.log'), `${'x'.repeat(100)}\nlast line\n`)
  await writeFile(path.join(logs, 'daemon-output.log'), 'Error: unable to open database file\n')

  const report = await crashReport(dir, {
    version: '0.1.0',
    crashes: ['2026-11-08T10:00:00.000Z'],
    maxBytesPerFile: 1_000,
  })

  expect(report).toContain('TED 0.1.0')
  expect(report).toContain('2026-11-08T10:00:00.000Z')
  expect(report).toMatch(/older line\n[\s\S]*last line/)
  expect(report).toContain('Error: unable to open database file')
})

test('a crash report keeps only the end of a long log', async () => {
  const logs = path.join(dir, 'logs')
  await mkdir(logs)
  await writeFile(path.join(logs, 'daemon.log'), `first line\n${'x'.repeat(5_000)}\nlast line\n`)

  const report = await crashReport(dir, { version: '0.1.0', crashes: [], maxBytesPerFile: 100 })

  expect(report).toContain('last line')
  expect(report).not.toContain('first line')
})

test('a crash report says so when a log is missing', async () => {
  const report = await crashReport(dir, { version: '0.1.0', crashes: [] })

  expect(report).toContain('daemon.log: none')
  expect(report).toContain('daemon-output.log: none')
})

test('a crash report hides secrets and TED’s folder', async () => {
  const logs = path.join(dir, 'logs')
  await mkdir(logs)
  await writeFile(
    path.join(logs, 'daemon-output.log'),
    `fetch https://user:hunter2@example.com failed\nAuthorization: Bearer abcdef123456\nat ${dir}/store\n`,
  )

  const report = await crashReport(dir, { version: '0.1.0', crashes: [] })

  expect(report).not.toContain('hunter2')
  expect(report).not.toContain('abcdef123456')
  expect(report).not.toContain(dir)
  expect(report).toContain('<TED home>/store')
})

test('the daemon’s console lines are timestamped and have secrets removed', async () => {
  const file = path.join(dir, 'daemon.log')
  const log = openRollingLog(file, { maxBytes: 1_000, keep: 2 })
  const saved = { ...console }
  try {
    logConsoleTo(log)
    console.error('clone failed: https://x:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/a/b')
  } finally {
    Object.assign(console, saved)
    log.close()
  }

  const text = await read('daemon.log')
  expect(text).toMatch(
    /^\d{4}-\d\d-\d\dT\S+ error clone failed: https:\/\/\[redacted\]@github\.com/,
  )
  expect(text).not.toContain('ghp_')
})
