import { once } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import type { Post } from '@ted/daemon/sentry'
import { crashFrom } from '@ted/protocol'
import { type Json, parseJson } from '@ted/protocol/parse'
import { describe, expect, test } from 'vitest'
import {
  type CrashReporterOptions,
  cleanCrash,
  cleanText,
  crashesPerHour,
  crashReporter,
  maxCrashMessage,
} from '../src/crash-report.ts'
import { daemonAsApp, makeTempHome, spawnDaemonProcess, stopDaemonIn } from './helpers.ts'

const roots = ['/repo']
const home = '/Users/bob'
const token = `ghp_${'a1'.repeat(18)}`

describe('cleaning', () => {
  test('keeps Ted’s own paths relative and replaces every other path', () => {
    const stack = [
      'Error: boom',
      '    at run (/repo/packages/daemon/src/tasks/queue.ts:120:5)',
      '    at /Users/bob/My Repos/secret-project/build.js:1:2',
      '    at load (file:///repo/packages/app/dist/renderer/assets/index-abc.js:3:4)',
      '    at file:///opt/other/lib.js:9:9',
      '    at node:internal/process/task_queues:95:5',
    ].join('\n')
    const cleaned = cleanText(stack, roots, home)
    expect(cleaned).toContain('at run (packages/daemon/src/tasks/queue.ts:120:5)')
    expect(cleaned).toContain('at load (packages/app/dist/renderer/assets/index-abc.js:3:4)')
    expect(cleaned).toContain('at node:internal/process/task_queues:95:5')
    expect(cleaned).not.toMatch(/Users|bob|secret-project|My Repos|opt\/other/)
  })

  test('replaces paths in messages, Windows paths and tokens', () => {
    expect(cleanText("ENOENT: no such file, open '/Users/bob/a b/notes.md'", roots, home)).toBe(
      "ENOENT: no such file, open '<path>'",
    )
    expect(cleanText(`failed in /var/folders/x/tmp.txt with ${token}`, roots, home)).toBe(
      'failed in <path> with [redacted]',
    )
    expect(cleanText('copy C:\\Users\\bob\\repo\\a.ts failed', roots, home)).toBe(
      'copy <path> failed',
    )
    expect(cleanText('git clone https://user:pw@example.com/acme/app', roots, home)).not.toMatch(
      /pw|acme/,
    )
    expect(cleanText('/Volumes/My Drive/secret repo/a.ts failed', roots, home)).toBe(
      '<path> failed',
    )
    expect(cleanText('/a/My Secret Name/b.ts', roots, home)).toBe('<path>')
    expect(cleanText('cannot read src/secret/notes.md here', roots, home)).toBe(
      'cannot read <path> here',
    )
    expect(cleanText('copy <x> from C:\\a\\b to D:\\c', roots, home)).toBe('copy <x> from <path>')
    expect(cleanText(`Unexpected token 'a', "secret con"... is not valid JSON`, roots, home)).toBe(
      `Unexpected token '<text>'`,
    )
    expect(cleanText("open '/Volumes/Private Drive/confidential plan.txt'", roots, home)).toBe(
      "open '<path>'",
    )
    expect(cleanText('cannot parse `API_KEY=abc and the rest`', roots, home)).toBe(
      'cannot parse `<text>`',
    )
    expect(cleanText("Ted can't start", roots, home)).toBe("Ted can't start")
    expect(cleanText("open '/Volumes/Bob's Drive/confidential plan.txt'", roots, home)).toBe(
      "open '<path>'",
    )
    expect(cleanText("open '/Users/bob/Bob's Drive/plan.txt' failed", roots, home)).toBe(
      "open '<path>'",
    )
    expect(cleanText('read "unclosed secret text', roots, home)).toBe('read "<text>"')
    expect(cleanText(`x ' a "b's secret"`, roots, home)).toBe(`x '<text>'`)
    expect(cleanText(`read "a client's secret`, roots, home)).toBe('read "<text>"')
    expect(cleanText(`read "the clients' secret`, roots, home)).toBe('read "<text>"')
    expect(cleanText('a "b `c" secret` d', roots, home)).toBe('a "<text>"')
    expect(cleanText(`"a" b 'secret`, roots, home)).toBe('"<text>"')
    expect(cleanText(`a "one 'two" and 'three "four' end`, roots, home)).toBe(`a "<text>"`)
    expect(cleanText('input"confidential contents" and x`secret snippet`', roots, home)).toBe(
      'input"<text>"',
    )
    expect(cleanText('at packages/daemon/src/a.ts:3:1 failed', roots, home)).toBe(
      'at packages/daemon/src/a.ts:3:1 failed',
    )
  })

  test('cleans long runs of slashes and brackets without stalling', () => {
    const clean = cleanCrash(
      {
        source: 'uncaught',
        type: 'Error',
        message: `${'/'.repeat(50_000)} ${'a/'.repeat(20_000)}`,
        stack: `Error\n    at f${' ('.repeat(20_000)}x${':1'.repeat(20_000)})`,
      },
      [`/repo${'/'.repeat(50_000)}`],
      home,
    )
    expect(clean.message).toBe('<path>')
    expect(clean.frames).toHaveLength(1)
  })

  test('cleans long runs of separators, words and quotes in one pass', () => {
    const many = 100_000
    expect(cleanText('='.repeat(many), roots, home)).toBe('='.repeat(many))
    expect(cleanText(':'.repeat(many), roots, home)).toBe(':'.repeat(many))
    expect(cleanText('a:'.repeat(many / 2), roots, home)).toBe('a:'.repeat(many / 2))
    expect(cleanText(`/a ${'x '.repeat(many / 2)}`, roots, home)).toBe(
      `<path> ${'x '.repeat(many / 2)}`,
    )
    expect(cleanText(`${home}/a ${'x '.repeat(many / 2)}`, roots, home)).toBe('<path>')
    expect(cleanText(`"${'a'.repeat(many)}`, roots, home)).toBe('"<text>"')
  })

  test('a word with a slash after a bracket is removed too', () => {
    expect(cleanText('(x)foo/secret and <b>bar\\secret', roots, home)).toBe(
      '(x)<path> and <b><path>',
    )
  })

  test('cuts the message and reads frames oldest last', () => {
    const clean = cleanCrash(
      {
        source: 'uncaught',
        type: 'Error',
        message: 'x'.repeat(maxCrashMessage + 20),
        stack:
          'Error: x\n    at run (/repo/packages/daemon/src/a.ts:1:2)\n    at /elsewhere/b.js:3:4',
      },
      roots,
      home,
    )
    expect([...clean.message]).toHaveLength(maxCrashMessage)
    expect(clean.frames).toEqual([
      { function: 'run', filename: 'packages/daemon/src/a.ts', lineno: 1, colno: 2, in_app: true },
      { filename: '<path>', in_app: false },
    ])
  })
})

