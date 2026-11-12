import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { reportedTestLock, runnerReporter, testReporter } from '../../../scripts/test-reporting.ts'
import type {
  TestInvocationReport,
  TestInvocationUpdate,
} from '../../protocol/src/test-invocations.ts'
import { runChecks, supportsTestReporting } from '../src/tasks/checks.ts'
import { heldLockEnv } from './support/suite-lock.ts'

let dir: string
let server: Server | undefined
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ted-lock-reporting-'))
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  await rm(dir, { recursive: true, force: true })
})
const locks = () => ({
  dir: path.join(dir, 'slots'),
  suiteLock: path.join(dir, 'suite'),
  pollMs: 5,
})
const capture = () => {
  const reports: TestInvocationReport[] = []
  const updates: TestInvocationUpdate[] = []
  return {
    reports,
    updates,
    reporter: testReporter(async (r) => {
      updates.push(r)
      if (r.kind !== 'running' && r.kind !== 'waiting' && r.kind !== 'inactive') reports.push(r)
      return true
    }),
  }
}

test('immediate acquisition reports a finished invocation without acquisition overhead as waiting', async () => {
  const { reports, updates, reporter } = capture()
  const release = await reportedTestLock(1, locks(), reporter)
  expect(reports).toEqual([])
  expect(updates).toMatchObject([{ sequence: 0, kind: 'running' }])
  await release?.()
  await release?.()
  expect(reports).toMatchObject([{ sequence: 0, kind: 'finished' }])
})

test('an inherited lock reports no duplicate wait or terminal event', async () => {
  await mkdir(locks().dir)
  await writeFile(path.join(locks().dir, '0.lock'), `${process.pid}\n`)
  vi.stubEnv(heldLockEnv, String(process.pid))
  const { reports, reporter } = capture()
  expect(await reportedTestLock(1, locks(), reporter)).toBeUndefined()
  expect(reports).toEqual([])
})

test('report delivery is ordered, captures boundary times and stops after a lost delivery', async () => {
  const reports: TestInvocationUpdate[] = []
  const reporter = testReporter(async (r) => {
    reports.push(r)
    return r.sequence === 0
  })
  reporter.contention(true, 100)
  reporter.contention(true, 110)
  reporter.contention(false, 200)
  reporter.contention(true, 300)
  reporter.contention(false, 400)
  await reporter.finish()
  expect(reports).toEqual([
    { sequence: 0, kind: 'wait-start', at: 100 },
    { sequence: 1, kind: 'waiting', at: expect.any(Number) },
    { sequence: 1, kind: 'wait-end', at: 200 },
  ])
})

test('interruption leaves an open interval without inventing a terminal timestamp', async () => {
  const { reports, reporter } = capture()
  reporter.contention(true, 100)
  await reporter.incomplete()
  await reporter.finish()
  expect(reports).toEqual([{ sequence: 0, kind: 'wait-start', at: 100 }])
})

