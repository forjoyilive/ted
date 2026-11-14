import { chmod, link, mkdir, readdir, readFile, rm, symlink } from 'node:fs/promises'
import http from 'node:http'
import { connect as connectSocket, type Socket } from 'node:net'
import path from 'node:path'
import { type DaemonClient, identity, readDaemonInfo, tedEnv, tedPaths } from '@ted/protocol'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { AsanaReadError, createAsana } from '../src/asana/asana.ts'
import { type DaemonOptions, type RunningDaemon, startDaemon } from '../src/daemon.ts'
import { type Keyring, keyringService, linearKeyAccount } from '../src/linear/keyring.ts'
import { loadRunTokens } from '../src/run-token.ts'
import { startStubAsana, unusedPort } from './fixtures/stub-asana.ts'
import {
  api,
  appClient,
  hostRecords,
  killRunHosts,
  makeTempHome,
  rawRequest,
  stubClaudePath,
  waitUntil,
} from './helpers.ts'
import { ManualClock } from './support/manual-clock.ts'

const config = { clientId: '123', clientSecret: 'security-client-secret', inFile: false }
let home: string
let cleanup: () => Promise<void>
let stub: Awaited<ReturnType<typeof startStubAsana>>
let daemon: RunningDaemon | undefined
let clock: number
let secret: string | undefined
let callbackPort: number
const keyring: Keyring = {
  kind: 'macos-keychain',
  async get() {
    return secret
  },
  async set(value) {
    secret = value
  },
  async delete() {
    secret = undefined
  },
}
beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  stub = await startStubAsana()
  clock = Date.now()
  callbackPort = await unusedPort()
  secret = undefined
})
afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await stub.close()
  await killRunHosts(home, { waitForStart: true })
  await cleanup()
  vi.restoreAllMocks()
})
async function start(options: Pick<DaemonOptions, 'clock' | 'idleExit'> = {}) {
  daemon = await startDaemon({
    ...options,
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    asana: { keyring, callbackPort, oauthOrigin: stub.url, apiOrigin: stub.url, now: () => clock },
  })
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('No info')
  return { client: appClient(info, daemon.appToken), info }
}
const authorizationCode = 'authorization-code-opaque'
async function connect(client: DaemonClient) {
  const { url } = await client.connectAsana()
  const callback = stub.callback(url, authorizationCode)
  return { url, callback }
}
async function connected(client: DaemonClient) {
  await waitUntil(async () => (await client.getAsana()).state === 'connected', 'connected')
}