interface Sent {
  url: string
  init: RequestInit
}

function harness(overrides: Partial<CrashReporterOptions> = {}) {
  const sent: Sent[] = []
  let enabled = true
  let now = new Date('2026-11-16T12:00:00Z')
  const post: Post = async (url, init) => {
    sent.push({ url, init })
    return { ok: true, status: 200 }
  }
  const report = crashReporter({
    part: 'daemon',
    dsn: 'https://abc123@o1.ingest.us.sentry.io/42',
    allowLoopbackHttp: false,
    version: '0.1.26',
    edition: 'release',
    enabled: () => enabled,
    post,
    codeRoots: roots,
    home,
    now: () => now,
    ...overrides,
  })
  return {
    sent,
    report,
    turn: (on: boolean) => {
      enabled = on
    },
    later: (ms: number) => {
      now = new Date(now.getTime() + ms)
    },
  }
}

function envelope(init: RequestInit): (Json | undefined)[] {
  if (!(init.body instanceof Uint8Array)) throw new Error('expected a byte body')
  return new TextDecoder()
    .decode(init.body)
    .trim()
    .split('\n')
    .map((line) => parseJson(line))
}

describe('crashReporter', () => {
  test('sends one clean Sentry event while reports are on', async () => {
    const { sent, report } = harness()
    await report({
      source: 'uncaught',
      type: 'TypeError',
      message: `${token} failed to read /Users/bob/acme/prompt.md`,
      stack: 'TypeError: bad\n    at run (/repo/packages/daemon/src/a.ts:1:2)',
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]?.url).toBe('https://o1.ingest.us.sentry.io/api/42/envelope/')
    expect(sent[0]?.init.headers).toMatchObject({
      'X-Sentry-Auth': expect.stringContaining('sentry_key=abc123'),
    })
    const [head, item, event] = envelope(sent[0]?.init ?? {})
    expect(head).toMatchObject({ dsn: 'https://abc123@o1.ingest.us.sentry.io/42' })
    expect(item).toEqual({ type: 'event' })
    expect(event).toMatchObject({
      platform: 'node',
      environment: 'release',
      release: '0.1.26',
      tags: { part: 'daemon' },
      exception: {
        values: [
          {
            type: 'TypeError',
            value: '[redacted] failed to read <path>',
            mechanism: { type: 'uncaught', handled: false },
            stacktrace: { frames: [{ function: 'run', filename: 'packages/daemon/src/a.ts' }] },
          },
        ],
      },
    })
    expect(event).not.toHaveProperty('server_name')
    expect(event).not.toHaveProperty('user')
    expect(JSON.stringify(event)).not.toMatch(/bob|acme|ghp_/)
  })

  test('a thrown value that isn’t an Error is sent without its content', async () => {
    const { sent, report } = harness()
    await report(crashFrom('rejection', 'Summarize the secret plan in the repo'))
    const [, , event] = envelope(sent[0]?.init ?? {})
    expect(event).toMatchObject({
      exception: { values: [{ type: 'NonError', value: '<text>' }] },
    })
    expect(JSON.stringify(event)).not.toContain('secret')
  })

  test('sends nothing while reports are off, and follows the setting at once', async () => {
    const { sent, report, turn } = harness()
    turn(false)
    await report({ source: 'uncaught', type: 'Error', message: 'boom' })
    expect(sent).toHaveLength(0)
    turn(true)
    await report({ source: 'uncaught', type: 'Error', message: 'boom' })
    expect(sent).toHaveLength(1)
    turn(false)
    await report({ source: 'uncaught', type: 'Error', message: 'another' })
    expect(sent).toHaveLength(1)
  })

  test('sends the same error once and at most ten an hour', async () => {
    const { sent, report, later } = harness()
    await report({ source: 'uncaught', type: 'Error', message: 'same' })
    await report({ source: 'uncaught', type: 'Error', message: 'same' })
    expect(sent).toHaveLength(1)
    for (let i = 0; i < crashesPerHour + 3; i++) {
      await report({ source: 'uncaught', type: 'Error', message: `error ${i}` })
    }
    expect(sent).toHaveLength(crashesPerHour)
    later(60 * 60_000)
    await report({ source: 'uncaught', type: 'Error', message: 'next hour' })
    expect(sent).toHaveLength(crashesPerHour + 1)
  })

  test('drops a report that fails to send and never throws', async () => {
    const { report } = harness({
      post: async () => {
        throw new Error('offline')
      },
    })
    await expect(report({ source: 'uncaught', type: 'Error', message: 'x' })).resolves.toBe(
      undefined,
    )
  })

  test('sends nothing to a plain HTTP address unless loopback tests allow it', async () => {
    const { sent, report } = harness({ dsn: 'http://abc123@127.0.0.1:9/42' })
    await report({ source: 'uncaught', type: 'Error', message: 'x' })
    expect(sent).toHaveLength(0)
  })
})

