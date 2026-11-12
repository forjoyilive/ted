import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { type DaemonClient, parseAsanaConfiguration, readDaemonInfo } from '@ted/protocol'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { type RunningDaemon, startDaemon } from '../src/daemon.ts'
import { type Keyring, KeyringUnavailableError } from '../src/linear/keyring.ts'
import { startStubAsana, unusedPort } from './fixtures/stub-asana.ts'
import { appClient, makeTempHome, waitUntil } from './helpers.ts'

const configuration = { clientId: '12345', clientSecret: 'client-secret-opaque', inFile: false }
let home: string
let cleanup: () => Promise<void>
let stub: Awaited<ReturnType<typeof startStubAsana>>
let daemon: RunningDaemon | undefined
let callbackPort: number
let clock: number
let secret: string | undefined
let keyringProblem: 'locked' | 'no-keyring' | undefined
const keyring: Keyring = {
  kind: 'macos-keychain',
  async get() {
    if (keyringProblem)
      throw new KeyringUnavailableError(keyringProblem, configuration.clientSecret)
    return secret
  },
  async set(value) {
    if (keyringProblem)
      throw new KeyringUnavailableError(keyringProblem, configuration.clientSecret)
    secret = value
  },
  async delete() {
    if (keyringProblem)
      throw new KeyringUnavailableError(keyringProblem, configuration.clientSecret)
    secret = undefined
  },
}
beforeEach(async () => {
  ;({ home, cleanup } = await makeTempHome())
  stub = await startStubAsana()
  callbackPort = await unusedPort()
  clock = Date.now()
  secret = undefined
  keyringProblem = undefined
})
afterEach(async () => {
  await daemon?.stop()
  daemon = undefined
  await stub.close()
  await cleanup()
})
async function start() {
  daemon = await startDaemon({
    home,
    version: '9.9.9',
    asana: { keyring, oauthOrigin: stub.url, apiOrigin: stub.url, callbackPort, now: () => clock },
  })
  const info = await readDaemonInfo(home)
  if (!info) throw new Error('No daemon info')
  return appClient(info, daemon.appToken)
}
async function authorize(client: DaemonClient) {
  const { url } = await client.connectAsana()
  expect(new URL(url).searchParams.get('code_challenge_method')).toBe('S256')
  expect(url).not.toContain(configuration.clientSecret)
  expect((await fetch(stub.callback(url))).status).toBe(200)
  await waitUntil(async () => (await client.getAsana()).state === 'connected', 'connected account')
  return url
}

test('configuration parser copies every field and rejects malformed input without quoting it', () => {
  expect(parseAsanaConfiguration({ ...configuration, inFile: true, ignored: 'extra' })).toEqual({
    ...configuration,
    inFile: true,
  })
  expect(parseAsanaConfiguration({ clientId: '123', clientSecret: 'secret' })).toEqual({
    clientId: '123',
    clientSecret: 'secret',
    inFile: false,
  })
  for (const value of [
    null,
    [],
    'secret',
    {},
    { ...configuration, clientId: '../' },
    { ...configuration, clientSecret: '' },
    { ...configuration, inFile: 'yes' },
  ])
    expect(() => parseAsanaConfiguration(value)).toThrow()
})

test('authorize, restart, serialize expired-token refresh, handle revocation and disconnect offline', async () => {
  let client = await start()
  expect(await client.getAsana()).toMatchObject({ state: 'unconfigured' })
  expect(await client.configureAsana(configuration)).toMatchObject({
    state: 'disconnected',
    storedIn: 'keyring',
  })
  await authorize(client)
  expect(await client.getAsana()).toMatchObject({
    state: 'connected',
    user: { gid: '100', name: 'Avery' },
  })
  await daemon?.stop()
  daemon = undefined
  client = await start()
  expect(await client.getAsana()).toMatchObject({ state: 'connected' })
  clock += 3_600_000
  const before = stub.requests.filter((r) => r.fields.grant_type === 'refresh_token').length
  expect(await Promise.all([client.testAsana(), client.testAsana(), client.testAsana()])).toEqual(
    expect.arrayContaining([expect.objectContaining({ state: 'connected' })]),
  )
  expect(stub.requests.filter((r) => r.fields.grant_type === 'refresh_token')).toHaveLength(
    before + 1,
  )
  stub.setRevoked(true)
  expect(await client.testAsana()).toMatchObject({ state: 'error', configured: true })
  expect(await client.getAsana()).not.toHaveProperty('user')
  stub.setRevoked(false)
  await authorize(client)
  stub.setOffline(true)
  expect(await client.disconnectAsana()).toMatchObject({
    configured: true,
    error: expect.stringContaining('Disconnected locally'),
  })
  expect(secret).not.toContain('access-secret-opaque')
  expect(secret).not.toContain('refresh-secret-opaque')
  expect(await client.removeAsana()).toMatchObject({ state: 'unconfigured' })
  expect(secret).toBeUndefined()
})

test('replacement clears the old user, cancel stays disconnected and a different identity needs new authorization', async () => {
  const client = await start()
  await client.configureAsana(configuration)
  await authorize(client)
  const pending = await client.connectAsana()
  expect(await client.getAsana()).not.toHaveProperty('user')
  await client.cancelAsana()
  await expect(fetch(stub.callback(pending.url))).rejects.toThrow()
  expect(secret).not.toContain('refresh-secret-opaque')
  stub.setUser({ gid: '200', name: 'Sam', email: 'sam@example.test' })
  await authorize(client)
  expect(await client.getAsana()).toMatchObject({ user: { gid: '200' } })
  stub.setUser({ gid: '300', name: 'Unexpected', email: 'other@example.test' })
  expect(await client.testAsana()).toMatchObject({
    state: 'error',
    error: expect.stringContaining('different account'),
  })
  expect(await client.getAsana()).not.toHaveProperty('user')
})

test('locked storage never silently falls back; unavailable keyrings permit an explicit protected file', async () => {
  const client = await start()
  keyringProblem = 'locked'
  expect(await client.getAsana()).toMatchObject({ storageProblem: 'locked' })
  await expect(client.configureAsana({ ...configuration, inFile: true })).rejects.toThrow()
  keyringProblem = 'no-keyring'
  await expect(client.configureAsana(configuration)).rejects.toThrow()
  expect(await client.configureAsana({ ...configuration, inFile: true })).toMatchObject({
    storedIn: 'file',
  })
  await authorize(client)
  await daemon?.stop()
  daemon = undefined
  const restored = await start()
  expect(await restored.getAsana()).toMatchObject({ state: 'connected', storedIn: 'file' })
  await restored.disconnectAsana()
  expect(await readFile(path.join(home, 'asana-credentials/oauth.json'), 'utf8')).not.toContain(
    'refresh-secret-opaque',
  )
  await restored.removeAsana()
})