test('unwritable slots and unavailable reporting preserve lock fallback and release', async () => {
  await writeFile(locks().dir, '')
  const { reports, reporter } = capture()
  expect(await reportedTestLock(1, locks(), reporter)).toBeUndefined()
  expect(reports).toEqual([])
  await rm(locks().dir)
  const unavailable = testReporter(async () => {
    throw new Error('unavailable')
  })
  const release = await reportedTestLock(1, locks(), unavailable)
  await expect(release?.()).resolves.toBeUndefined()
  await expect(readFile(path.join(locks().dir, '0.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('no reliable Task and Run authority means no reporter', async () => {
  expect(await runnerReporter('Vitest', {})).toBeUndefined()
  expect(await runnerReporter('Vitest', { TED_TASK: 'NB-1', TED_HOME: dir })).toBeUndefined()
  expect(
    await runnerReporter('Vitest', {
      TED_TASK: 'NB-1',
      TED_HOME: dir,
      TED_RUN_CAPABILITY: 'token',
    }),
  ).toBeUndefined()
})

test('direct commands register once and use only the returned credential to report', async () => {
  const requests: { url: string | undefined; auth: string | undefined; body: unknown }[] = []
  const id = randomUUID()
  server = createServer(async (req, res) => {
    let text = ''
    for await (const part of req) text += part
    requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(text) })
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify(
        req.url?.startsWith('/tasks/')
          ? { invocation: { id }, token: `test-report:${id}:task.signature` }
          : { recorded: true },
      ),
    )
  })
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing address')
  await writeFile(
    path.join(dir, 'daemon.json'),
    JSON.stringify({
      port: address.port,
      token: 'file-token-never-forwarded',
      pid: process.pid,
      version: '1',
    }),
  )
  const reporter = await runnerReporter('Vitest', {
    TED_TASK: 'NB-1',
    TED_RUN: 'run',
    TED_RUN_CAPABILITY: 'run-token',
    TED_HOME: dir,
    TED_APP_TOKEN: 'app-key-never-forwarded',
  })
  expect(reporter).toBeDefined()
  reporter?.contention(true, Date.now())
  reporter?.contention(false, Date.now())
  await reporter?.finish()
  expect(requests).toHaveLength(5)
  expect(requests[0]).toMatchObject({
    url: '/tasks/NB-1/test-invocations',
    auth: 'Bearer run-token',
    body: { supported: true, label: 'Vitest' },
  })
  for (const request of requests.slice(1))
    expect(request.auth).toBe(`Bearer test-report:${id}:task.signature`)
  expect(JSON.stringify(requests)).not.toContain('never-forwarded')

  requests.length = 0
  const checkReporter = await runnerReporter('pnpm check', {
    TED_TASK: 'NB-1',
    TED_HOME: dir,
    TED_RUN_CAPABILITY: `test-report:${id}:task.signature`,
  })
  await checkReporter?.finish()
  expect(requests).toHaveLength(1)
  expect(requests[0]?.url).toBe(`/test-invocations/${id}/reports`)
})

test('Check runner supplies reporting authority only after Check start and tolerates its failure', async () => {
  const started: number[] = []
  const result = await runChecks({
    checks: [
      {
        check: {
          name: 'fixture',
          command: 'test "$TED_RUN_CAPABILITY" = reporting-only && test -z "$TED_APP_TOKEN"',
          timeout: '1m',
          state: 'waiting',
        },
        cwd: dir,
      },
    ],
    taskDisplayId: 'NB-1',
    libraryDir: dir,
    env: {
      PATH: process.env.PATH,
      TED_APP_TOKEN: 'never-forward',
      TED_RUN_CAPABILITY: 'ordinary-run-token',
    },
    logFor: () => path.join(dir, 'check.log'),
    prepareLaunch: async () => ({ release: () => {} }),
    lowPriority: false,
    onStart: (position) => {
      started.push(position)
    },
    onFinish: () => {},
    reportingEnv: async (position) => {
      expect(started).toEqual([position])
      return { TED_RUN_CAPABILITY: 'reporting-only' }
    },
  })
  expect(result.outcome).toBe('passed')
  const fallback = await runChecks({
    checks: [
      { check: { name: 'fixture', command: 'exit 0', timeout: '1m', state: 'waiting' }, cwd: dir },
    ],
    taskDisplayId: 'NB-1',
    libraryDir: dir,
    env: {},
    logFor: () => path.join(dir, 'fallback.log'),
    prepareLaunch: async () => ({ release: () => {} }),
    lowPriority: false,
    onStart: () => {},
    onFinish: () => {},
    reportingEnv: async () => {
      throw new Error('unavailable')
    },
  })
  expect(fallback.outcome).toBe('passed')
})