test('callbacks reject wrong state, duplicates, host, path, expired attempts and replay; denial closes the listener', async () => {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
  let slow: Socket | undefined
  const sendCallback = (url: string) =>
    new Promise<{ status: number; connection: string | undefined }>((resolve, reject) => {
      const req = http.get(url, { agent }, (response) => {
        response.resume()
        response.once('end', () =>
          resolve({ status: response.statusCode ?? 0, connection: response.headers.connection }),
        )
      })
      req.once('error', reject)
    })
  try {
    const { client } = await start()
    await client.configureAsana(config)
    let attempt = await connect(client)
    for (const change of [
      (u: URL) => u.searchParams.set('state', 'wrong'),
      (u: URL) => u.searchParams.append('state', 'duplicate'),
      (u: URL) => u.searchParams.append('code', 'duplicate'),
      (u: URL) => {
        u.pathname = '/wrong'
      },
      (u: URL) => u.searchParams.set('error', 'access_denied'),
    ]) {
      const bad = new URL(attempt.callback)
      change(bad)
      expect((await fetch(bad)).status).toBe(400)
    }
    expect(
      (
        await rawRequest(callbackPort, {
          path: new URL(attempt.callback).pathname + new URL(attempt.callback).search,
          headers: { host: 'attacker.test' },
        })
      ).status,
    ).toBe(400)
    expect(
      (
        await rawRequest(callbackPort, {
          path: 'http://[',
          headers: { host: `127.0.0.1:${callbackPort}` },
        })
      ).status,
    ).toBe(400)
    expect(stub.requests).toHaveLength(0)
    slow = connectSocket(callbackPort, '127.0.0.1')
    slow.on('error', () => undefined)
    await new Promise<void>((resolve) => slow?.once('connect', resolve))
    slow.write('GET /asana/callback HTTP/1.1\r\nHost:')
    expect(await sendCallback(attempt.callback)).toMatchObject({ status: 200, connection: 'close' })
    await connected(client)
    await waitUntil(() => slow?.destroyed, 'settlement closes the slow callback socket')
    await expect(fetch(attempt.callback)).rejects.toThrow()
    expect(stub.requests.filter((r) => r.path === '/-/oauth_token')).toHaveLength(1)
    attempt = await connect(client)
    expect(await sendCallback(attempt.callback)).toMatchObject({ status: 200, connection: 'close' })
    await connected(client)
    expect(stub.requests.filter((r) => r.path === '/-/oauth_token')).toHaveLength(2)
    attempt = await connect(client)
    const denied = new URL(attempt.callback)
    denied.searchParams.delete('code')
    denied.searchParams.set('error', 'access_denied')
    expect((await fetch(denied)).status).toBe(200)
    expect(await client.getAsana()).toMatchObject({
      state: 'error',
      error: expect.stringContaining('denied'),
    })
    await expect(fetch(attempt.callback)).rejects.toThrow()
    attempt = await connect(client)
    clock += 5 * 60_000
    expect((await fetch(attempt.callback)).status).toBe(400)
    expect(await client.getAsana()).not.toHaveProperty('user')
    await client.cancelAsana()
    await expect(fetch(attempt.callback)).rejects.toThrow()
  } finally {
    slow?.destroy()
    agent.destroy()
  }
})

test('cancel and disconnect invalidate a token response already in flight; shutdown releases the port', async () => {
  const { client } = await start()
  await client.configureAsana(config)
  const { callback } = await connect(client)
  let release: () => void = () => undefined
  stub.hold(
    new Promise<void>((resolve) => {
      release = resolve
    }),
  )
  await fetch(callback)
  await waitUntil(() => stub.requests.some((r) => r.path === '/-/oauth_token'), 'pending exchange')
  const cancel = client.cancelAsana()
  await waitUntil(
    async () => (await readFile(path.join(home, 'daemon.json'), 'utf8')).length > 0,
    'daemon remains available',
  )
  release()
  stub.hold(undefined)
  await cancel
  expect(await client.getAsana()).not.toHaveProperty('user')
  expect(secret).not.toContain('refresh-secret-opaque')
  await client.connectAsana()
  await daemon?.stop()
  daemon = undefined
  const listener = http.createServer()
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(callbackPort, '127.0.0.1', resolve)
  })
  await new Promise<void>((resolve) => listener.close(() => resolve()))
})