async function sentryStub() {
  const envelopes: string[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/api/7/envelope/') {
        envelopes.push(Buffer.concat(chunks).toString('utf8'))
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { envelopes, server, dsn: `http://public@127.0.0.1:${port}/7` }
}

describe('the daemon process', () => {
  test('reports its own uncaught error and exits only while reports are on', async () => {
    const { home, cleanup } = await makeTempHome()
    const sentry = await sentryStub()
    const env = { ...process.env, TED_HOME: home, TED_SENTRY_DSN: sentry.dsn }
    const crash = async () => {
      const child = spawnDaemonProcess([], { ...env, TED_FORCE_ERROR: 'daemon' })
      const [code] = await once(child, 'exit')
      return code
    }
    try {
      await (await daemonAsApp(home, env)).updateSettings({ reporting: true })
      await stopDaemonIn(home)
      expect(await crash()).toBe(1)
      expect(sentry.envelopes).toHaveLength(1)
      const [, item, event] = (sentry.envelopes[0] ?? '').split('\n')
      expect(item).toBe('{"type":"event"}')
      expect(parseJson(event ?? '')).toMatchObject({
        environment: 'dev',
        tags: { part: 'daemon' },
        exception: {
          values: [
            { type: 'Error', value: 'Forced error in the daemon (TED_FORCE_ERROR) in <path>' },
          ],
        },
      })
      expect(sentry.envelopes[0]).not.toContain(home)
      expect(sentry.envelopes[0]).not.toContain(os.homedir())

      await (await daemonAsApp(home, env)).updateSettings({ reporting: false })
      await stopDaemonIn(home)
      expect(await crash()).toBe(1)
      expect(sentry.envelopes).toHaveLength(1)
    } finally {
      await stopDaemonIn(home)
      sentry.server.close()
      await cleanup()
    }
  }, 90_000)
})