test('full runs report successive suite and slot waits separately', async () => {
  await mkdir(locks().dir)
  await writeFile(locks().suiteLock, `${process.pid}\n`)
  for (const index of [0, 1])
    await writeFile(path.join(locks().dir, `${index}.lock`), `${process.pid}\n`)
  const { reports, reporter } = capture()
  const pending = reportedTestLock('check', { ...locks(), pid: 4242 }, reporter)
  await vi.waitFor(() => expect(reports.map((r) => r.kind)).toEqual(['wait-start']))
  await rm(locks().suiteLock)
  await vi.waitFor(() => expect(reports.filter((r) => r.kind === 'wait-start')).toHaveLength(2))
  await rm(path.join(locks().dir, '0.lock'))
  await vi.waitFor(() => expect(reports.filter((r) => r.kind === 'wait-start')).toHaveLength(3))
  await rm(path.join(locks().dir, '1.lock'))
  await (await pending)?.()
  expect(reports.map((r) => r.kind)).toEqual([
    'wait-start',
    'wait-end',
    'wait-start',
    'wait-end',
    'wait-start',
    'wait-end',
    'finished',
  ])
  expect(reports.map((r) => r.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6])
})

test('small runs measure contention until a slot is free, excluding confirmation overhead', async () => {
  await mkdir(locks().dir)
  for (const index of [0, 1])
    await writeFile(path.join(locks().dir, `${index}.lock`), `${process.pid}\n`)
  const reports: TestInvocationReport[] = []
  let acquisitionFinishedAt = 0
  const reporter = testReporter(async (r) => {
    if (r.kind !== 'running' && r.kind !== 'waiting' && r.kind !== 'inactive') reports.push(r)
    return true
  })
  const pending = reportedTestLock(1, { ...locks(), pid: 4242 }, reporter)
  await vi.waitFor(() => expect(reports).toMatchObject([{ kind: 'wait-start' }]))
  await rm(path.join(locks().dir, '0.lock'))
  const release = await pending
  acquisitionFinishedAt = Date.now()
  await release?.()
  expect(reports.map((r) => r.kind)).toEqual(['wait-start', 'wait-end', 'finished'])
  expect(acquisitionFinishedAt - (reports[1]?.at ?? acquisitionFinishedAt)).toBeGreaterThanOrEqual(
    40,
  )
})