test('app authority only, no endpoint redirects, and credentials stay out of API, events, logs, reports and Run folders', async () => {
  const logs: unknown[][] = []
  vi.spyOn(console, 'error').mockImplementation((...args) => {
    logs.push(args)
  })
  const { client, info } = await start()
  const agent = await client.startDevRun({
    agent: 'claude',
    cwd: home,
    prompt: JSON.stringify({
      steps: [{ say: 'Connection credentials must stay private.' }, { endTurn: true }],
    }),
  })
  await waitUntil(
    async () => (await hostRecords(home, agent.id)).some((entry) => entry.t === 'start'),
    'stub Run host',
  )
  const run = (await loadRunTokens(tedPaths(home).runTokenKey)).issue(agent.id)
  for (const token of [info.token, run]) {
    const caller = api(info.port, token)
    for (const [method, route, body] of [
      ['PUT', '/configuration', config],
      ['POST', '/connect', undefined],
      ['POST', '/cancel', undefined],
      ['POST', '/test', undefined],
      ['POST', '/disconnect', undefined],
      ['DELETE', '/configuration', undefined],
    ] as const)
      expect((await caller.call(method, `/integrations/asana${route}`, body)).status).toBe(403)
    expect((await caller.call('POST', '/tasks/NB-1/asana-sync')).status).toBe(403)
  }
  expect((await api(info.port, run).call('GET', '/integrations/asana')).status).toBe(403)
  await client.configureAsana(config)
  const attempt = await connect(client)
  await fetch(attempt.callback)
  await connected(client)
  stub.setRedirect(true)
  expect(await client.testAsana()).toMatchObject({ state: 'error' })
  expect(stub.requests.some((r) => r.path === '/leak')).toBe(false)
  const evidence = [
    JSON.stringify(await client.getRun(agent.id)),
    JSON.stringify(await client.getAsana()),
    (await client.getReport()).text,
    JSON.stringify(await client.getSlowMoments()),
    JSON.stringify(logs),
  ]
  const files = await readdir(home, { recursive: true, withFileTypes: true })
  for (const entry of files)
    if (entry.isFile())
      evidence.push(await readFile(path.join(entry.parentPath, entry.name), 'utf8'))
  for (const text of evidence)
    for (const value of [
      config.clientSecret,
      'access-secret-opaque',
      'refresh-secret-opaque',
      authorizationCode,
    ])
      expect(text).not.toContain(value)
})

test('fallback rejects symlink folders and public files; production ignores test endpoints and uses a separate credential account', async () => {
  const { client } = await start()
  const dir = path.join(home, 'asana-credentials')
  const elsewhere = path.join(home, 'elsewhere')
  await mkdir(elsewhere, { mode: 0o700 })
  await symlink(elsewhere, dir)
  await expect(client.configureAsana({ ...config, inFile: true })).rejects.toThrow()
  expect(await readdir(elsewhere)).toEqual([])
  expect(tedEnv('TED_ASANA_API', { TED_ASANA_API: stub.url }, 'release')).toBeUndefined()
  expect(
    tedEnv('TED_ASANA_CALLBACK_PORT', { TED_ASANA_CALLBACK_PORT: '1' }, 'release'),
  ).toBeUndefined()
  expect(keyringService).toBe(identity('dev').keyringService)
  expect(identity('dev').keyringService).not.toBe(identity('release').keyringService)
  expect(linearKeyAccount).toBe('linear-api-key')
  await rm(dir)
  await client.configureAsana({ ...config, inFile: true })
  const file = path.join(dir, 'oauth.json')
  await chmod(file, 0o644)
  expect(await client.getAsana()).toMatchObject({ state: 'error', configured: false })
  await chmod(file, 0o600)
  await link(file, path.join(dir, 'copy'))
  expect(await client.getAsana()).toMatchObject({ state: 'error', configured: false })
})

test('authorization holds idle shutdown through browser waiting and exchange, and releases on settlement', async () => {
  const time = new ManualClock()
  const onIdle = vi.fn()
  async function idleAfterCleanup(count: number) {
    await waitUntil(() => time.pending.includes(100), 'idle countdown after asynchronous cleanup')
    time.advance(100)
    expect(onIdle).toHaveBeenCalledTimes(count)
  }
  const { client } = await start({ clock: time, idleExit: { afterMs: 100, onIdle } })
  await client.configureAsana(config)
  const attempt = await connect(client)
  time.advance(1000)
  expect(onIdle).not.toHaveBeenCalled()
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  stub.hold(gate)
  try {
    await fetch(attempt.callback)
    await waitUntil(() => stub.requests.some((r) => r.path === '/-/oauth_token'), 'exchange held')
    time.advance(1000)
    expect(onIdle).not.toHaveBeenCalled()
  } finally {
    release()
    stub.hold(undefined)
  }
  await connected(client)
  await idleAfterCleanup(1)
  await client.connectAsana()
  time.advance(1000)
  expect(onIdle).toHaveBeenCalledTimes(1)
  await client.cancelAsana()
  await idleAfterCleanup(2)
  const denied = new URL((await connect(client)).callback)
  denied.searchParams.delete('code')
  denied.searchParams.set('error', 'access_denied')
  await fetch(denied)
  await client.getAsana()
  await idleAfterCleanup(3)
  const occupied = http.createServer()
  await new Promise<void>((resolve) => occupied.listen(callbackPort, '127.0.0.1', resolve))
  try {
    await expect(client.connectAsana()).rejects.toThrow('port is busy')
  } finally {
    await new Promise<void>((resolve) => occupied.close(() => resolve()))
  }
  await idleAfterCleanup(4)
  await client.connectAsana()
  time.advance(5 * 60_000)
  await idleAfterCleanup(5)
  await client.connectAsana()
  await client.configureAsana(config)
  await idleAfterCleanup(6)
  await client.connectAsana()
  await daemon?.stop()
  daemon = undefined
  time.advance(1000)
  expect(onIdle).toHaveBeenCalledTimes(6)
})

