import { once } from 'node:events'
import { createServer } from 'node:http'
import { type BrowserRequest, DaemonClient } from '@ted/protocol'
import { expect, test } from 'vitest'
import { runCli } from '../src/cli.ts'

test('browser commands keep their requests after command-table dispatch', async () => {
  const requests: { url: string; body?: unknown }[] = []
  const server = createServer(async (req, res) => {
    let text = ''
    for await (const chunk of req) text += chunk
    requests.push({ url: req.url ?? '', ...(text && { body: JSON.parse(text) }) })
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(req.method === 'GET' ? [] : { text: 'Done' }))
  })
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('no port')
    const client = new DaemonClient({
      port: address.port,
      token: 'test-token',
      pid: process.pid,
      version: 'test',
    })
    const cases: { args: string[]; request: BrowserRequest }[] = [
      {
        args: ['open', 'Web', '--repo', 'ted'],
        request: { action: 'open', app: { name: 'Web', repo: 'ted' } },
      },
      { args: ['snapshot'], request: { action: 'snapshot' } },
      { args: ['click', 'e1'], request: { action: 'click', ref: 'e1' } },
      { args: ['fill', 'e2', 'Typed'], request: { action: 'fill', ref: 'e2', value: 'Typed' } },
      { args: ['fill', 'e2'], request: { action: 'fill', ref: 'e2', value: 'From stdin' } },
      { args: ['press', 'Enter'], request: { action: 'press', value: 'Enter' } },
      { args: ['navigate', '/next'], request: { action: 'navigate', value: '/next' } },
      { args: ['back'], request: { action: 'back' } },
      { args: ['forward'], request: { action: 'forward' } },
      { args: ['reload'], request: { action: 'reload' } },
      { args: ['screenshot'], request: { action: 'screenshot' } },
    ]
    let output = ''
    for (const entry of cases) {
      expect(
        await runCli(['browser', ...entry.args], {
          env: { TED_TASK: 'NB-1' },
          stdin: async () => 'From stdin',
          stdout: (text) => {
            output += text
          },
          stderr: (text) => {
            throw new Error(text)
          },
          connect: async <T>(_home: string, call: (client: DaemonClient) => Promise<T>) =>
            call(client),
        }),
      ).toBe(0)
    }
    expect(requests).toEqual(
      cases.flatMap(({ request }) => [
        { url: '/tasks/NB-1/apps' },
        { url: '/tasks/NB-1/browser', body: request },
      ]),
    )
    expect(output).toBe('Done\n'.repeat(cases.length))

    requests.length = 0
    const runCases: { args: string[]; request: BrowserRequest }[] = [
      { args: ['snapshot'], request: { action: 'snapshot' } },
      { args: ['resize', '390x844'], request: { action: 'resize', value: '390x844' } },
      { args: ['color-scheme', 'dark'], request: { action: 'color-scheme', value: 'dark' } },
    ]
    for (const entry of runCases) {
      expect(
        await runCli(['browser', ...entry.args], {
          env: { TED_RUN: 'run-1', TED_AUTOMATION: 'Audit' },
          stdout: () => {},
          stderr: (text) => {
            throw new Error(text)
          },
          connect: async <T>(_home: string, call: (client: DaemonClient) => Promise<T>) =>
            call(client),
        }),
      ).toBe(0)
    }
    expect(requests).toEqual(
      runCases.flatMap(({ request }) => [
        { url: '/runs/run-1/apps' },
        { url: '/runs/run-1/browser', body: request },
      ]),
    )
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})

test.each([
  ['open'],
  ['click'],
  ['fill'],
  ['press'],
  ['navigate'],
  ['snapshot', 'extra'],
  ['reload', '--repo', 'ted'],
  ['made-up'],
  ['resize', '390x844'],
  ['resize', '100x100'],
  ['color-scheme', 'sepia'],
])('invalid browser invocation %j does no IO', async (...args) => {
  expect(
    await runCli(['browser', ...args], {
      env: { TED_TASK: 'NB-1' },
      stdout: () => {},
      stderr: () => {},
      stdin: async () => {
        throw new Error('must not read stdin')
      },
      connect: async () => {
        throw new Error('must not connect')
      },
    }),
  ).toBe(2)
})