test('canceled acquisition retains an incomplete open wait and releases partially acquired locks', async () => {
  await mkdir(locks().dir)
  await writeFile(path.join(locks().dir, '1.lock'), `${process.pid}\n`)
  const { reports, reporter } = capture()
  const controller = new AbortController()
  const pending = reportedTestLock(
    'check',
    { ...locks(), pid: 4242, signal: controller.signal },
    reporter,
  )
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(reports).toMatchObject([{ kind: 'wait-start' }]))
  controller.abort()
  await rejected
  expect(reports.map((r) => r.kind)).toEqual(['wait-start'])
  await expect(readFile(locks().suiteLock)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(path.join(locks().dir, '0.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(path.join(locks().dir, '1.lock'), 'utf8')).toBe(`${process.pid}\n`)
})

test.each(['full queue', 'small queue', 'small yield'] as const)(
  '%s contention is explicitly measured',
  async (phase) => {
    const queue = path.join(locks().dir, 'queue')
    await mkdir(queue, { recursive: true })
    const kind = phase === 'full queue' ? 'full' : 'small'
    const ticket = path.join(queue, `000000000000001-${process.pid}-${kind}`)
    await writeFile(ticket, '')
    const { reports, reporter } = capture()
    const pending = reportedTestLock(
      phase === 'small queue' ? 1 : 'check',
      { ...locks(), pid: 4242 },
      reporter,
    )
    await vi.waitFor(() => expect(reports).toMatchObject([{ kind: 'wait-start' }]))
    await rm(ticket)
    await (await pending)?.()
    expect(reports.map((r) => r.kind)).toEqual(['wait-start', 'wait-end', 'finished'])
  },
)

test('report limits preserve incomplete coverage rather than fabricating the last interval', async () => {
  const { reports, reporter } = capture()
  for (let index = 0; index < 40; index++) {
    reporter.contention(true, index * 2)
    reporter.contention(false, index * 2 + 1)
  }
  await reporter.finish()
  expect(reports).toHaveLength(63)
  expect(reports.at(-1)).toMatchObject({ sequence: 62, kind: 'wait-start' })
})

test('an absent or unavailable existing daemon does not create reporting authority', async () => {
  const env = { TED_HOME: dir, TED_TASK: 'NB-1', TED_RUN: 'run', TED_RUN_CAPABILITY: 'run-token' }
  expect(await runnerReporter('Vitest', env)).toBeUndefined()
  server = createServer((_req, res) => {
    res.writeHead(503)
    res.end()
  })
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing address')
  await writeFile(
    path.join(dir, 'daemon.json'),
    JSON.stringify({ port: address.port, token: 'not-authority', pid: process.pid, version: '1' }),
  )
  expect(await runnerReporter('Vitest', env)).toBeUndefined()
})

test.each([
  ['pnpm check', true],
  ['pnpm check --all', true],
  ['pnpm vitest run a.test.ts', true],
  ['pnpm exec vitest run a.test.ts', true],
  ['pnpm exec check', false],
  ['pnpm vitest run a.test.ts && pnpm vitest run b.test.ts', false],
  ['pnpm vitest run a.test.ts & pnpm vitest run b.test.ts & wait', false],
  ['pnpm vitest run a.test.ts; pnpm vitest run b.test.ts', false],
  ['pnpm vitest run a.test.ts\npnpm vitest run b.test.ts', false],
  ['pnpm vitest run $(other-command)', false],
  ['pnpm vitest run *.test.ts', false],
  ['pnpm test', false],
])('Check reporting support is explicit for %s', (command, supported) => {
  expect(supportsTestReporting(command)).toBe(supported)
})

const reporterUrl = pathToFileURL(
  path.resolve(import.meta.dirname, '../../../scripts/test-reporting.ts'),
).href
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

test.each(['sequential', 'concurrent'])(
  'a %s compound Check declares unsupported coverage for both children',
  async (mode) => {
    const fixture = path.join(dir, 'check-child.ts')
    await writeFile(
      fixture,
      `
    import { runnerReporter } from ${JSON.stringify(reporterUrl)}
    const reporter = await runnerReporter('Vitest')
    if (reporter) {
      reporter.contention(true, Date.now())
      reporter.contention(false, Date.now())
      await reporter.finish()
      console.log('reported')
    } else console.log('unsupported')
  `,
    )
    const child = [process.execPath, fixture].map(shellQuote).join(' ')
    const command = mode === 'sequential' ? `${child} && ${child}` : `${child} & ${child} & wait`
    const registrations: { position: number; supported: boolean }[] = []
    const result = await runChecks({
      checks: [{ check: { name: 'compound', command, timeout: '1m', state: 'waiting' }, cwd: dir }],
      taskDisplayId: 'NB-1',
      libraryDir: dir,
      env: { ...process.env, TED_RUN_CAPABILITY: 'ordinary-run-token', TED_APP_TOKEN: 'app-key' },
      logFor: () => path.join(dir, 'compound.log'),
      prepareLaunch: async () => ({ release: () => {} }),
      lowPriority: false,
      onStart: () => {},
      onFinish: () => {},
      reportingEnv: async (position, supported) => {
        registrations.push({ position, supported })
        return supported ? { TED_HOME: dir, TED_RUN_CAPABILITY: 'test-report:unexpected' } : {}
      },
    })
    expect(result.outcome).toBe('passed')
    expect(registrations).toEqual([{ position: 0, supported: false }])
    expect((await readFile(path.join(dir, 'compound.log'), 'utf8')).trim().split('\n')).toEqual([
      'unsupported',
      'unsupported',
    ])
  },
)

async function isolatedModules(source: string): Promise<unknown> {
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    cwd: dir,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  let errors = ''
  child.stdout.on('data', (chunk) => {
    output += chunk
  })
  child.stderr.on('data', (chunk) => {
    errors += chunk
  })
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', resolve)
  })
  if (code !== 0) throw new Error(`isolated module fixture failed (${code}): ${errors}`)
  return JSON.parse(output)
}