test('Asana writes go only to fixed task paths as JSON, refuse redirects, honour Retry-After and send nothing without a connection', async () => {
  const asana = createAsana({
    home,
    keyring,
    oauthOrigin: stub.url,
    apiOrigin: stub.url,
    callbackPort,
    now: () => clock,
  })
  try {
    await asana.configure(config)
    const { url } = await asana.connect()
    await fetch(stub.callback(url, authorizationCode))
    await waitUntil(async () => (await asana.status()).state === 'connected', 'connected')
    stub.setTasks([{ gid: '501', name: 'Checkout' }])
    expect(await asana.account()).toBe('100')
    const text =
      'TED opened a pull request for this task: acme/notes#7 https://github.com/acme/notes/pull/7'
    await asana.comment('501', text, '100')
    await asana.complete('501', '100')
    expect(
      stub.requests
        .filter((r) => r.method !== 'GET' && r.path.startsWith('/api/1.0/tasks/'))
        .map(({ method, path, query, json, authorization }) => ({
          method,
          path,
          query,
          json,
          authorization,
        })),
    ).toEqual([
      {
        method: 'POST',
        path: '/api/1.0/tasks/501/stories',
        query: { opt_fields: 'gid' },
        json: { data: { text } },
        authorization: 'Bearer access-secret-opaque',
      },
      {
        method: 'PUT',
        path: '/api/1.0/tasks/501',
        query: { opt_fields: 'gid' },
        json: { data: { completed: true } },
        authorization: 'Bearer access-secret-opaque',
      },
    ])
    expect(stub.task('501')).toMatchObject({ completed: true, comments: [{ text }] })

    const sent = stub.requests.length
    await expect(asana.comment('501/../../users/me', 'hi', '100')).rejects.toThrow(
      'unexpected task',
    )
    await expect(asana.complete('1e3', '100')).rejects.toThrow('unexpected task')
    await expect(asana.comment('501', 'x'.repeat(2001), '100')).rejects.toThrow('unexpected length')
    await expect(asana.complete('501', '200')).rejects.toThrow('different Asana account')
    expect(stub.requests.length).toBe(sent)

    stub.failNextWrite({ status: 429, retryAfter: '30' })
    await expect(asana.complete('501', '100')).rejects.toMatchObject({ retryAfterMs: 30_000 })
    stub.failNextWrite({ status: 500 })
    await expect(asana.complete('501', '100')).rejects.toMatchObject({ retryAfterMs: undefined })
    stub.setRedirect(true)
    await expect(asana.complete('501', '100')).rejects.toBeInstanceOf(AsanaReadError)
    expect(stub.requests.some((r) => r.path === '/leak')).toBe(false)
    stub.setRedirect(false)

    await asana.disconnect()
    expect(await asana.account()).toBeUndefined()
    const before = stub.requests.length
    await expect(asana.comment('501', 'hi', '100')).rejects.toBeInstanceOf(AsanaReadError)
    expect(stub.requests.length).toBe(before)
  } finally {
    await asana.close()
  }
})
