import { chmod, link, mkdir, readdir, readFile, rm, symlink } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { type DaemonClient, identity, readDaemonInfo, tedEnv, tedPaths } from '@ted/protocol'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/daemon.ts'
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
async function start() {
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    claudeBin: stubClaudePath,
    asana: { keyring, callbackPort, oauthOrigin: stub.url, apiOrigin: stub.url, now: () => clock },
  })
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('No info')
  return { client: appClient(info, daemon.appToken), info }
}
async function connect(client: DaemonClient) {
  const { url } = await client.connectAsana()
  const callback = stub.callback(url)
  return { url, callback }
}
async function connected(client: DaemonClient) {
  await waitUntil(async () => (await client.getAsana()).state === 'connected', 'connected')
}

test('callbacks reject wrong state, duplicates, host, path, expired attempts and replay; denial closes the listener', async () => {
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
  expect((await fetch(attempt.callback)).status).toBe(200)
  await connected(client)
  await expect(fetch(attempt.callback)).rejects.toThrow()
  expect(stub.requests.filter((r) => r.path === '/-/oauth_token')).toHaveLength(1)
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
      new URL(attempt.callback).searchParams.get('code') ?? 'stub-code',
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