const moduleImports = `
  const first = await import(${JSON.stringify(`${reporterUrl}?first`)})
  const second = await import(${JSON.stringify(`${reporterUrl}?second`)})
  if (first.withProjectTestLock === second.withProjectTestLock) throw new Error('modules were not evaluated independently')
`

test('independent module evaluations share one acquisition and retain it through the final teardown', async () => {
  const result = await isolatedModules(`
    ${moduleImports}
    let acquired = 0
    let released = 0
    const acquire = async () => { acquired++; return async () => { released++ } }
    const setup = async () => async () => {}
    const [one, two] = await Promise.all([
      first.withProjectTestLock(acquire, setup), second.withProjectTestLock(acquire, setup),
    ])
    await one()
    const afterFirst = { acquired, released }
    await two()
    await two()
    console.log(JSON.stringify({ afterFirst, final: { acquired, released } }))
  `)
  expect(result).toEqual({
    afterFirst: { acquired: 1, released: 0 },
    final: { acquired: 1, released: 1 },
  })
})

test('separate project loaders release references after setup, cleanup and acquisition failures', async () => {
  const result = await isolatedModules(`
    ${moduleImports}
    let acquired = 0
    let released = 0
    const acquire = async () => { acquired++; return async () => { released++ } }
    const setup = async () => async () => {}
    const one = await first.withProjectTestLock(acquire, setup)
    let setupError
    try { await second.withProjectTestLock(acquire, async () => { throw new Error('setup') }) }
    catch (error) { setupError = error.message }
    const afterFailure = { acquired, released }
    await one()
    const cleanup = await second.withProjectTestLock(acquire, async () => async () => { throw new Error('cleanup') })
    let cleanupError
    try { await cleanup() } catch (error) { cleanupError = error.message }
    let acquisitionError
    try { await first.withProjectTestLock(async () => { throw new Error('acquire') }, setup) }
    catch (error) { acquisitionError = error.message }
    const recovered = await second.withProjectTestLock(acquire, setup)
    await recovered()
    console.log(JSON.stringify({ setupError, cleanupError, acquisitionError, afterFailure, final: { acquired, released } }))
  `)
  expect(result).toEqual({
    setupError: 'setup',
    cleanupError: 'cleanup',
    acquisitionError: 'acquire',
    afterFailure: { acquired: 1, released: 0 },
    final: { acquired: 3, released: 3 },
  })
})

test('live pulses refresh running and waiting without consuming historical report slots', async () => {
  vi.useFakeTimers()
  try {
    const { reports, updates, reporter } = capture()
    reporter.contention(true, Date.now())
    await vi.advanceTimersByTimeAsync(10_000)
    expect(updates.filter((r) => r.kind === 'waiting')).toHaveLength(2)
    expect(reports.map((r) => r.kind)).toEqual(['wait-start'])
    reporter.contention(false, Date.now())
    await reporter.running()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(updates.filter((r) => r.kind === 'running')).toMatchObject([
      { sequence: 2 },
      { sequence: 2 },
    ])
    await reporter.finish()
    const count = updates.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(updates).toHaveLength(count)
    expect(reports.map((r) => r.kind)).toEqual(['wait-start', 'wait-end', 'finished'])
  } finally {
    vi.useRealTimers()
  }
})

test('a daemon without live reporting support still receives the historical wait measurements', async () => {
  const history: TestInvocationReport[] = []
  const reporter = testReporter(async (report) => {
    if (report.kind === 'running' || report.kind === 'waiting' || report.kind === 'inactive')
      return false
    history.push(report)
    return true
  })
  reporter.contention(true, 100)
  reporter.contention(false, 200)
  await reporter.running()
  await reporter.finish()
  expect(history.map((r) => r.kind)).toEqual(['wait-start', 'wait-end', 'finished'])
})
